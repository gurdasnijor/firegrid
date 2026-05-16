# SDD: Firegrid SDK Plane Split

Status: draft design contract

Related specs:

- `firegrid-host-sdk`
- `firegrid-schema-projection-contract`
- `firegrid-runtime-boundary-reconciliation`
- `firegrid-runtime-agent-event-pipeline`
- `firegrid-runtime-host-modularity`
- `firegrid-local-mcp-run`

Prior art:

- Restate TypeScript services: <https://docs.restate.dev/develop/ts/services>
- Restate service configuration:
  <https://docs.restate.dev/services/configuration>

## Why

`@firegrid/runtime` currently exports surfaces that product apps should not
import directly: host composition layers, agent-tool bindings, MCP listener
setup, and CLI launch substrate. The result is that `apps/factory` reaches
into runtime host paths, the root CLI duplicates launch logic that already
exists in host commands, and `packages/runtime/src/agent-tools/` mixes four
roles under one folder.

The fix is three public packages over the existing protocol/runtime split:

- `@firegrid/client-sdk` owns the browser/edge-safe session plane;
- `@firegrid/host-sdk` owns host composition, providers, MCP, and runtime
  authority composition;
- `@firegrid/cli` owns `@effect/cli` commands over host-sdk and client-sdk.

The runtime stays the execution substrate. It should not become an app import
path, and it must not import the SDK packages. The load-bearing code change is
one dependency inversion: the runtime ToolUse subscriber stops importing
`toolUseToEffect` directly and consumes a narrow `RuntimeToolUseExecutor`
capability instead.

The protocol package is already shaped correctly. The current client package
is close. The hard work is in runtime host and agent-tool boundaries.

## Changes

| Today | Target |
| --- | --- |
| `@firegrid/runtime/host` exports `FiregridLocalHostLive`, `RuntimeStartCapabilityLive`, and related host composition as public API. | `@firegrid/host-sdk` exports those surfaces, renamed where useful. Runtime stops being the product-app import path. |
| `packages/runtime/src/agent-tools/` mixes Effect AI `Tool.make` bindings, MCP listener setup, host capability service, scheduled prompt workflow, and `toolUseToEffect` execution. | Agent-tool bindings and MCP listener move to host-sdk. Runtime keeps only the committed ToolUse observation edge and invokes `RuntimeToolUseExecutor`. |
| `agent-event-pipeline/subscribers/tool-router.ts` imports `toolUseToEffect` directly. | `tool-router.ts` consumes `RuntimeToolUseExecutor`; host-sdk provides the live executor layer. |
| `packages/client/src/firegrid.ts` mixes schema decoding, transport, session handles, projection helpers, and Layer wiring. | Same package behavior, split into modules and published as `@firegrid/client-sdk`. |
| `src/run.ts` owns CLI parsing, launch substrate, `RuntimeContext` insertion, MCP injection, `startRuntime`, and process exit behavior. | `@firegrid/cli` owns command parsing and process behavior. Host composition comes from host-sdk; session operations come from client-sdk. |
| `verified-webhook-ingest/` is a tracer-era runtime table no live product uses. | Retired or moved later to an integration package if a real consumer appears. |

What does not change:

- `@firegrid/protocol` owns operation schemas, `firegridProjection`
  annotations, `FiregridClientOperations`, and `FiregridAgentToolOperations`.
- `@firegrid/runtime` keeps agent-event-pipeline, authorities,
  workflow-engine, durable-tools, codecs, and runtime-private host substrate.
- `RuntimeStartCapability` remains in `@firegrid/protocol/launch`.
- Durable row contracts do not migrate for this package split.

## Projection Contract

The protocol catalog is the source of truth. Each operation is a pair of Effect
Schemas annotated with `firegridProjection` metadata.

```ts
export const SessionCreateOrLoadInputSchema = Schema.Struct({
  externalKey: SessionExternalKeySchema,
  runtime: PublicLaunchRuntimeIntentSchema,
  createdBy: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.operation.session.createOrLoad.input",
  ...firegridProjection({
    operationId: "session.createOrLoad",
    clientName: "sessions.createOrLoad",
  }),
})
```

Bindings project this catalog into target environments:

```txt
@firegrid/protocol catalog
  schemas + firegridProjection annotations

  -> @firegrid/client-sdk
       TypeScript session methods
       sessions.createOrLoad(...)
       session.prompt(...)
       session.wait.forAgentOutput(...)

  -> @firegrid/host-sdk
       Effect AI Tool / Toolkit values
       route-scoped MCP exposure
       host capability services

  -> @firegrid/cli
       @effect/cli Command values
       flags, help, examples, process exit
```

The annotation already supplies the operation id and target binding names. Do
not introduce a second `OperationEntry` registry or a Firegrid graph DSL.

## Package Contracts

