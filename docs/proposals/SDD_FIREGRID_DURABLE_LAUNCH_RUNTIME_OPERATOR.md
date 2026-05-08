# SDD: Durable Launch Runtime Operator

Date: 2026-05-07

Status: Proposal, backed by `firegrid-durable-launch-runtime-operator.*`

Scope: A Firegrid capability for subscribing to durable launch facts and
starting disposable runtime processes whose observable state is entirely
rebuildable from Durable Streams.

Non-scope: RPC agent invocation, transport-specific edge APIs, preserving
process handles across restart, provider-specific agent catalogs, credential
storage, product-owned session/event schemas, or exposing raw StreamDB
collections as the default app-facing API.

## Thesis

Firegrid can add more value than a passive data plane by becoming a
stream-native runtime operator:

```txt
publisher appends launch fact
Firegrid observes launch fact
Firegrid starts configured runtime process
runtime emits durable lifecycle/session/event facts
process may die
replacement process rebuilds from the stream and resumes according to policy
```

The process is cheap and disposable. The stream is the durable record of truth.
Session transcripts, launch state, resource state, provider state, and recovery
decisions must be durable or derivable from durable rows.

This is not a Fireline API port. The useful subset from Fireline's
`client-events.md` is the stream-native command pattern: append launch and stop
intent rows, then observe materialized lifecycle state. Firegrid should not
inherit Fireline's transport-option public surface or expose launch as an RPC.

## Foundation

Existing Firegrid specs already cover adjacent mechanics:

- `firegrid-runtime-process.*`: runtime process entrypoint and Effect Platform
  process discipline.
- `workflow-engine-durable-state.*`: Durable Streams backed
  `@effect/workflow` engine.
- `firegrid-runtime-presence.*`: advisory runtime presence and freshness.
- `firegrid-execution-plane-resources.*`: resource identity and
  materialization facts.
- `firegrid-runtime-ownership-transfer.*`: lease/fence/rebuild mechanics for
  host shifts.
- `stream-first-substrate-simplification.*`: StreamDB as canonical persisted
  state.

The new capability would connect these into one product-neutral launch lane.

## Usability Goal

The app-facing API should make the stream-native model feel coherent. A user
should be able to launch a runtime-backed agent and immediately observe the
durable streams associated with that launch without learning internal launch
operator collections.

The shape to borrow from Fireline is not its transport config. It is the
resource handle:

```txt
open scoped client
launch agent by appending durable launch fact
receive launch handle
observe launch lifecycle
observe runtime/session streams exposed by that handle
stop by appending durable stop fact
scope closes subscriptions
```

Firegrid should keep this product-neutral. It can expose launch lifecycle and
configured stream observation, but product packages define how session events,
messages, provider updates, or transcripts are decoded.

## Provider Definitions, Materializers, and Projections

Launch usability depends on letting users bring their own provider wire
formats. A Claude SDK CLI stream, a Claude ACP agent, Codex, Devin, Cursor, and
a custom in-process agent will not emit the same event payloads.

Firegrid should split this into two userland definitions:

| Definition | Owner | Purpose |
| --- | --- | --- |
| `RuntimeTarget` | user/product | Describes how to start the live agent runtime: command, module, container, or adapter-specific spec. |
| `StreamMaterializer` | user/product | Maps provider wire rows from named streams into canonical projected rows for a UI or SDK. |

These definitions are independent. A single runtime target can support multiple
materializers, and a materializer can be reused across multiple runtime targets.
Materializers are not 1:1 with runtime targets, named streams, or launches.

Firegrid can provide the hosting and observation frame:

```txt
launch target -> process lifecycle
named stream descriptors -> open StreamDB
raw provider wire rows -> durable record
materializer -> canonical projection rows
client handle -> observe canonical projection
```

It should not decide that a provider event is a chat message, tool call,
permission request, or terminal result unless the user supplied a materializer
that says so.

A materializer declares:

