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

Adapt the Fireline pattern to Firegrid's `RuntimeContext` plane.

### 1. Schema: append `envBindings` (durable, names + refs only)

In `packages/protocol/src/launch/schema.ts`:

```ts
export const RuntimeEnvBindingSchema = Schema.Struct({
  name: Schema.String,                 // env var name in the spawned process
  ref:  Schema.String,                 // resolution ref; v1 supports "env:VAR"
})
export type RuntimeEnvBinding = Schema.Schema.Type<typeof RuntimeEnvBindingSchema>

export const RuntimeContextIntentSchema = Schema.Struct({
  provider: RuntimeProviderSchema,
  config:   RuntimeConfigSchema,
  journal:  Schema.Array(RuntimeJournalRuleSchema),
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),  // new
})
```

`PublicLaunchRuntimeIntentSchema` and `local.jsonl(...)` accept the same
optional field; `normalizeRuntimeIntent` passes it through.

### 2. Resolver: `resolveSpawnEnvVars`

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

`packages/runtime/src/providers/sandboxes/runtime-command.ts`:

```ts
return {
  argv: [...context.runtime.config.argv],
  ...(context.runtime.config.cwd === undefined ? {} : { cwd: context.runtime.config.cwd }),
  envVars: yield* resolveSpawnEnvVars(
    context.runtime.envBindings ?? [],
    name => globalThis.process.env[name],
  ),
}
```

Runtime-host's `runRuntimeContext` already spreads `...command` into
`SandboxCommand`, and `LocalProcessSandboxProvider.buildCommand` already
merges `command.envVars` into the `Command.env(...)` call. **No
`packages/runtime/src/runtime-host/**` edits required.**

### 4. `firegrid:run` flag plumbing

```sh
# Same name on both sides (most common case)
pnpm firegrid:run --secret-env ANTHROPIC_API_KEY -- node agent.mjs

# Rename: parent has different var name than the binding
pnpm firegrid:run --secret-env ANTHROPIC_API_KEY=PARENT_ANTHROPIC_KEY -- node agent.mjs

# Multiple flags allowed; bindings carried into the row
pnpm firegrid:run --secret-env ANTHROPIC_API_KEY --secret-env GITHUB_TOKEN -- ...
```

`firegrid:run` parses `--secret-env` flags before `--`, builds the
`envBindings` array, attaches it to the `RuntimeContext` row at upsert time.

### 5. Spec

Append a new ACID to `firegrid-workflow-driven-runtime.feature.yaml`
(no renumbering):

```yaml
PHASE_2_SYNC_RUN:
  requirements:
    5: The synchronous run entrypoint can attach env bindings of shape
       { name, ref: "env:VAR" } to the RuntimeContext row; the binding ref
       is the only durably persisted form, and the resolved value is
       sourced from the host process's env at spawn time and merged into
       the local-process SandboxCommand without traversing the durable
       plane.
```

## Mapping table

| Fireline | Firegrid |
|---|---|
| `SecretsInjectionConfig.bindings` | `RuntimeContextIntent.envBindings` |
| `parse_credential_ref_shape("env:X")` | small Schema-shaped parser |
| `resolve_spawn_env_vars_with(topology, lookup_env)` | `resolveSpawnEnvVars(bindings, lookupEnv)` |
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
2. **This proposal → implementation PR** (~150-250 LOC):
   - protocol schema additions (`RuntimeEnvBindingSchema`)
   - resolver + tests in `packages/runtime/src/providers/sandboxes/`
   - `commandForContext` extension
   - `firegrid:run` `--secret-env` flag
   - new ACID in `firegrid-workflow-driven-runtime.feature.yaml`
3. **Stdio passthrough mode** (separate PR, Zed-compat blocker #2):
   - tee mode for `firegrid:run` so child stdin/stdout flow through to the
     parent terminal while the substrate continues to journal evidence.
4. **Zed external-agent smoke** (validation milestone): configure a real
   agent in Zed's `agent_servers` pointing at `pnpm firegrid:run -- <agent>`
   with env bindings, verify the substrate captures every prompt/response
   as durable evidence.

## Validation plan

- Unit: resolver covers (name = parent var), (rename), (missing parent env
  → loud error), (duplicate binding → loud error), (unknown ref shape →
  loud error).
- Integration: `firegrid:run --secret-env FAKE_KEY -- node -e
  'console.log(process.env.FAKE_KEY)'` against a `DurableStreamTestServer`,
  with `FAKE_KEY` set in the harness env, asserts the value reaches the
  child but does **not** appear in the durable `RuntimeContext` row JSON.
- Spec: ACID `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5`
  referenced in the integration test and the resolver tests.

## Risks

- **Naming churn.** `--secret-env` is one of several plausible flag names
  (`--env-binding`, `--inject-env`, `--passthrough-env`). Pick once, stick
  with it.
- **Schema migration.** Adding `envBindings` is additive (optional field),
  so retained streams replay cleanly. Renaming the field later would break
  replay.
- **Two launch normalization paths drift.** `@firegrid/client.launch` and
  `firegrid:run` should converge on the same row constructor (the SDD
  already calls this out). This proposal takes care to keep
  `normalizeRuntimeIntent` as the single normalization point — both paths
  go through it.
- **Future `secret:` shapes.** v1 rejects unknown ref shapes loudly. When
  the second consumer needs `secret:` / `vault:`, the resolver gains a
  pluggable shape registry; the schema does not change.
