# Runtime Permission Resume

Audience: app/agent authors handling an ACP-speaking agent's
`requestPermission` call.

**TL;DR — same channel target every observation uses.** The
`PermissionRequest` event flows on `session.agent_output` (the typed
ingress every other observation uses); the response is a `call` on
`host.permissions.respond`. No permission-specific channel, no
permission-specific table, no permission-specific source name.

## The flow

```txt
ACP process calls requestPermission
  → AcpCodec emits AgentOutputEvent { _tag: "PermissionRequest", ... }
    → host journals into RuntimeOutputTable.events
      → session.agent_output IngressChannel projection
        → handle.wait.forPermissionRequest({ afterSequence })
          (= wait_for on session.agent_output, predicate-filtered)
            → app decides allow / deny / cancel
              → handle.permissions.respond({ permissionRequestId, decision })
                (= call on host.permissions.respond)
                  → runtime delivers PermissionResponse ingress
                    → AcpCodec resolves the pending ACP request
                      → agent continues
```

## Public client surface (recommended)

For 95% of cases use the public client surface — it lowers to the
channel router for you. The dispatch contract is documented at
[client-sdk-channel-targets.md](client-sdk-channel-targets.md).

```ts
import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const firegrid = yield* Firegrid
  const handle = yield* firegrid.sessions.attach({ sessionId })

  // 1. Observe the PermissionRequest on session.agent_output.
  //    Public method is predicate-filtered — production
  //    `waitForPermissionRequest` reuses `waitForAgentOutputObservation`.
  const observation = yield* handle.wait.forPermissionRequest({
    afterSequence,
  })

  // 2. Decide.
  const decision = await decidePermission(observation)

  // 3. Respond via host.permissions.respond (call). The handle bakes
  //    contextId in; the top-level `client.permissions.respond` is the
  //    same target, different binding.
  yield* handle.permissions.respond({
    permissionRequestId: observation.permissionRequestId,
    decision,
  })
})
```

Decisions match the normalized `AgentInputEventSchema`:

- `{ _tag: "Allow", optionId: "allow" }`
- `{ _tag: "Deny" }`
- `{ _tag: "Cancelled" }`

The `optionId` corresponds to the option the ACP provider offered;
"allow" is the conventional default for single-option requests.

## Auto-approve helper

For tests, dev hosts, or background daemons that want a blanket
auto-approve policy:

```ts
yield* handle.permissions.autoApprove(
  (request) => Effect.succeed({ _tag: "Allow", optionId: "allow" }),
)
```

The helper subscribes to `forPermissionRequest`, dispatches the
policy, and posts the response through `host.permissions.respond` —
all the same channel targets, just wrapped.

## Router-direct (when you don't have a handle)

If you're working below the client SDK (e.g. you have a `RuntimeChannelRouter`
in scope but no `Firegrid` instance), dispatch the same targets directly:

```ts
import {
  HostPermissionRespondChannel,
  SessionAgentOutputChannel,
} from "@firegrid/protocol/channels"

const program = Effect.gen(function*() {
  // Observe — `wait_for` on session.agent_output, filter for PermissionRequest
  const sessionAgentOutput = yield* SessionAgentOutputChannel
  const stream = sessionAgentOutput.forContext(contextId).binding.stream
  const observation = yield* stream.pipe(
    Stream.filter((obs) => obs._tag === "PermissionRequest"),
    Stream.runHead,
  )

  // Respond — `call` on host.permissions.respond
  const respond = yield* HostPermissionRespondChannel
  yield* respond.binding.call({
    contextId,
    permissionRequestId: observation.permissionRequestId,
    decision: { _tag: "Allow", optionId: "allow" },
  })
})
```

## Ground Truth

| Concern | Path |
| --- | --- |
| Public client API | `packages/client-sdk/src/firegrid.ts` — `FiregridSessionWaitClient.forPermissionRequest`, `FiregridSessionPermissionsClient.respond` |
| Wait predicate | `firegrid.ts:waitForPermissionRequest` — calls `waitForAgentOutputObservation` with `isPermissionRequest` predicate |
| Channel target (observe) | `SessionAgentOutputChannel` — `packages/protocol/src/channels/session-agent-output.ts` |
| Channel target (respond) | `HostPermissionRespondChannel` — `packages/protocol/src/channels/host-control.ts` |
| Codec | `packages/runtime/src/sources/codecs/acp/index.ts` — emits `PermissionRequest`, awaits `PermissionResponse` |
| Output journaling | `packages/runtime/src/tables/runtime-output.ts` — `RuntimeOutputTable.events` |
| Response delivery | `composition/host-public.ts:appendRuntimeIngress` (today) — durable input plane that delivers `PermissionResponse` to the codec |
| Normalized events | `packages/protocol/src/agent-output/schema.ts` (`PermissionRequest`), `packages/protocol/src/agent-input/schema.ts` (`PermissionResponse`) |

## What changed from prior recipes

Earlier drafts of this recipe pointed at `@firegrid/runtime/durable-tools`
(retired), `RuntimeObservationSourceNames.agentOutputEvents` (retired
constant), and `WaitFor.match` over a string source registry (retired
`SourceCollections` API). The current recipe routes through the channel
router via either the client SDK's `forPermissionRequest` /
`permissions.respond` methods or direct dispatch on the same channel
targets. All the prior paths reduced to the same two channels —
`session.agent_output` for observation, `host.permissions.respond` for
the response — so the current shape is a strict simplification, not a
new contract.

## Do Not Reimplement

- **No permission-specific channel target.** The `PermissionRequest`
  variant rides on `session.agent_output`. There is no
  `session.permission_request` route in production — predicate-filtered
  observation on the typed source union is the contract. The
  `SessionPermissionChannel` (`packages/protocol/src/channels/session-permission.ts`)
  exists but the production client does NOT use it on the public turn.
- **No permission-specific table.** `RuntimeOutputTable.events` carries
  the typed event; the predicate filters at the observation layer.
- **No ACP-specific transport.** The runtime codec event plane is the
  durable contract. Observe → respond → resume.
- **No callback registry, no `DurableDeferred` mailbox.** The pending
  ACP request is held inside the codec for the duration of the response
  trip; the durable rendezvous is event-id-keyed (`permissionRequestId`),
  same shape as the RuntimeContext fact matrix's
  `permission_response` correlation (see
  [`docs/architecture/runtime-context-fact-matrix.md`](../architecture/runtime-context-fact-matrix.md)).

## Related

- [Client SDK ↔ channel targets](client-sdk-channel-targets.md) —
  the dispatch contract `wait.forPermissionRequest` and
  `permissions.respond` lower to.
- [RuntimeContext fact matrix](../architecture/runtime-context-fact-matrix.md)
  — `permission_response` is one of the sparse fact kinds that drives
  RuntimeContext state.
- [Agent-to-agent observation](agent-to-agent-observation.md) — same
  cursor + predicate pattern, different concern.
