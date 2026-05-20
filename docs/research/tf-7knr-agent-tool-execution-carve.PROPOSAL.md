# tf-7knr Agent Tool Execution Carve Proposal

Status: WIP proposal for coordinator/Gurdas review

Date: 2026-05-20

## Verdict

PROPOSAL-ONLY: split `packages/host-sdk/src/agent-tools/execution` into a
host-sdk binding adapter plus runtime-owned validated execution services. Do
not move every arm in one PR. The first implementation slice should move one
small execution arm after this carve is accepted.

Canonical source read first:
`docs/architecture/host-sdk-runtime-boundary.md`.

## Boundary Rule Applied

The canonical boundary is:

```text
protocol schemas -> host/client/CLI bindings -> runtime execution substrate
```

For agent tools this means:

- host-sdk keeps MCP exposure, Effect AI `Tool` / `Toolkit` binding,
  protocol input decode, `ToolResult` adaptation, route/context lookup, and
  host composition helpers.
- runtime owns validated operation execution when the operation touches
  workflow engine services, durable clocks/streams, provider adapters, runtime
  authorities, or workflow definitions.
- runtime must not import host-sdk. Any host-specific callback pressure is
  inverted through a runtime-owned `Context.Tag` with a host-sdk-provided Live
  Layer. `RuntimeToolUseExecutor` is the existing canonical pattern.

This proposal intentionally does not relocate workflow definitions. Lane 4
(`tf-rvt5`) owns that work. This lane only carves validated operation execution.

## Current Inventory

| File | Current role | Substrate dependencies today | Consumers | Boundary decision |
| --- | --- | --- | --- | --- |
| `execution/index.ts` | Public barrel for execution internals. Exports `AgentToolHost`, `toolUseToEffect`, `FiregridAgentToolkitLayer`, `ToolCallWorkflow`, `ToolCallWorkflowLayer`. | Transitive workflow, channel registry, host callback, toolkit binding. | Host-sdk public export, tiny-firegrid sims. | Split export surface. Keep binding adapter exports only as host-sdk internals; move workflow-definition exports to runtime with Lane 4. |
| `execution/tool-host.ts` | Host-coupled callback seam for spawn/session/provider/approval operations. | Types from protocol, runtime events, host-local error ADT. Live implementation is `host/agent-tool-host-live.ts`. | `tool-use-to-effect.ts`, runtime workflow support, commands, tests, sims. | Replace as execution seam with runtime-owned callback tags. Host-sdk provides Live Layers from host topology. |
| `execution/tool-use-to-effect.ts` | Monolithic `ToolUse` -> `ToolResult` lowering. Decodes protocol schemas, dispatches by tool name, executes each arm, catches failures. | `DurableClock`, `WorkflowEngine`, `ChannelRegistry`, stream waits, durable-tool predicate helper, `AgentToolHost`. | `RuntimeToolUseExecutorLive`, `ToolCallWorkflowLayer`, tests. | Shrink to binding adapter: decode input, call runtime execution service, map runtime error to `ToolError`, encode `ToolResult`. Move validated arm execution below line. |
| `execution/toolkit-layer.ts` | Effect AI Toolkit handler plus host-scoped per-tool-call workflow wiring. Defines `ToolCallWorkflow` so tool calls run under a workflow instance. | `Workflow.make`, `Workflow.toLayer`, `RuntimeContextWorkflowRuntime`, observation substrate, `AgentToolHost`, `ChannelRegistry`. | `mcp-host.ts`, toolkit tests, host integration tests. | Keep Toolkit/MCP handler in host-sdk. Move `ToolCallWorkflow` definition/support below line with Lane 4. Handler should call runtime-owned tool-call execution workflow/service through host composition. |

## Reverse Dependencies

`toolUseToEffect` is reached in two production paths:

- `packages/host-sdk/src/host/runtime-substrate.ts` provides the
  runtime-owned `RuntimeToolUseExecutor` tag. Its Live implementation currently
  captures host substrate and re-provides workflow engine, workflow instance,
  and scope into `toolUseToEffect`.
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` defines
  `ToolCallWorkflow` for MCP/Effect-AI calls and invokes `toolUseToEffect`
  inside that workflow.

`AgentToolHost` is consumed by `tool-use-to-effect.ts`, host command/control
surfaces, workflow support layers, tests, and tiny-firegrid simulations. Its
Live implementation lives in `packages/host-sdk/src/host/agent-tool-host-live.ts`
and already proves the dependency-inversion shape, but the tag itself is
currently host-sdk-owned and therefore is not a valid runtime dependency.

## Proposed Runtime-Owned Service Tags

### `RuntimeAgentToolExecution`

Runtime-owned service for validated protocol operations:

```ts
export interface RuntimeAgentToolExecutionService {
  readonly sleep: (
    params: RuntimeToolExecutionContext & { readonly input: SleepToolInput },
  ) => Effect.Effect<SleepToolOutput, RuntimeAgentToolExecutionError>