```ts
const MaterializerDefinition = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  inputs: Schema.Array(Schema.String),
  output: Schema.String,
  rowSchemas: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  projectionSchema: Schema.Unknown,
})
```

`inputs` are launch stream names. `output` is the addressable projection name.
The projection is opened by name regardless of whether the materializer was
attached at launch time, by a late observer, or by a runtime materialization
process. This is what makes client-local materialization useful for late
observers: the raw rows remain durable, and the projection fold can be attached
after the launch exists.

Materializer folds are pure folds over schema-decoded durable rows. They may
emit projection rows, maintain fold-local accumulator state, and use deterministic
helpers. They do not perform network calls, filesystem reads, credential lookup,
provider API calls, or other platform effects. Any impure decoration, such as
fetching tool definitions to improve rendering, belongs in a downstream
enrichment layer and must not become projection authority.

## Canonical Projection Contract

The generic launch handle can expose low-level named streams, but it should also
support user-defined projections that turn arbitrary provider rows into a small
canonical app-facing view.

Candidate canonical rows:

```ts
const AgentSessionProjection = Schema.Struct({
  sessionId: Schema.String,
  launchId: Schema.String,
  status: Schema.Literal("creating", "running", "idle", "complete", "failed", "stopped"),
  title: Schema.optional(Schema.String),
  updatedAt: Schema.String,
})

const AgentMessageProjection = Schema.Struct({
  messageId: Schema.String,
  sessionId: Schema.String,
  role: Schema.Literal("system", "user", "assistant", "tool"),
  content: Schema.Unknown,
  sequence: Schema.Number,
  at: Schema.String,
})

const AgentActivityProjection = Schema.Struct({
  activityId: Schema.String,
  sessionId: Schema.String,
  kind: Schema.Literal("thinking", "tool_call", "tool_result", "permission", "warning", "error"),
  payload: Schema.Unknown,
  sequence: Schema.Number,
  at: Schema.String,
})
```

These are projection targets, not required provider input shapes. A provider can
emit richer raw rows; the materializer chooses what becomes a canonical message
or activity. Unknown or provider-specific rows remain durable raw records and
can be exposed through diagnostic views.

Example:

```ts
const ClaudeSdkMaterializer = Materializer.define({
  name: "claude-sdk.stream-json",
  version: "2026-05-07",
  inputs: ["provider-wire"],
  output: "agent",
  fold: ({ row, emit }) => {
    switch (row.type) {
      case "system":
        emit.session({
          sessionId: row.session_id,
          status: "running",
          updatedAt: rowSeenAt(row),
        })
        break
      case "assistant":
        emit.message(assistantMessageFromClaude(row))
        break
      case "stream_event":
        emit.message(deltaFromClaudeStreamEvent(row))
        break
      case "result":
        emit.session(terminalSessionFromClaudeResult(row))
        break
    }
  },
})
```

For a Claude ACP agent, the materializer would instead consume ACP session
updates and optional raw SDK messages. The projected rows can be the same even
when the wire payloads differ.

## Materialized Launch Handle

The ergonomic client path can compose a launch handle with one or more
materializers:

```ts
const launch = yield* firegrid.launch(claudeRuntime, {
  launchId: `launch:${runId}`,
})

const agent = yield* launch.projection("agent", {
  materializer: ClaudeSdkMaterializer,
})

yield* Effect.forkScoped(
  agent.messages.pipe(Stream.runForEach(renderMessage)),
)

yield* Effect.forkScoped(
  agent.session.pipe(Stream.runForEach(renderSessionHeader)),
)
```

The materializer can run in the client for read-only local projection, in a
runtime process for durable projected rows, or both:

| Mode | Use | Constraint |
| --- | --- | --- |
| client-local | UI derivation from retained raw rows | Does not create durable projection authority. |
| runtime-materialized | Shared durable read model | Projection rows must declare source streams, fold version, and cursor semantics. |
| dual | Fast UI plus durable shared projection | Client fold must match the declared durable fold version. |