### `@firegrid/client-sdk`

Owns session-plane bindings projected from the protocol catalog. It is browser
and edge safe.

Public surface:

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  FiregridStandaloneLive,
  local,
  type FiregridSessionHandle,
} from "@firegrid/client-sdk"
```

`@firegrid/client-sdk` must not import `@firegrid/runtime`,
`@firegrid/host-sdk`, `@firegrid/cli`, `@effect/platform-node`,
`@effect/ai`, `@modelcontextprotocol/sdk`, or `node:*`.

This is the current `@firegrid/client` package, renamed and split internally.

### `@firegrid/host-sdk`

Owns host composition, runtime authority composition, agent-tool bindings, MCP
listener setup, provider implementations, and runtime start capability.

Public surface:

```ts
import {
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
  FiregridHostFromConfig,
  FiregridHostLive,
  FiregridMcpServerLayer,
  FiregridMcpServerListenerConfig,
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
  RuntimeStartCapabilityLive,
  RuntimeToolUseExecutorLive,
  type FiregridHostOptions,
} from "@firegrid/host-sdk"
```

Allowed imports: `@firegrid/protocol`, `@firegrid/runtime`, `@effect/ai`,
`@effect/platform-node`, and `@modelcontextprotocol/sdk`.

Forbidden imports: `@firegrid/client-sdk`, `@firegrid/cli`.

`FiregridHostLive` is the current `FiregridLocalHostLive` with host-plane
configuration made explicit. It accepts optional MCP listener config and
explicit provider installation. The deterministic host id derivation from
namespace stays for the local/default host shape. Multi-host topologies use the
lower-level topology variant that takes `hostId` directly. There is no cosmetic
`name` field in the host topology contract.

### `@firegrid/cli`

Owns `@effect/cli` command definitions, argv parsing, help text, examples,
local developer defaults, process exit behavior, and Node-only entrypoints.

Public surface:

```ts
import { firegrid } from "@firegrid/cli"
```

Allowed imports: `@firegrid/protocol`, `@firegrid/host-sdk`,
`@firegrid/client-sdk`, `@effect/cli`, and `@effect/platform-node`.

No package may import `@firegrid/cli`.

### `@firegrid/runtime`

Loses public host composition, `agent-tools/`, and
`verified-webhook-ingest/`.

Gains `RuntimeToolUseExecutor` as a runtime-owned capability tag consumed by
the ToolUse subscriber.

Keeps agent-event-pipeline, authorities, workflow-engine, durable-tools,
agent-adapters, and runtime-private host substrate.

## Decisions

1. **`sessions.createOrLoad` stays.** Do not rename it to `launch`. The
   current `externalKey` and `sessionContextIdForExternalKey` derivation are
   tested and honest: the caller binds a session to caller-owned identity.
   `idempotencyKey` is a worse spelling because it sounds like a retry option
   rather than the session identity input.

2. **`local.jsonl(...)` stays.** Do not introduce `Agent.localProcess(...)` as
   a second public spelling. The existing helper produces
   `PublicLaunchRuntimeIntent`, which is the durable protocol shape.

3. **Host provider config is host-plane; runtime intent is session-plane.**
   Agent provider choice, command, protocol, cwd, and env binding refs live in
   the `PublicLaunchRuntimeIntent` passed to `sessions.createOrLoad`. Provider
   implementation availability and env exposure policy live in host-sdk
   configuration.

4. **MCP defaults to disabled.** The host can opt into
   `FiregridMcpServerLayer`. The default Firegrid MCP declaration may be
   injected into launched agent configs only when that host layer is installed
   and the selected protocol supports MCP setup.

5. **`ScheduledInputWorkflow` moves to host-sdk.** It is a workflow that calls
   `AgentToolHost.appendScheduledPrompt`, so it belongs with host-plane
   tool execution.

6. **`agent-adapters/` stays in runtime.** The current adapters lower ACP or
   Effect AI model/session behavior into runtime byte/session substrate used by
   the pipeline. They are codec/runtime substrate, not public host
   composition.

7. **`verified-webhook-ingest/` retires.** No product imports it today. Its
   old wait integration depended on SourceCollections, which typed wait-source
   redesign removed.

## Load-Bearing Change: RuntimeToolUseExecutor

This is the structural inversion that makes the package split possible.
Everything else is file movement, renaming, or static enforcement.

Today, `agent-event-pipeline/subscribers/tool-router.ts` imports
`toolUseToEffect` from `../../agent-tools/`. That edge makes `agent-tools/`
unmovable: moving it to host-sdk would create a forbidden
`@firegrid/runtime -> @firegrid/host-sdk` dependency.

The target capability is:

```ts
export class RuntimeToolUseExecutor extends Context.Tag(
  "@firegrid/runtime/RuntimeToolUseExecutor",
)<RuntimeToolUseExecutor, {
  readonly execute: (input: {
    readonly context: RuntimeContext
    readonly activityAttempt: number
    readonly observation: RuntimeAgentOutputObservation
  }) => Effect.Effect<ToolResultEvent, never, Scope.Scope>
}>() {}
```

`tool-router.ts` changes from direct lowering:

```ts
const result = yield* toolUseToEffect({ contextId }, observation.event)
```

to capability execution:

```ts
const executor = yield* RuntimeToolUseExecutor
const result = yield* executor.execute({ context, activityAttempt, observation })
```

Host-sdk provides the live layer:

```ts
export const RuntimeToolUseExecutorLive = Layer.effect(
  RuntimeToolUseExecutor,
  Effect.gen(function* () {
    return {
      execute: ({ context, observation }) =>
        toolUseToEffect({ contextId: context.contextId }, observation.event),
    }
  }),
)
```

`toolUseToEffect` keeps its existing host-side requirements internally:
workflow engine, workflow instance, `AgentToolHost`, durable-tools, `Scope`,
and host authority surfaces. The executor service absorbs those requirements
in the host layer. Runtime sees only the narrow capability.

The runtime by itself no longer dispatches tool calls. A host that wants agent
tools provides `RuntimeToolUseExecutorLive` alongside the runtime substrate.

## Plane Split Rules

These rules must be enforced with dependency-cruiser, the existing client
boundary test, or a small static checker.

| Rule | Enforcement |
| --- | --- |
| `@firegrid/protocol` imports only allowed base libraries such as `effect` and `effect-durable-operators`. | dependency-cruiser allowed list |
| `@firegrid/runtime` does not import `@firegrid/client-sdk`, `@firegrid/host-sdk`, or `@firegrid/cli`. | dependency-cruiser |
| `@firegrid/client-sdk` does not import runtime, host-sdk, CLI, Node, Effect AI, MCP, or platform-node. | boundary test + dependency-cruiser |
| `@firegrid/host-sdk` does not import client-sdk or CLI. | dependency-cruiser |
| No package imports `@firegrid/cli`. | dependency-cruiser |
| Runtime ToolUse routing depends on `RuntimeToolUseExecutor`, not host-sdk agent-tool bindings. | dependency-cruiser + runtime tests |

## Plan

### PR 1: RuntimeToolUseExecutor Seam

Scope: behavior-preserving runtime inversion.

- Add `RuntimeToolUseExecutor` in
  `agent-event-pipeline/subscribers/tool-use-executor.ts`.
- Rewrite `tool-router.ts` to consume the capability.
- Add a temporary `RuntimeToolUseExecutorLive` in runtime host substrate that
  delegates to existing `toolUseToEffect`.
- Provide that layer from current host composition.
- Keep all runtime ToolUse tests green.

This PR satisfies `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1`,
`firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2`, and
`firegrid-host-sdk.TOOL_EXECUTOR_SEAM.3`.

### PR 2: Static Boundary Rules

Scope: enforcement before file movement.

- Add or extend dependency-cruiser rules for the package graph.
- Extend `packages/client/test/firegrid.boundary.test.ts` for the full client
  forbidden-import list.
- Add a rule that runtime ToolUse subscriber code cannot import host-sdk or
  agent-tool binding modules.

This PR satisfies `firegrid-host-sdk.PACKAGE_GRAPH.2` through
`firegrid-host-sdk.PACKAGE_GRAPH.7`.

### PR 3: Split Agent-Tool Roles In Place

Scope: role split under current runtime folder, no package moves yet.

```txt
packages/runtime/src/agent-tools/
  bindings/
    tools.ts
    mcp-host.ts
  execution/
    tool-use-to-effect.ts
    scheduled-input-workflow.ts
    tool-host.ts
    tool-error.ts
