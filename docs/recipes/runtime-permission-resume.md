# Runtime Permission Resume

Use this recipe when an ACP-speaking runtime process calls
`requestPermission` and your application needs to durably approve, deny, or
cancel that request.

The supported path is:

1. Launch or start a `RuntimeContext` whose runtime config uses the ACP agent
   protocol.
2. The ACP process calls `requestPermission`.
3. `AcpCodec` emits a normalized `AgentOutputEvent` with `_tag:
   "PermissionRequest"`.
4. Runtime host journals that output as a runtime agent-output observation.
5. Your app or agent uses `wait_for` over
   `RuntimeObservationSourceNames.agentOutputEvents` to observe the
   `PermissionRequest`.
6. Your app decides and appends a `RuntimeIngress` control row whose payload is
   the normalized `AgentInputEvent` `_tag: "PermissionResponse"`.
7. Runtime host delivers the ingress row to the codec, and `AcpCodec` resolves
   the pending ACP permission request back to the agent process.

## Durable Primitives

- `RuntimeObservationSourceNames.agentOutputEvents`: the registered `wait_for`
  source for decoded agent-output observations, including permission requests.
- `RuntimeOutputTable.events`: the underlying durable output table. Runtime
  host writes codec output here before the observation source projects it.
- `RuntimeIngressTable.inputs`: durable input plane for the response.
- `appendRuntimeIngress`: the append helper that resolves `RuntimeContext.host`
  and writes to the owner host ingress stream.
- `AgentOutputEventSchema` / `AgentInputEventSchema`: the normalized codec
  event contract used for the output row and response payload.

## TypeScript Flow

This is intentionally TypeScript-ish. In a runtime host or workflow scope that
already provides durable tools, observe permission requests with `wait_for`:

```ts
import { Effect, Fiber, Schema } from "effect"
import { WaitFor } from "@firegrid/runtime/durable-tools"
import {
  appendRuntimeIngress,
  RuntimeObservationSourceNames,
  startRuntime,
} from "@firegrid/runtime/runtime-host"

const PermissionObservationSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  event: Schema.Unknown,
})
type PermissionObservation = Schema.Schema.Type<typeof PermissionObservationSchema>

const runtimeFiber = yield* startRuntime({ contextId }).pipe(Effect.fork)

const outcome = yield* WaitFor.match<PermissionObservation>({
  name: `permission-request:${contextId}:tool-permission`,
  source: RuntimeObservationSourceNames.agentOutputEvents,
  trigger: [
    { path: ["contextId"], equals: contextId },
    { path: ["_tag"], equals: "PermissionRequest" },
    { path: ["toolUseId"], equals: "tool-permission" },
  ],
  resultSchema: PermissionObservationSchema,
  timeoutMs: 300_000,
})

if (outcome._tag !== "Match") {
  return yield* Effect.fail(new Error("permission request timed out"))
}

const permission = outcome.row

yield* appendRuntimeIngress({
  contextId,
  kind: "control",
  authoredBy: "app",
  payload: {
    _tag: "PermissionResponse",
    permissionRequestId: permission.permissionRequestId,
    decision: { _tag: "Allow", optionId: "allow" },
  },
  idempotencyKey: `permission-response:${contextId}:${permission.permissionRequestId}`,
})

const result = yield* Fiber.join(runtimeFiber)
```

`decision` may also be `{ _tag: "Deny" }` or `{ _tag: "Cancelled" }`, matching
the normalized `AgentInputEventSchema`.

If you are driving this through the `wait_for` agent tool instead of calling
`WaitFor.match` directly, use the same source name and predicates in the tool
input:

```ts
{
  eventQuery: {
    stream: RuntimeObservationSourceNames.agentOutputEvents,
    whereFields: {
      contextId,
      _tag: "PermissionRequest",
      toolUseId: "tool-permission",
    },
  },
}
```

## Backing Evidence

The runtime observation source proof lives in
[`packages/runtime/test/host/runtime-observation-sources.test.ts`](../../packages/runtime/test/host/runtime-observation-sources.test.ts):

- Lines 84-155 prove `wait_for` can observe a runtime
  `PermissionRequest` through `RuntimeObservationSourceNames.agentOutputEvents`
  by matching `contextId`, `_tag`, and `permissionRequestId`.

The end-to-end resume proof lives in
[`packages/runtime/test/host/runtime-codec-event-plane.test.ts`](../../packages/runtime/test/host/runtime-codec-event-plane.test.ts):

- Lines 255-359 prove ACP `requestPermission` becomes durable runtime output,
  then a `RuntimeIngress` `PermissionResponse` resumes the agent and the turn
  terminates deterministically.

The supporting implementation is:

- [`packages/runtime/src/source-registration/runtime-output.ts`](../../packages/runtime/src/source-registration/runtime-output.ts)
  registers `RuntimeObservationSourceNames.agentOutputEvents` from the
  `RuntimeAgentOutputEvents` stream capability.
- [`packages/runtime/src/agent-event-pipeline/events/output.ts`](../../packages/runtime/src/agent-event-pipeline/events/output.ts)
  projects decoded agent-output rows with flattened permission fields.
- [`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`](../../packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts)
  emits `PermissionRequest` and waits.
- [`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`](../../packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts)
  accepts `PermissionResponse` and resolves the
  pending ACP request.
- [`packages/runtime/src/host/raw-process-runtime.ts`](../../packages/runtime/src/host/raw-process-runtime.ts):
  runtime host encodes `AgentOutputEvent` rows into
  `RuntimeOutputTable.events`.
- [`packages/runtime/src/host/raw-process-runtime.ts`](../../packages/runtime/src/host/raw-process-runtime.ts):
  runtime host decodes canonical
  `AgentInputEvent` ingress and delivers it to `session.send`.

## Do Not Reimplement

Do not add an ACP-specific permission table, permission fact table, callback
registry, or hidden permission transport for this path. For ACP runtime
permissions, the durable contract is already the runtime codec event plane:
observe `RuntimeObservationSourceNames.agentOutputEvents`, append
`RuntimeIngress`, and let `AcpCodec` resume the agent protocol request.