The default for a first spike should be client-local materialization over raw
durable rows. Durable materialized projection rows can follow once the canonical
shape stabilizes.

In `dual` mode, the runtime and client use the same materializer identity and
fold version. In practice this means the fold must be shareable code or an
equivalent deterministic artifact. Firegrid should validate the declared
version/cursor contract; it should not try to prove two arbitrary JS modules are
semantically identical.

## Core Principle

Durable rows record facts such as:

```txt
launch requested
launch accepted
runtime provision started
runtime process started
runtime ready
session created or loaded
session transcript event appended
runtime process exited
runtime lost
launch stop requested
runtime stop attempted
runtime stopped
launch failed
```

Non-durable live resources include:

```txt
current PID
current child-process handle
current stdio pipe
current SDK client
current WebSocket
current fiber
current filesystem handle
```

A replacement runtime must reconstruct from durable records before performing
side effects. A process handle is never the authority.

## Row Families

The first product-neutral shape should be small:

| Collection | Key | Writer | Meaning |
| --- | --- | --- | --- |
| `launchRequests` | `launchId` | publisher | A desired runtime launch exists. |
| `launchStops` | `stopId` | publisher | A desired launch stop exists. |
| `launches` | `launchId` | launch operator | Materialized lifecycle state for the launch. |
| `runtimeProcesses` | `processEventId` | launch operator | Durable evidence that a process attempt started, became ready, exited, or was lost. |
| `runtimeResources` | `resourceId` | runtime/materializer | Durable resource/materialization facts needed to rebuild the runtime. |

Product systems can add their own session and event collections. Firegrid
should not define message, prompt, provider, tool, or transcript schemas.

`launches` is a projection folded over launch request, stop, and
`runtimeProcesses` facts. A launch is one logical resource. Runtime process rows
are the event facts for its N process attempts.

## Launch Handle

The client affordance should return a durable handle, not a live process handle.

```ts
const launch = yield* firegrid.launch(runtime, {
  launchId: `launch:${runId}`,
})

yield* Effect.forkScoped(
  launch.lifecycle.pipe(Stream.runForEach(renderLaunchState)),
)

const agent = yield* launch.projection("agent", {
  materializer: ClaudeSdkMaterializer,
})

yield* launch.stop("operator requested stop")
```

The handle should expose:

| Member | Meaning |
| --- | --- |
| `launchId` | Durable launch id. |
| `lifecycle` | Replay-plus-live stream of launch lifecycle projection updates. |
| `snapshot` | Current launch projection snapshot. |
| `streams` | Named stream descriptors advertised by the launch request or launch projection. |
| `projection(name)` | Opens a user-defined materialized view over one or more named streams. |
| `diagnostic.stream(name)` | Explicit diagnostic raw observation handle for a configured app stream. |
| `stop(reason)` | Appends a durable launch stop fact. |

Raw stream access is diagnostic. The default app-facing surface is lifecycle
plus named projections. This keeps product packages honest: if Flamecast wants
messages, sessions, or provider events, Flamecast supplies a materializer and
wrapper rather than treating raw provider rows as its public API.

`projection(name)` is still generic from Firegrid's point of view. The user or
product package supplies the schemas, fold, and canonical output type.

Product packages can wrap it:

```ts
const flamecast = Flamecast.fromLaunch(launch)

yield* Effect.forkScoped(
  flamecast.events.pipe(Stream.runForEach(renderSessionEvent)),
)

const history = yield* flamecast.history
```

The launch handle is the bridge between Firegrid-owned launch lifecycle and
product-owned session/event decoding.

## Launch Request Shape

The request should be serializable data, not an RPC call.