```

Bindings contain `Tool.make`, `Toolkit.make`, and MCP exposure. Execution
contains validated tool input to Effect execution over host/runtime
capabilities.

### PR 4: Create `@firegrid/host-sdk`

Scope: host-plane public package.

- Create `packages/host-sdk`.
- Move agent-tool bindings and execution into host-sdk.
- Move public host composition surfaces into host-sdk:
  `FiregridHostLive`, `FiregridHostFromConfig`,
  `FiregridHostWithTopologyLive`, `RuntimeStartCapabilityLive`, MCP listener,
  env resolver policy, local-process provider installation.
- Move `RuntimeToolUseExecutorLive` to host-sdk.
- Keep runtime-private substrate in runtime: workflow definitions, raw process
  activity, shared runtime observation substrate, and internal helpers.
- Delete runtime public `agent-tools/` and host public re-exports.

### PR 5: Rename And Split Client SDK

Scope: same behavior, public package name and internal modules.

- Rename `@firegrid/client` to `@firegrid/client-sdk`.
- Split `packages/client-sdk/src/firegrid.ts` into:
  - `bindings/sessions.ts`;
  - `bindings/permissions.ts`;
  - `bindings/operations.ts`;
  - `transport/control-plane.ts`;
  - `transport/host-owned-streams.ts`;
  - `firegrid.ts` assembled service.
- Keep `sessions.createOrLoad`, `externalKey`, `local.jsonl(...)`, typed waits,
  and permission response behavior unchanged.

### PR 6: Create `@firegrid/cli` And Retire Tracer Surface

Scope: command binding package.

- Create `packages/cli` with `@effect/cli` command definitions projected from
  protocol schemas.
- Replace root `src/run.ts` with the CLI package entrypoint.
- Preserve `pnpm firegrid -- run` and `pnpm firegrid -- start` behavior through
  tests.
- Retire `packages/runtime/src/verified-webhook-ingest/` and its tracer
  scenario test, unless a real product consumer appears before this PR.

### PR 7: Consumer Cutover

Scope: apps and scenario imports.

- Move factory imports from runtime host paths to `@firegrid/host-sdk`.
- Move factory imports from `@firegrid/client` to `@firegrid/client-sdk`.
- Update scenario tests to new public package names.
- Keep root CLI compatibility tests green.

## Acceptance

- Dependency-cruiser reports zero SDK boundary violations.
- Runtime no longer exports public `host/` or `agent-tools/` surfaces.
- Runtime ToolUse router consumes `RuntimeToolUseExecutor`.
- Client-sdk passes its browser/edge boundary test.
- Host-sdk exports `FiregridHostLive`, `FiregridAgentToolkit`,
  `FiregridMcpServerLayer`, `RuntimeStartCapabilityLive`, and
  `RuntimeToolUseExecutorLive`.
- CLI exposes `sessions create-or-load`, `sessions attach`,
  `sessions prompt`, `permissions respond`, `run`, and `start` commands
  projected from protocol schemas.
- Factory imports only host-sdk, client-sdk, protocol shared types, integration
  packages, and app-owned modules for normal Firegrid behavior.
- `verified-webhook-ingest/` is gone or explicitly moved to a real integration
  package with a product consumer.
- Existing `pnpm firegrid -- run` and `pnpm firegrid -- start` scenario tests
  pass.

## Non-Goals

- No new operation contracts.
- No durable row migrations.
- No replacement for SourceCollections; typed wait-source redesign already
  retired it.
- No dynamic provider registry. Providers are explicit Layers at the
  composition root.
- No Firegrid-specific workflow DSL or operator framework.
- No second event pipeline.
- No browser-originated runtime authority.

## Risks

| Risk | Mitigation |
| --- | --- |
| The executor inversion hides requirement-channel mismatches from `toolUseToEffect`. | Build `RuntimeToolUseExecutorLive` exactly where host composition already provides workflow, durable-tools, `AgentToolHost`, and scope. The existing runtime codec tool lowering layer is the template. |
| Moving `AgentToolHost` breaks runtime code that references its tag. | Audit before PR 4. If runtime must name the service, keep the tag in protocol or a runtime-neutral contract module and move only the live layer to host-sdk. |
| CLI cutover drops a current `src/run.ts` option. | Snapshot current CLI help and scenario behavior before PR 6; diff new CLI output against the snapshot. |
| External consumers import old package names. | New packages publish at new names. Old package paths can ship a deprecation shim for one release if needed, but internal implementation should move to the target packages. |

## Appendix: File Ownership

```txt
@firegrid/runtime
  agent-event-pipeline/
    authorities/
    codecs/
    events/
    sources/
    subscribers/
      tool-router.ts
      tool-use-executor.ts
    transforms/
    session-runtime.ts
  agent-adapters/
  authorities/
  durable-tools/
  workflow-engine/
  host/
    runtime-context-workflow.ts
    raw-process-runtime.ts
    runtime-substrate.ts
    internal/

@firegrid/host-sdk
  agent-tools/
    bindings/
      tools.ts
      mcp-host.ts
    execution/
      tool-use-to-effect.ts
      scheduled-input-workflow.ts
      tool-host.ts
      tool-error.ts
    runtime-tool-use-executor.ts
  host/
    layers.ts
    commands.ts
    config-live.ts
    sync-run.ts
    agent-tool-host-live.ts

@firegrid/client-sdk
  bindings/
    sessions.ts
    permissions.ts
    operations.ts
  transport/
    control-plane.ts
    host-owned-streams.ts
  firegrid.ts

@firegrid/cli
  commands/
    sessions.ts
    permissions.ts
    run.ts
    start.ts
  main.ts

Retired
  packages/runtime/src/verified-webhook-ingest/
  scenarios/firegrid/test/tracer-020-verified-webhook-ingest.test.ts
  src/run.ts
```