  readonly waitFor: (
    params: RuntimeToolExecutionContext & { readonly input: WaitForToolInput },
  ) => Effect.Effect<WaitForToolOutput, RuntimeAgentToolExecutionError>

  readonly waitForAny: (
    params: RuntimeToolExecutionContext & { readonly input: WaitForAnyToolInput },
  ) => Effect.Effect<WaitForAnyToolOutput, RuntimeAgentToolExecutionError>

  readonly send: (
    params: RuntimeToolExecutionContext & { readonly input: SendToolInput },
  ) => Effect.Effect<SendToolOutput, RuntimeAgentToolExecutionError>

  readonly call: (
    params: RuntimeToolExecutionContext & { readonly input: CallToolInput },
  ) => Effect.Effect<CallToolOutput, RuntimeAgentToolExecutionError>

  readonly spawn: (
    params: RuntimeToolExecutionContext & { readonly input: SpawnToolInput },
  ) => Effect.Effect<SpawnToolOutput, RuntimeAgentToolExecutionError>

  readonly spawnAll: (
    params: RuntimeToolExecutionContext & { readonly input: SpawnAllToolInput },
  ) => Effect.Effect<SpawnAllToolOutput, RuntimeAgentToolExecutionError>

  readonly sessionNew: (
    params: RuntimeToolExecutionContext & { readonly input: SessionNewToolInput },
  ) => Effect.Effect<SessionNewToolOutput, RuntimeAgentToolExecutionError>

  readonly sessionPrompt: (
    params: RuntimeToolExecutionContext & { readonly input: SessionPromptToolInput },
  ) => Effect.Effect<SessionPromptToolOutput, RuntimeAgentToolExecutionError>

  readonly sessionCancel: (
    params: RuntimeToolExecutionContext & { readonly input: SessionCancelToolInput },
  ) => Effect.Effect<SessionCancelToolOutput, RuntimeAgentToolExecutionError>

  readonly sessionClose: (
    params: RuntimeToolExecutionContext & { readonly input: SessionCloseToolInput },
  ) => Effect.Effect<SessionCloseToolOutput, RuntimeAgentToolExecutionError>

  readonly scheduleMe: (
    params: RuntimeToolExecutionContext & { readonly input: ScheduleMeToolInput },
  ) => Effect.Effect<ScheduleMeToolOutput, RuntimeAgentToolExecutionError>

  readonly execute: (
    params: RuntimeToolExecutionContext & { readonly input: ExecuteToolInput },
  ) => Effect.Effect<ExecuteToolOutput, RuntimeAgentToolExecutionError>
}
```

`RuntimeToolExecutionContext` should be deliberately small:

```ts
export interface RuntimeToolExecutionContext {
  readonly contextId: string
  readonly toolUseId: string
}
```

Reason for method-per-tool rather than a monolithic dispatcher: host-sdk already
has the protocol-name switch for decode and `ToolResult` adaptation. Keeping
runtime methods typed preserves schema-to-arm coupling and avoids a second
stringly dispatcher below the line.

### `RuntimeAgentToolExecutionError`

Runtime should not import `host-sdk`'s `ToolError`. Add a runtime-owned error
ADT, then let host-sdk map it to the existing binding error shape:

```ts
type RuntimeAgentToolExecutionError =
  | { readonly _tag: "InvalidToolInput"; readonly reason: string; readonly cause?: unknown }
  | { readonly _tag: "ToolExecutionFailed"; readonly cause: unknown }
  | { readonly _tag: "UnsupportedTool"; readonly reason: string }