```ts
const RuntimeLaunchRequest = Schema.Struct({
  launchId: Schema.String,
  requestedAt: Schema.String,
  requestedBy: Schema.optional(Schema.String),
  target: Schema.Struct({
    kind: Schema.Literal("command", "js-module", "container"),
    spec: Schema.Unknown,
    readiness: Schema.optional(Schema.Struct({
      stream: Schema.String,
      rowType: Schema.String,
      predicateRef: Schema.String,
    })),
    rebuild: Schema.optional(Schema.Struct({
      inputs: Schema.Array(Schema.String),
      strategy: Schema.Literal("fresh", "replay", "session-load"),
      entrypointRef: Schema.String,
    })),
  }),
  runtime: Schema.Struct({
    provider: Schema.Literal("local-process"),
    labels: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  }),
  planes: Schema.Struct({
    session: Schema.Record({ key: Schema.String, value: StreamPlaneRef }),
    diagnostics: Schema.optional(Schema.Record({ key: Schema.String, value: StreamPlaneRef })),
    execution: Schema.optional(Schema.Record({ key: Schema.String, value: ExecutionPlaneRef })),
    resources: Schema.optional(Schema.Record({ key: Schema.String, value: ResourcePlaneRef })),
  }),
  bindings: Schema.optional(Schema.Array(PlaneBinding)),
  resources: Schema.optional(Schema.Array(Schema.Unknown)),
  restartPolicy: Schema.optional(Schema.Struct({
    mode: Schema.Literal("never", "on-failure", "always"),
    maxAttempts: Schema.optional(Schema.Number),
  })),
})
```

`target.spec` is provider-specific but durable and schema-validated by the
provider adapter. Secrets are references only, never raw material. Firegrid
should provide a shared `SecretRef` schema and adapters must reject raw secret
material in their durable specs.

`launchId` is the v1 idempotency key. If a later product needs a separate
dedupe key, that can be added explicitly, but the common case should not require
two publisher-generated identifiers.

Readiness is target-owned but operator-observed. The operator should not contain
Claude, ACP, Codex, Cursor, Devin, or Flamecast readiness code. A target declares
which durable row proves readiness, and the operator watches that stream after
starting the process. This keeps provider knowledge in the target definition
while still producing a Firegrid-owned durable ready lifecycle fact.

Rebuild is also target-owned. Restart policy answers whether another attempt is
allowed. Rebuild answers what the replacement runtime must do before it is
equivalent to the dead attempt: start fresh, replay durable rows, call
`session/load`, or run another target-defined entrypoint. The runtime entrypoint
performs that rebuild from its own durable inputs; the operator records process
attempt facts and enforces lifecycle policy.

The edge-facing convenience API should not leak low-level transport knobs.
Applications supply a configured Firegrid client or Layer once; launch calls
append data through that configured boundary.

## Planes and Bindings

The launch spec should go deeper than "run this command." In the Managed Agents
framing, the useful line is between the brain, the hands, and the durable
session. Firegrid should model that as planes:

| Plane | Meaning | Firegrid responsibility |
| --- | --- | --- |
| `session` | Durable product/session/provider event streams. | Carry stream references and expose observation/materializer hooks. |
| `diagnostics` | Logs, traces, stdout/stderr captures, and raw debugging streams. | Keep diagnostic access explicit and non-authoritative. |
| `execution` | Where side effects happen: local process, Docker workspace, Daytona sandbox, hosted adapter, remote container. | Carry opaque refs and lifecycle facts; do not own sandbox policy. |
| `resources` | Things attached to execution: repo, fs mount, artifact bundle, volume, MCP proxy, secret ref. | Carry resource refs and materialization status; never store bytes or raw secrets. |

Plane refs are capabilities and durable facts, not provider taxonomy. For
example, a local stdio ACP agent installed through npm can run on a local
process execution plane while receiving a remote filesystem sandbox through a
resource plane:

```ts
const request = RuntimeLaunchRequest.make({
  launchId: "launch:acp:123",
  target: {
    kind: "command",
    spec: {
      argv: ["npx", "-y", "claude-agent-acp"],
      protocol: "acp-stdio",
    },
    readiness: {
      stream: "provider-wire",
      rowType: "acp.session.ready",
      predicateRef: "claude-acp-ready-v1",
    },
    rebuild: {
      inputs: ["provider-wire"],
      strategy: "session-load",
      entrypointRef: "claude-acp-rebuild-v1",
    },
  },
  planes: {
    session: {
      "provider-wire": {
        kind: "stream",
        role: "events",
        streamUrl: providerWireStreamUrl,
      },
    },
    execution: {
      "agent-process": {
        kind: "local-process",
      },
      workspace: {
        kind: "remote-sandbox",
        provider: "daytona",
        ref: "sandbox:daytona:abc",
      },
    },
    resources: {
      repo: {
        kind: "repository",
        ref: "repo:firegrid@main",
      },
      fs: {
        kind: "filesystem-mount",
        ref: "volume:workspace",
        mountPath: "/workspace",
      },
      anthropic: {
        kind: "secret",
        ref: "secret:anthropic-api-key",
      },
    },
  },
  bindings: [
    {
      kind: "env",
      name: "FLAMECAST_PROVIDER_WIRE_STREAM_URL",
      from: { plane: "session", name: "provider-wire", field: "streamUrl" },
    },
    {
      kind: "env-secret",
      name: "ANTHROPIC_API_KEY",
      from: { plane: "resources", name: "anthropic", field: "ref" },
    },
    {
      kind: "mount",
      name: "workspace",
      from: { plane: "resources", name: "fs", field: "mountPath" },
    },
  ],
})
```

The operator can interpret generic binding forms. It should not know that the
target is Claude, ACP, Flamecast, or Codex. Product adapters own target-specific
validation and startup behavior.

## Sandbox Providers

Execution planes should be backed by a provider abstraction before we add more
remote targets. The useful shape from Cased's sandbox library is:

```txt
SandboxConfig -> SandboxProvider.create -> Sandbox
SandboxProvider.execute(sandbox, command, env)
SandboxProvider.destroy(sandbox)
```

Firegrid's TypeScript version should stay product-neutral:

```ts
interface SandboxProvider {
  name: string
  capabilities: {
    persistent: boolean
    snapshot: boolean
    streaming: boolean
    fileUpload: boolean
    interactiveShell: boolean
    gpu: boolean
  }
  createSandbox(config: SandboxConfig): Effect.Effect<Sandbox, SandboxProviderError>
  getSandbox(id: string): Effect.Effect<Sandbox | undefined, SandboxProviderError>
  listSandboxes(labels?: Record<string, string>): Effect.Effect<readonly Sandbox[], SandboxProviderError>
  executeCommand(
    sandboxId: string,
    command: SandboxCommand,
    options?: { timeoutSeconds?: number; envVars?: Record<string, string> },
  ): Effect.Effect<ExecutionResult, SandboxProviderError>
  destroySandbox(id: string): Effect.Effect<boolean, SandboxProviderError>
}
```

Local process is just the first provider. Val Town is the first cheap remote
provider. E2B, Daytona, Fly, Docker, or other container/VM providers can follow
behind the same contract when their capabilities are needed.

This is also the right layer for local-to-remote handoff:

```txt
same launch id
same session stream plane
same resource refs and secret refs
different SandboxProvider implementation
```

The provider may be wildly different internally, but the durable facts and
Flamecast materializers do not change.

## Secrets and Handoff

Non-secret runtime configuration can be bound directly from a plane field into
an environment variable. Secret-backed runtime configuration must use a
resource-plane secret reference plus an `env-secret` binding.

```ts
resources: {
  anthropic: {
    kind: "secret",
    ref: "secret:anthropic-api-key",
  },
},
bindings: [
  {
    kind: "env-secret",
    name: "ANTHROPIC_API_KEY",
    from: { plane: "resources", name: "anthropic", field: "ref" },
  },
]
```

The durable row stores only `secret:anthropic-api-key`. A local runtime host can
resolve that reference from process env, a developer keychain, 1Password, or a
dotenv-backed resolver. A remote runtime host can resolve the same reference
from its provider secret manager or inject it through the remote platform's
native secret facility. The resolved value is live process material only: it is
not appended to Durable Streams, not included in launch lifecycle rows, and not
included in diagnostic rows.

