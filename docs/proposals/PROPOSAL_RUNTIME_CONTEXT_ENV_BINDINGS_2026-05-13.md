# Proposal: `RuntimeContext` Env Bindings (Fireline-Pattern Secret Injection)

**Date:** 2026-05-13
**Status:** Proposed (no implementation yet). Blocks production-shaped agent
testing — should land as a quick follow-up after PR #181 merges.
**Author:** OLA (Phase 2 sync run MVP follow-up).

## Problem

`firegrid:run -- <agent command...>` (PR #181) wires the synchronous launch
path end-to-end, but the spawned agent process inherits **no secrets** from
its operator. Today there is no way to pass `ANTHROPIC_API_KEY` (or any other
secret) to a Firegrid-launched agent without one of:

1. Hard-coding it in the agent's source / launch script (insecure, untenable).
2. Stuffing it into `RuntimeContextSchema.runtime.config.argv` (visible in
   process listings, durable in the row, leaks across replays).
3. Adding `env: Record<string, string>` to `RuntimeConfigSchema` and accepting
   that secret values land in the durable control-plane row (violates the
   spirit of "the durable plane records intent, not credentials").

Concretely this **blocks production-shaped testing** of any real agent
(Claude, Gemini, OpenAI, anything that needs an API key) against the Firegrid
substrate. It also blocks the Zed `agent_servers` integration path, where the
operator naturally puts secrets in `agent_servers.<n>.env` and expects them
to reach the agent.

The Phase 2 MVP runbook calls this out explicitly: secrets are accepted only
through env-backed Effect Config at the *host* boundary, not at the
*per-context* boundary.

## Reference: Fireline already solved this

`fireline/src/host_topology/secrets.rs` implements the pattern:

- Topology config carries a `secrets_injection` component with **bindings**:
  `{ name: "ANTHROPIC_API_KEY", ref: "env:PARENT_ANTHROPIC_API_KEY" }`.
- `resolve_spawn_env_vars(topology, lookup_env)` walks bindings, resolves
  each `env:VAR` ref against the parent process's env at spawn time, and
  returns a `HashMap<String, String>` for the spawn.
- Missing parent env → loud error naming the binding and the var.
- Duplicate binding name → loud error.
- Unit-tested via an injected `lookup_env` so tests don't touch real env.

**Key invariant: the durable thing is the binding (name + ref). The value
never enters durable state.** Replays/observers see `{ name: "ANTHROPIC_API_KEY",
ref: "env:ANTHROPIC_API_KEY" }`; the secret lives only in the host process's
env at spawn time.

## Proposal

Adapt the Fireline pattern to Firegrid's `RuntimeContext` plane, placed
**inside the provider config** so the existing provider-shaped pattern
holds and future providers can model secret injection differently.

### 1. Schema: add `envBindings` to the provider's `config` block

`RuntimeConfigSchema` is **already provider-shaped**: `argv`/`cwd` are
local-process concepts. When `remote-firecracker` (or
serverless-functions, K8s-pod, ...) lands, it will have its own config
shape. Env-var injection is the local-process flavor of secret
injection — other providers will use IAM roles, K8s `Secret` references,
vault sidecars, instance metadata services, etc. So `envBindings` lives
at `runtime.config.envBindings`, not at the top of `RuntimeContextIntent`.

In `packages/protocol/src/launch/schema.ts`:

```ts
export const RuntimeEnvBindingSchema = Schema.Struct({
  name: Schema.String,                 // env var name in the spawned process
  ref:  Schema.String,                 // resolution ref; v1 supports "env:VAR"
})
export type RuntimeEnvBinding = Schema.Schema.Type<typeof RuntimeEnvBindingSchema>

// Lives INSIDE RuntimeConfigSchema (the local-process config).
// Other providers will gain their own secret-injection shapes inside
// their own config schemas when they're added.
export const RuntimeConfigSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd:  Schema.optional(Schema.String),
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),  // new
})
```

`RuntimeContextIntentSchema` is unchanged — `envBindings` is reachable
through the existing `config` field. `PublicLaunchRuntimeIntentSchema`
and `local.jsonl(...)` accept the same optional field;
`normalizeRuntimeIntent` passes it through.

**Why not top-level on `RuntimeContextIntent`?** That would imply every
provider takes env vars, which is not true (IAM-role / K8s-secret /
vault providers don't). It would also conflate the durable binding
intent with the transient resolved values, which already have a
provider-side home: `SandboxCommand.envVars: Record<string, string>`.
Bindings are durable refs; the resolved map is what crosses the provider
boundary. They live at different layers.

### 2. Resolver: `resolveSpawnEnvVars` (lives at the provider boundary)

The resolver is the **boundary translator** between the durable binding
intent (refs) and the provider's spawn primitive (`envVars` map). It sits
on the provider side of the host because:

- it knows the provider's expected shape (a `Record<string, string>` for
  process providers),
- the resolution policy (env vs. vault vs. K8s secret) is a
  provider-flavored concern, even though v1 only implements `env:`,
- it stays out of the durable plane — only the bindings are persisted;
  the resolver runs at activity execution time.

In `packages/runtime/src/providers/sandboxes/secrets.ts`:

```ts
type EnvLookup = (name: string) => string | undefined

export const resolveSpawnEnvVars = (
  bindings: ReadonlyArray<RuntimeEnvBinding>,
  lookupEnv: EnvLookup,
): Effect.Effect<Record<string, string>, ResolveEnvBindingError> => ...
```

- v1 supports only the `env:VAR` ref shape. Unknown shapes → typed error
  (forward-compatible: future `secret:VAR`, `vault:path/to/key`, etc.).
- Missing parent env → typed error naming the binding + var.
- Duplicate binding name → typed error.
- Pure function; tests inject `lookupEnv`. Production calls
  `(name) => globalThis.process.env[name]`.

### 3. Wire-through: extend `commandForContext`

`commandForContext` is already the host→provider translator (it converts
a durable `RuntimeContext` row into the `argv`/`cwd` shape `SandboxCommand`
expects). It naturally extends to also produce the resolved `envVars`
map — they all flow through the same boundary.

`packages/runtime/src/providers/sandboxes/runtime-command.ts`:

```ts
return {
  argv: [...context.runtime.config.argv],
  ...(context.runtime.config.cwd === undefined ? {} : { cwd: context.runtime.config.cwd }),
  envVars: yield* resolveSpawnEnvVars(
    context.runtime.config.envBindings ?? [],          // ← now nested under config
    name => globalThis.process.env[name],
  ),
}
```

The runtime-host's `runRuntimeContext` already spreads `...command` into
`SandboxCommand`, and `LocalProcessSandboxProvider.buildCommand` already
merges `command.envVars` into the `Command.env(...)` call. **No
`packages/runtime/src/runtime-host/**` edits required.**

End-to-end flow:

```
durable RuntimeContext.runtime.config.envBindings (refs only)
      ↓ commandForContext
{ argv, cwd?, envVars: Record<string, string> }   ← provider boundary
      ↓ runRuntimeContext spreads into SandboxCommand
SandboxCommand.envVars                            ← provider primitive
      ↓ LocalProcessSandboxProvider.buildCommand
Command.env({ ...config.envVars, ...command.envVars })
      ↓
spawned child process
```

### 4. `firegrid:run` flag plumbing — built on `@effect/cli`

**Naming rule:** flag names map 1-to-1 to launch-spec field paths, with
nested fields delimited by `-`. So `RuntimeContextIntent.envBindings`
becomes `--env-bindings`, `RuntimeContextIntent.config.cwd` becomes
`--config-cwd`, etc. No invented vocabulary; if you know the schema you
know the flags.

**Parser:** the current `src/run.ts` hand-rolls the argv → intent parser
(custom `--` handling, manual usage-error messages, no help text, no
completions). For this iteration we replace it with `@effect/cli`. We are
already fully bought into Effect; `@effect/cli` is the right Effect tool
for the job and removes the need to either build an AST traverser or
maintain a bespoke parser.

```ts
import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, HashMap, Schema } from "effect"

// One Options per launch-spec field. Names track schema field paths;
// since the field lives at `runtime.config.envBindings`, the flag is
// `--config-env-bindings`.
const configEnvBindings = Options.keyValueMap("config-env-bindings").pipe(
  Options.optional,
)

// Repeated positional arg captures the agent command (everything after `--`).
const agentArgv = Args.text({ name: "agent-argv" }).pipe(Args.repeated)

const runCommand = Command.make(
  "run",
  { configEnvBindings, agentArgv },
  ({ configEnvBindings, agentArgv }) =>
    Effect.gen(function* () {
      // Decode the parsed config through the schema. The schema is the
      // single source of truth: a flag whose value violates the schema
      // (bad ref shape, unknown provider, etc.) cannot reach the program.
      const intent = yield* Schema.decodeUnknown(
        PublicLaunchRuntimeIntentSchema,
      )({
        provider: "local-process",
        config: {
          argv: [...agentArgv],
          envBindings: HashMap.toEntries(
            Option.getOrElse(configEnvBindings, () => HashMap.empty()),
          ).map(([name, ref]) => ({ name, ref })),
        },
      })

      // ... build RuntimeContext row, upsert, call startRuntime
    }),
)

const cli = Command.run(runCommand, {
  name: "firegrid run",
  version: /* read from root package.json at build time */,
})

cli(globalThis.process.argv).pipe(
  Effect.provide(FiregridRuntimeHostWithWorkflowFromConfig),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
```

**What `@effect/cli` gives us for free** (each was a hand-roll cost in
the current MVP):

| Capability | Today's MVP | With `@effect/cli` |
|---|---|---|
| `--config-env-bindings KEY=VALUE` (repeatable) | Would need custom array-of-pairs parser | `Options.keyValueMap("config-env-bindings")` → `HashMap<string,string>` |
| Agent argv after `--` | Custom `argv.indexOf("--")` slicing | `Args.text(...).pipe(Args.repeated)` (the framework handles `--`) |
| `--help` with proper formatting | Hand-written usage string | Auto-generated from Options/Args |
| `--version` | Not implemented | Built-in |
| Shell completions (`--completions zsh`) | Not implemented | Built-in |
| Wizard mode (`--wizard`) | Not implemented | Built-in |
| Type-checked option/arg shapes | Hand-validated | Inferred into the handler's config arg |
| Subcommand structure (`firegrid run`, `firegrid host`) | Two separate scripts | One `Command.withSubcommands([...])` |
| Validation error messages | `process.stderr.write` + exit 2 | `ValidationError` typed channel |

**Schema validation still runs** — `Schema.decodeUnknown(PublicLaunchRuntimeIntentSchema)`
inside the handler. `@effect/cli` ensures the input shape matches its
Options/Args declarations; the schema enforces the durable contract
(known refs, valid provider, etc.). Drift between flags and schema
fields shows up as either a TypeScript error in the handler's object
literal or a `ParseIssue` at runtime — both immediate and loud.

**Examples** (the field moved into `runtime.config`, so the flag is now
`--config-env-bindings` per the path-mapping rule):

```sh
pnpm firegrid run \
  --config-env-bindings ANTHROPIC_API_KEY=env:ANTHROPIC_API_KEY \
  -- node agent.mjs

pnpm firegrid run \
  --config-env-bindings ANTHROPIC_API_KEY=env:PARENT_ANTHROPIC_KEY \
  --config-env-bindings GITHUB_TOKEN=env:GITHUB_TOKEN \
  -- node agent.mjs

# Free: built-in help
pnpm firegrid run --help

# Free: shell completions
pnpm firegrid run --completions zsh
```

**Naming note: `firegrid:run` → `firegrid run`.** As a side benefit of
adopting `@effect/cli`, the colon-separated pnpm script
(`pnpm firegrid:run -- ...`) becomes a real subcommand
(`pnpm firegrid run ...`). The pnpm script can stay as an alias for
ergonomics. Future verbs (`firegrid host`, `firegrid replay`, …) compose
naturally as subcommands of one root.

Schema-shaped flags reserved for future use under the same naming rule
(out of scope for this proposal, but documented so the namespace stays
coherent):

| Schema path | Flag (Options shape) |
|---|---|
| `runtime.provider` | `Options.choice("provider", ["local-process"])` (locked in v1) |
| `runtime.config.cwd` | `Options.directory("config-cwd").pipe(Options.optional)` |
| `runtime.config.envBindings[].{name,ref}` | `Options.keyValueMap("config-env-bindings")` (this proposal) |
| `createdBy` | `Options.text("created-by").pipe(Options.optional)` |

When future providers ship, their config-shaped flags follow the same
rule: `runtime.config.image` for a future container provider becomes
`--config-image`, etc. Provider discrimination at the schema level
(tagged-union over `runtime.provider`) is a future refactor; for v1, the
single-provider flat `RuntimeConfigSchema` is sufficient.

### 5. Spec

Append a new ACID to `firegrid-workflow-driven-runtime.feature.yaml`
(no renumbering):

```yaml
PHASE_2_SYNC_RUN:
  requirements:
    5: The synchronous run entrypoint can attach env bindings of shape
       { name, ref: "env:VAR" } to the local-process provider's
       runtime.config.envBindings; the binding ref is the only durably
       persisted form, and the resolved value is sourced from the host
       process's env at spawn time and merged into the local-process
       SandboxCommand.envVars without traversing the durable plane.
       envBindings is a property of the local-process provider config,
       not of the top-level runtime intent; future providers may model
       secret injection differently in their own provider-config blocks.
```

## Mapping table

| Fireline | Firegrid |
|---|---|
| `SecretsInjectionConfig.bindings` | `RuntimeConfig.envBindings` (provider-shaped, inside `runtime.config`) |
| `parse_credential_ref_shape("env:X")` | small Schema-shaped parser |
| `resolve_spawn_env_vars_with(topology, lookup_env)` | `resolveSpawnEnvVars(bindings, lookupEnv)` (provider-side) |
| Spawn-time merge with parent env | `LocalProcessSandboxProvider.buildCommand`'s existing `Command.env({ ...config.envVars, ...command.envVars })` |
| Loud error: missing parent env | typed `ResolveEnvBindingError` |
| Loud error: duplicate target | typed `ResolveEnvBindingError` |
| `secret:...` ref shape (out-of-scope here) | reserved; rejected loudly in v1 |

## Out of scope

- **Non-`env:` ref shapes.** `secret:`, `vault:`, `1password:`, etc. are
  forward-compatible additions; v1 supports only `env:VAR`.
- **`firegrid:host` (the long-running daemon path).** This proposal is
  scoped to `firegrid:run`. The daemon already uses Effect Config at the
  *host* boundary; per-context env bindings are a future host-side
  enhancement if/when needed.
- **Stdio passthrough mode for `firegrid:run`.** Necessary for Zed
  external-agents compatibility but architecturally distinct from env
  threading. Tracked separately (see "Sequencing" below).
- **Encryption / sealing of refs in the durable plane.** Refs are names,
  not values; encrypting them is unnecessary in v1.

## Why this needs to land soon

Production-shaped agent testing on Firegrid is **blocked** without env
threading:

- Any real LLM-backed agent needs `ANTHROPIC_API_KEY` or equivalent to
  start.
- Cannot validate the Phase 1 `RuntimeContextWorkflow` end-to-end against
  a real agent without it.
- Cannot demonstrate the Firegrid substrate as a Zed external-agent
  backend (which would be a high-leverage validation target since it
  exercises live ingress, output journaling, and durable replay against a
  real user-facing surface).
- Today's only workaround is to hard-code keys into the agent script
  itself, which is unacceptable even for spike work.

This proposal **must merge as a quick follow-up after PR #181** so the rest
of the Phase 2 / Phase 3 validation roadmap can use real agents instead of
toy local processes.

## Sequencing

1. **PR #181 lands** (`firegrid:run -- <agent>` synchronous MVP).
2. **This proposal → implementation PR**:
   - root: add `@effect/cli` dependency
   - root: replace `src/run.ts`'s hand-rolled argv parsing with a
     `Command.make("run", ...)` definition; keep the same teardown shape
     for child exit-code propagation
   - protocol: add `RuntimeEnvBindingSchema` and the optional
     `envBindings` field on `RuntimeContextIntentSchema`
   - providers/sandboxes: add `resolveSpawnEnvVars` + tests
   - providers/sandboxes: extend `commandForContext` to return `envVars`
   - features: append ACID `PHASE_2_SYNC_RUN.5`
3. **Stdio passthrough mode** (separate PR, Zed-compat blocker #2):
   - tee mode for `firegrid run` so child stdin/stdout flow through to the
     parent terminal while the substrate continues to journal evidence.
4. **Zed external-agent smoke** (validation milestone): configure a real
   agent in Zed's `agent_servers` pointing at `pnpm firegrid run` with env
   bindings, verify the substrate captures every prompt/response as
   durable evidence.

## Validation plan

- **Unit (resolver):** covers (same name on both sides), (rename), (missing
  parent env → loud error), (duplicate binding → loud error), (unknown ref
  shape → loud error). All tests inject `lookupEnv` so they don't touch
  real process env.
- **Unit (parser):** `@effect/cli`'s own test suite already covers
  argument/option parsing; we don't re-test the framework. We do add one
  smoke test asserting the `runCommand` definition's parsed shape decodes
  cleanly through `PublicLaunchRuntimeIntentSchema`.
- **Integration:** `pnpm firegrid run
  --config-env-bindings FAKE_KEY=env:FAKE_KEY -- node -e
  'console.log(process.env.FAKE_KEY)'` against a `DurableStreamTestServer`,
  with `FAKE_KEY` set in the harness env, asserts:
  - the value reaches the child (captured in `RuntimeOutputTable.events`),
  - the value does **not** appear in the durable `RuntimeContext` row JSON
    (only the binding `{ name, ref: "env:FAKE_KEY" }` is persisted, nested
    under `runtime.config.envBindings`).
- **Spec:** ACID `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5`
  referenced in the integration test and the resolver tests.

## Risks

- **Schema migration.** Adding `envBindings` is additive (optional field),
  so retained streams replay cleanly. Renaming the field later would break
  replay.
- **Two launch normalization paths drift.** `@firegrid/client.launch` and
  `firegrid run` should converge on the same row constructor (the SDD
  already calls this out). This proposal takes care to keep
  `normalizeRuntimeIntent` as the single normalization point — both paths
  go through it.
- **`@effect/cli` argument-order discipline.** Per the framework's docs,
  `Options` must precede positional `Args`. Standard Unix convention, but
  a regression vs. the current MVP's "anything before `--`" tolerance.
  Mitigated by the auto-generated `--help` output showing the right
  invocation shape.
- **Future `secret:` shapes.** v1 rejects unknown ref shapes loudly. When
  the second consumer needs `secret:` / `vault:`, the resolver gains a
  pluggable shape registry; the schema does not change.