```

If the error shape becomes a stable cross-binding contract, graduate it to
`@firegrid/protocol`. Until then runtime ownership is enough to keep import
direction correct.

### Runtime-Owned Callback Tags

`AgentToolHost` should be split into runtime-owned capabilities. Host-sdk
provides the Live Layers from the current host topology.

Proposed tags:

- `RuntimeAgentSessionOperations`: child context spawn, spawn-all, session
  creation, prompt append, cancel, close.
- `RuntimeAgentToolProviderExecution`: sandbox provider execution and
  session-bound capability execution.
- `RuntimeAgentApprovalCalls`: approval-channel fallback for `call`.
- `RuntimeAgentChannelOperations`: transitional string-channel resolution for
  `wait_for`, `wait_for_any`, `send`, and registered `call`.

`RuntimeAgentChannelOperations` is intentionally transitional. The canonical
doc says `tf-kddg` should delete central `ChannelRegistry` architecture in
favor of per-channel tags/layers. Until that lands, host-sdk can provide a
runtime-owned channel-operations tag backed by today's `ChannelRegistry`.
Runtime code then depends on the runtime tag, not on
`packages/host-sdk/src/host/channel-registry.ts`.

## Target `tool-use-to-effect.ts` Shape

`tool-use-to-effect.ts` should keep only binding responsibilities:

1. receive `{ contextId }` plus `ToolUse` event;
2. switch on `event.part.name`;
3. decode `event.part.params` with `@firegrid/protocol/agent-tools` schemas;
4. call `RuntimeAgentToolExecution` with `{ contextId, toolUseId, input }`;
5. map `RuntimeAgentToolExecutionError` to current `ToolError`;
6. wrap success/failure as the existing `ToolResult` shape.

Sketch:

```ts
const runValidated = <I, Encoded, O>(
  event: ToolUseEvent,
  toolName: string,
  schema: Schema.Schema<I, Encoded>,
  execute: (
    svc: RuntimeAgentToolExecutionService,
    input: I,
  ) => Effect.Effect<O, RuntimeAgentToolExecutionError>,
) =>
  Schema.decodeUnknown(schema)(event.part.params).pipe(
    Effect.flatMap(input =>
      RuntimeAgentToolExecution.pipe(
        Effect.flatMap(service => execute(service, input)),
      ),
    ),
    Effect.map(output => toolResult(event.part.id, toolName, output)),
    Effect.catchAll(error =>
      Effect.succeed(toolErrorResult(toToolError(event.part.id, toolName, error))),
    ),
  )