This is what makes local-to-remote handoff possible without interruption:

```txt
local launch uses secret:anthropic-api-key
local resolver injects ANTHROPIC_API_KEY into the local process
runtime writes provider/session facts to the session plane
handoff moves execution to a remote provider
remote resolver maps secret:anthropic-api-key to remote platform secret
replacement runtime replays the same session stream and resumes
```

If the remote host cannot resolve the secret reference, the launch should record
a materialization or launch failure and must not start the process with a missing
secret-dependent environment.

## Remote Tracer Provider

The next tracer lane should prove the same row model against one real remote
execution provider. Val Town is the first pragmatic target because the remote
runtime can be a tiny TypeScript val with an HTTP trigger. That is much cheaper
and simpler than a container provider for this tracer: it proves remote
execution and env/secret binding without asking Firegrid to solve container
packaging first.

The remote tracer should be opt-in because it creates external resources and
requires provider credentials:

```txt
FIREGRID_REMOTE_TRACER_PROVIDER=val-town
VAL_TOWN_API_KEY=...
FIREGRID_VAL_TOWN_USERNAME=...
```

The cheap/free tracer may create a public Val Town val because the tracer source
contains no secret values. Secret bindings are provided through Val Town
environment variables, which remain private to the val owner.

The remote tracer acceptance criteria:

1. Create or update a remote val for the same launch id.
2. Invoke the val through its HTTP trigger.
3. Return a provider-wire-shaped row proving the remote runtime received the
   launch id and resolved secret binding.
4. Provide provider credentials through Val Town environment variables or
   secrets, not durable Firegrid rows.
5. Delete or replace the remote val when cleanup is supported by the provider
   adapter.
6. Keep remote session-plane writeback as a separate opt-in lane requiring a
   Durable Streams endpoint reachable from the selected provider.

Default CI should not create Val Town resources. CI should run the local
deterministic tracer plus pure request-shape tests for the Val Town provider
adapter. A credentialed manual lane can run the external conformance test.

Container or VM providers can be added later if we need to prove long-running
process supervision. The immediate goal is cheaper: prove remote execution can
receive the same declarative launch and secret binding model before testing
remote durable stream writeback.

## Operator Shape

The launch operator is a claimed-work subscriber over `launchRequests`.

```txt
1. rebuild launch projections to the live boundary
2. find accepted launch requests without terminal launch state
3. claim the launch id
4. materialize resources
5. start the runtime process through Effect Platform
6. append process-started facts
7. observe the target-declared readiness predicate and append ready facts
7. monitor exit
8. append exited/lost/stopped facts
9. apply restart policy by appending a new process attempt fact
```

The operator should use StreamDB snapshots and subscriptions, not fixed polling.
It must not execute process side effects during replay.

## Effect Platform Fit

Effect Platform is the right boundary for live runtime resources:

- `@effect/platform` `Command` for child process startup and command IO;
- `@effect/platform` `FileSystem` for local workspace/resource materialization;
- `@effect/platform-node` `NodeRuntime` / `NodeContext` for Node-tier process
  entrypoints;
- Effect `Scope` for tying process, filesystem, and adapter cleanup to runtime
  lifetime.

Firegrid should expose durable launch mechanics. It should not hand-roll Node's
`child_process` lifecycle unless Effect Platform lacks a needed primitive and
that gap is documented.

## Workflow Option

Managing a launched process lifecycle as a durable Effect workflow is a viable
implementation strategy, but it should not change the model.

Use workflow when it helps with:

- durable retry and restart policy;
- durable sleep/backoff between attempts;
- idempotent process-attempt activities;
- stop/deferred wait handling;
- recovery after operator restart.

Do not use workflow to imply:

- a process handle is durable;
- a workflow can preserve stdio pipes across death;
- a killed process is a failure of the durable session;
- product session state lives in workflow rows.

Candidate workflow:

```ts
export const RuntimeLaunchWorkflow = Workflow.make({
  name: "firegrid.runtime_launch",
  payload: RuntimeLaunchRequest,
  success: RuntimeLaunchTerminal,
  error: RuntimeLaunchFailed,
  idempotencyKey: (request) => request.launchId,
})

export const StartRuntimeProcess = Activity.make({
  name: "firegrid.runtime_launch.start_process",
  success: RuntimeProcessAttempt,
  error: RuntimeProvisionFailed,
  execute: Effect.gen(function* () {
    const request = yield* CurrentLaunchRequest
    const command = yield* RuntimeTargetCompiler.toCommand(request.target)
    const process = yield* Command.start(command)
    yield* LaunchState.appendProcessStarted({ request, process })
    return yield* monitorUntilReadyOrExit(process, request.target.readiness)
  }),
})
```

The activity owns live process handles while it runs. Durable rows own what a
consumer can observe or recover.

## What Firegrid Should Pull Back

Firegrid should own product-neutral mechanics for:

- launch request and stop row schemas;
- launch lifecycle projections;
- launch handles that join lifecycle and named stream observation;
- launch idempotency/conflict folding;
- launch claim and process-attempt coordination;
- Effect Platform based local-process provider;
- resource materialization hooks with secret-reference discipline;
- runtime process lifecycle facts;
- restart policy mechanics;
- stop intent observation;
- read helpers for launch state;
- a materializer contract for user-defined projections over named streams.

Firegrid should not own:

- provider catalogs;
- product agent definitions;
- provider credentials;
- product session schemas;
- transcript schemas;
- tool or permission vocabularies;
- HTTP ingress or RPC launch endpoints;
- product-specific `chat`, `session`, `history`, or `messages` methods;
- built-in mappings for Claude SDK, Claude ACP, Codex, Devin, Cursor, or any
  other provider unless a separate adapter package owns that mapping;
- cross-provider semantic resume guarantees.

## Flamecast Fit

For `apps/flamecast`, the launch operator could replace local ad hoc runtime
bootstrapping:

```txt
Flamecast app appends RuntimeLaunchRequest
Firegrid launch operator starts local Flamecast provider runtime
runtime appends ProviderSession / NormalizedSessionEvent rows
browser observes Flamecast projections
process dies
operator starts replacement if policy allows
replacement runtime rebuilds provider/session state from stream
```

The Flamecast provider data model remains the one in
`SDD_FLAMECAST_CLEAN_ROOM_ON_FIREGRID.md`. Launch is the process-management
layer underneath it.

## Claude ACP Walkthrough

This walkthrough is the first real-world seam test. It should stay short. If it
requires provider special cases in the operator, the model is wrong.

1. Product code appends a `RuntimeLaunchRequest` with `launchId:
   "launch:acp:123"`, target kind `command`, a Claude ACP command spec, stream
   descriptors for `provider-wire` and `diagnostics`, readiness
   `{ stream: "provider-wire", rowType: "acp.session.ready", predicateRef:
   "claude-acp-ready-v1" }`, and rebuild `{ inputs: ["provider-wire"],
   strategy: "session-load", entrypointRef: "claude-acp-rebuild-v1" }`.

2. The launch operator folds to the live boundary, claims `launch:acp:123`,
   starts the command through Effect Platform, appends a `runtimeProcesses`
   started row, and begins watching the configured readiness predicate.

3. The ACP process appends raw durable rows to `provider-wire`: ACP
   initialization, a provider session id, session updates, assistant deltas, and
   tool or permission updates if the provider exposes them.

4. The operator sees the target-declared ready row and appends a
   `runtimeProcesses` ready row. It still does not parse ACP session semantics.

5. A UI opens `launch.projection("agent", { materializer:
   ClaudeAcpMaterializer })`. That materializer consumes `provider-wire` rows
   and projects session/messages/activity rows. A late observer can attach the
   same projection because the raw ACP rows are retained.

