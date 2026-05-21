# tf-c8cy Host-Plane Cancel Route Finding

## Verdict

The durable cancellation substrate exists, but the host-plane router does not
currently expose a cancellation primitive for ACP stdio edge routing. The
remaining question is architectural: either lifecycle cancel becomes a routed
host-plane command, or ACP cancel must intentionally append the existing durable
lifecycle row through a mechanism below the router.

This finding blocks `tf-8aw5` and `tf-rqyh` until the SDD decision is made.

## Existing Durable Cancel Plumbing

`packages/protocol/src/launch/control-request.ts` defines session lifecycle
terminate requests as durable control-plane rows:

- `runtimeCancelRequestId(contextId)` produces `req_cancel_<context>` at
  `packages/protocol/src/launch/control-request.ts:64`.
- `RuntimeLifecycleRequestRowSchema` carries
  `lifecycle: "cancel" | "close"` at
  `packages/protocol/src/launch/control-request.ts:136`.
- Its description says it is a client/host-written durable request to cancel or
  close a RuntimeContext, claimed by the host and not a synchronous result at
  `packages/protocol/src/launch/control-request.ts:149`.
- `makeRuntimeLifecycleRequestRow` selects the cancel request id when
  `input.lifecycle === "cancel"` at
  `packages/protocol/src/launch/control-request.ts:284`.

`packages/host-sdk/src/host/agent-tool-host-live.ts` already uses that durable
path for the `session_cancel` agent tool:

- `cancelSession` calls `appendCommittedLifecycleRequest(...)` with
  `lifecycle: "cancel"` at
  `packages/host-sdk/src/host/agent-tool-host-live.ts:381`.
- The helper writes through a `RuntimeControlPlaneTable` bound to the same
  control-plane stream URL the reconciler reads at
  `packages/host-sdk/src/host/agent-tool-host-live.ts:453`.
- It constructs `makeRuntimeLifecycleRequestRow({ lifecycle })` and appends it
  into `table.lifecycleRequests.insertOrGet(row)` at
  `packages/host-sdk/src/host/agent-tool-host-live.ts:471`.

So cancellation has a durable representation and at least one production
append-site.

## What The Host-Plane Router Does Not Route

`RuntimeHostControlChannelsLive` builds the host-plane router from these routes:

- `HostContextsCreateChannel`
- `HostPromptChannel`
- `SessionPromptChannelTarget`
- `HostSessionsStartChannel`
- `HostPermissionRespondChannel`
- `HostContextsChannel`
- `HostSessionsCreateOrLoadChannel`

The route list is in `packages/runtime/src/channels/host-control-routes.ts:68`.
There is no lifecycle cancel/close route in that list.

The same file explicitly marks lifecycle as observation-only:

```text
SessionLifecycleChannel is intentionally observation-only here. The
router declares every dispatched host-control channel; lifecycle remains
a stream service consumed through its typed channel tag.
```

That comment is at `packages/runtime/src/channels/host-control-routes.ts:84`,
immediately before `SessionLifecycleChannel` is provided as a stream service.

The protocol shape confirms observation semantics: `SessionLifecycleChannel`
only exposes `forSession(sessionId) => IngressChannel<RuntimeRunEventSchema>` at
`packages/protocol/src/channels/host-control.ts:180`; it does not define a call
or send payload for cancel/close intent.

## ACP Edge Current State

`packages/host-sdk/src/host/acp-stdio-edge.ts:274` still rejects ACP cancel with:

```text
ACP cancel is not implemented by the Firegrid stdio edge
```

That fail-fast behavior is correct until the decision below lands. Wiring ACP
cancel directly to the existing agent-tool helper would create a second
mechanism outside the host-plane edge contract. Adding a route without deciding
whether the observation-only lifecycle channel is intentional would erase an
explicit architecture boundary.

## Decision Required

The implementation question is not "can Firegrid cancel?" The durable cancel
row and reconciler path exist. The decision is where ACP stdio edge is allowed
to express that intent:

- Promote lifecycle cancel/close into a host-plane routed command.
- Keep lifecycle observation-only and let ACP append durable lifecycle rows
  through a lower-level host-owned helper.

The companion SDD frames the load-bearing question and the cutover each option
implies.