```

The host-sdk adapter does not directly import or use `DurableClock`,
`WorkflowEngine`, `Stream.runHead`, provider adapters, or runtime durable
authorities after the split.

## Arm Carve

| Tool arm | Current execution dependency | Runtime service home | Host-sdk remains responsible for |
| --- | --- | --- | --- |
| `sleep` | `DurableClock.sleep`, workflow instance. | `RuntimeAgentToolExecution.sleep`. Runtime implementation can use `DurableClock` directly. | Decode `SleepToolInput`; map `{ slept: true }` into `ToolResult`. |
| `wait_for` | `ChannelRegistry`, stream filter/runHead, timeout. | `RuntimeAgentToolExecution.waitFor`. Transitional implementation requires `RuntimeAgentChannelOperations`; final implementation should use channel tags or engine-native wait primitive. | Decode input and preserve existing output/error shape. |
| `wait_for_any` | Host-side race across channel waits. | `RuntimeAgentToolExecution.waitForAny`. Use runtime wait primitive / channel operations; no host-side race. | Decode descriptors and encode result. |
| `send` | `ChannelRegistry` egress lookup and schema decode/append. | Transitional `RuntimeAgentToolExecution.send` over `RuntimeAgentChannelOperations`; final channel tag after `tf-kddg`. | Decode protocol input. |
| `call` | Registered callable channel or approval fallback through `AgentToolHost`. | `RuntimeAgentToolExecution.call`; registered call via channel operations, approval fallback via `RuntimeAgentApprovalCalls`. | Decode protocol input; keep public `ToolResult`. |
| `spawn`, `spawn_all`, `session_new` | `AgentToolHost` child workflow/session operations. | `RuntimeAgentToolExecution.spawn*` using `RuntimeAgentSessionOperations`. | Decode and adapt outputs. |
| `session_prompt`, `session_cancel`, `session_close` | `AgentToolHost` session operations. | `RuntimeAgentToolExecution.session*` using `RuntimeAgentSessionOperations`. | Decode and adapt outputs. |
| `schedule_me` | `DurableClock.sleep` plus `AgentToolHost.appendSessionPrompt`. | Runtime service does durable delay, then calls `RuntimeAgentSessionOperations.appendPrompt`. | Decode and adapt `{ scheduled: true }`. |
| `execute` | `AgentToolHost.executeSandboxTool` or session capability. | Runtime service dispatches through `RuntimeAgentToolProviderExecution`. Host-sdk Live supplies provider/session implementation. | Decode neutral protocol input and preserve output shape. |

## Host-SDK Live Layers

Host-sdk should provide narrow Live Layers for runtime-owned tags:

- `RuntimeAgentToolExecutionLive` may be runtime-owned when it only composes
  runtime services. If it needs current host topology during transition, expose
  `HostRuntimeAgentToolExecutionLive` from host-sdk as a provider for the
  runtime-owned tag.
- `RuntimeAgentSessionOperationsLive` in host-sdk adapts today's
  `RuntimeHostAgentToolHostLive` behavior without exposing a host-sdk tag to
  runtime.
- `RuntimeAgentToolProviderExecutionLive` in host-sdk adapts `SandboxProvider`
  and session capability dispatch.
- `RuntimeAgentApprovalCallsLive` in host-sdk adapts approval channel behavior.
- `RuntimeAgentChannelOperationsLive` in host-sdk adapts current
  `ChannelRegistry` until `tf-kddg` replaces it.

The important rule is ownership of the tag, not necessarily the first Live
implementation. Runtime can require the tag. Host-sdk can provide it.

## Suggested Implementation Sequence

1. Add runtime-owned tag skeletons and error ADT under a sanctioned runtime
   subpath such as `@firegrid/runtime/agent-tool-execution` or
   `@firegrid/runtime/tool-executor`.
2. Move the `sleep` arm first. It is the smallest validation slice because it
   uses only `DurableClock` and workflow instance services.
3. Move `schedule_me` second to prove a mixed runtime-substrate plus
   host-callback arm through `RuntimeAgentSessionOperations`.
4. Move `execute` and session/spawn arms after the callback tags settle.
5. Move `wait_for`, `wait_for_any`, `send`, and registered `call` after or
   alongside the channel Tag/Layer migration. Before `tf-kddg` lands, use only
   the transitional `RuntimeAgentChannelOperations` tag to avoid importing
   `ChannelRegistry` from runtime.
6. After the execution split, let Lane 4 move `ToolCallWorkflow` and other
   workflow definitions below the binding line.

Do not use PR #489's shape of bridging more substrate into host-sdk. That keeps
the execution core in the wrong package and repeats the dependency direction
problem this boundary framing is meant to solve.

## Test Migration Plan

Existing high-value tests in
`packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts` should stay as
binding-contract tests, but their fakes should become `RuntimeAgentToolExecution`
fakes instead of `AgentToolHost` plus channel/workflow substrate.

Add runtime tests next to the runtime service implementation for each moved
arm:

- `sleep`: verifies durable sleep invocation and output.
- `schedule_me`: verifies durable delay plus prompt callback through runtime
  session operations.
- `wait_for` / `wait_for_any`: verifies channel-operation behavior and timeout
  semantics under the accepted runtime primitive.
- `execute`: verifies provider/session callback inversion without importing
  host-sdk.

Dependency guardrail to add after the first code slice:

- runtime execution modules must not import `packages/host-sdk` or
  `@firegrid/host-sdk`;
- host-sdk binding adapter may import only runtime public capability subpaths,
  not runtime internals.

## Open Review Questions

1. Should `RuntimeAgentToolExecution` live beside
   `RuntimeToolUseExecutor` under `@firegrid/runtime/tool-executor`, or under a
   new `@firegrid/runtime/agent-tool-execution` subpath?
2. Should `RuntimeAgentToolExecutionError` start in runtime, or should it be
   protocol-owned immediately because client/CLI bindings will eventually need
   the same error vocabulary?
3. Should the first slice move only `sleep`, or should it also introduce the
   callback tags by moving `schedule_me` in the same PR? This proposal
   recommends `sleep` only for the first implementation slice.
4. Should `RuntimeAgentChannelOperations` exist as a temporary bridge, or should
   all channel-backed arms wait until `tf-kddg` lands?

## Non-Scope For This PR

- No edit to `tool-use-to-effect.ts` yet.
- No move of `ToolCallWorkflow`, `WaitForWorkflow`, or runtime-context workflow
  definitions. Lane 4 owns workflow definitions.
- No runtime import of host-sdk.
- No edits under `repos/`.
- No `.beads/issues.jsonl` modification.