6. The ACP process dies mid-session. The operator appends an exited/lost
   process attempt row. The lifecycle projection now shows a non-terminal
   launch with a dead attempt and a restart policy decision pending.

7. Restart policy allows another attempt. The operator starts a replacement
   process and passes the target rebuild declaration. The runtime entrypoint
   reads `provider-wire`, finds the prior ACP session id, executes its
   target-owned `session/load` behavior, and appends new raw rows for the second
   process attempt.

8. The `agent` projection is refolded over both attempts' raw rows. It must
   produce a continuous logical session view with no duplicated terminal state
   and no gap at the death boundary. Process-attempt overlap is handled by the
   materializer's source cursor and provider ids, not by live process identity.

## Spike Plan

1. Define a feature spec for durable runtime launches.

   Requirements should cover launch request rows, stop rows, launch projection,
   launch handles, named projections, diagnostic raw stream observation,
   local-process provider, restart policy, rebuild, materializer purity, and
   stream-only ingress.

2. Implement a minimal local-process launch operator.

   Input: one Durable Streams URL with `launchRequests`.

   Output: `launches` and `runtimeProcesses` rows.

   Live side effect: start a trivial command through Effect Platform Command.

3. Add tests for disposable-process semantics.

   Prove that process exit appends durable state, a replacement process can be
   started from durable policy, and launch projection rebuilds without the live
   process.

4. Add a launch-handle client spike.

   A test should launch a trivial process, observe lifecycle replay-plus-live,
   open a named app stream from the handle, append app-owned events, and close
   subscriptions through scope finalization.

5. Add a client-local materializer spike.

   A test should define a fake provider wire schema, append wire rows to the
   named stream, attach a materializer, and render canonical session/message
   projections without Firegrid knowing provider vocabulary.

6. Add a death-boundary materializer test.

   A test should append provider wire rows before and after a process attempt
   death, restart through the declared rebuild strategy, and prove the named
   projection is consistent across the boundary with no missing or duplicated
   logical rows.

7. Decide whether to lower the operator to `@effect/workflow`.

   If workflow reduces custom lifecycle machinery, use it. If it makes process
   supervision harder to understand, keep workflow for retry/backoff/stop waits
   only and leave live monitoring in a scoped operator.

## Open Questions

1. Should launch rows live in a dedicated launch stream or in the app's state
   stream?

   Default: support either. Dedicated launch streams are cleaner for operators;
   app streams are simpler for small local development.

2. Is local-process provider enough for the first slice?

   Default: yes. Containers and remote hosts should wait until local-process
   semantics are proven.

3. What does "ready" mean?

   Default: a target-declared predicate over durable rows plus a Firegrid-owned
   ready lifecycle row. Ready is not session promptability unless the product
   adapter proves that separately.

4. Should the launch operator be part of `@firegrid/runtime` or a separate
   package?

   Default: start in `@firegrid/runtime` because it is Node-tier and already
   depends on Effect Platform Node.

5. Should `@firegrid/client` expose `launch(...)` directly or through a
   `./launch` subpath?

   Default: start with a curated client launch surface if the API remains
   product-neutral and browser-safe. Diagnostic raw collection access, if any,
   belongs on an explicit diagnostic subpath.

## Acceptance Bar

The spike is useful only if:

- launch is initiated by durable data appended to a stream, not an RPC;
- the edge API exposes no transport-specific launch knobs;
- live process handles never become durable authority;
- lifecycle projection rebuilds from durable rows;
- process death does not lose session/event state;
- replacement process startup is policy-driven and durable;
- replacement process rebuild behavior is declared by the runtime target and
  executed from durable rows;
- Effect Platform owns live process and filesystem boundaries;
- product schemas remain app-owned.
- app users get one scoped launch handle that can observe launch lifecycle and
  named projections without raw collection access.
- users can attach materializers that map provider-specific wire rows into a
  canonical projected view without Firegrid owning provider schemas.
- materialized projections remain consistent across process attempt death and
  replacement startup.
