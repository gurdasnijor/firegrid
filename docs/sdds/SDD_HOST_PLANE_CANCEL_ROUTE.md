# SDD: Host-Plane Cancel Route

Status: decision required
Bead: `tf-c8cy`
Blocks: `tf-8aw5`, `tf-rqyh`

## §0 DECISION

**Does session cancel dispatch through the host-plane router as a new lifecycle
route, promoting lifecycle intent from observation-only into routed host-plane
control, or does cancel flow through a different host-owned mechanism below the
router while `SessionLifecycleChannel` stays observation-only by design?**

This decision gates ACP stdio edge `session/cancel`, later close/resume work,
and any future edge that needs to terminate a RuntimeContext-backed session.
Do not ship a parallel implementation before this is decided.

## Evidence

The durable cancel row exists. `RuntimeLifecycleRequestRowSchema` carries
`lifecycle: "cancel" | "close"` and is described as a durable request that the
host claims and drives to terminal state. `makeRuntimeLifecycleRequestRow`
selects `runtimeCancelRequestId` for cancel.

The `session_cancel` agent tool already appends that row through
`appendCommittedLifecycleRequest`, using a committed `RuntimeControlPlaneTable`
bound to the control-plane stream the reconciler reads.

The host-plane router does not route cancel today. `RuntimeHostControlChannelsLive`
routes create, prompt, session prompt, session start, permission respond,
contexts, and sessions create-or-load. The lifecycle channel is then provided
separately with the comment: "SessionLifecycleChannel is intentionally
observation-only here. The router declares every dispatched host-control
channel; lifecycle remains a stream service consumed through its typed channel
tag."

Current ACP stdio edge behavior is fail-fast: `cancel()` rejects with "ACP
cancel is not implemented by the Firegrid stdio edge."

Full citations are in
`docs/research/tf-c8cy-host-plane-cancel-route.FINDING.md`.

## Option A — Route Lifecycle Intent Through HostPlaneChannelRouter

Decision: session cancel and close are host-plane commands. Add a new routed
control surface, likely distinct from the existing observation-only
`SessionLifecycleChannel`, with a payload shaped around `{ sessionId,
lifecycle }` or narrower cancel/close commands.

Cutover for `tf-8aw5`:

1. Add protocol schemas and a channel target for lifecycle intent.
2. Add a `RuntimeHostControlChannelsLive` router route that appends the existing
   durable lifecycle request row.
3. Wire ACP `cancel({ sessionId })` to `router.dispatch(...)`.
4. Test that ACP cancel does not just resolve: it appends the lifecycle request
   and the runtime reaches cancelled/terminated observation.

Benefits:

- ACP edge uses the same router contract as newSession, prompt, and start.
- Keeps edge code away from durable table construction.
- Establishes one host-plane termination shape reusable by close/resume work.

Costs:

- Reopens the meaning of lifecycle under host-control routing.
- Requires care not to overload the existing observation-only
  `SessionLifecycleChannel` name with command semantics.
- Expands the router's authority beyond currently dispatched control channels.

## Option B — Keep SessionLifecycleChannel Observation-Only

Decision: lifecycle observation remains intentionally separate from lifecycle
intent. ACP cancel appends the existing durable lifecycle row through a
host-owned helper below the router, not through `HostPlaneChannelRouter`.

Cutover for `tf-8aw5`:

1. Extract or expose a narrow host-owned helper equivalent to the current
   `appendCommittedLifecycleRequest` behavior.
2. Compose that helper into `AcpStdioEdgeLive`.
3. Wire ACP `cancel({ sessionId })` to the helper with `lifecycle: "cancel"`.
4. Test that ACP cancel does not just resolve: it appends the lifecycle request
   and the runtime reaches cancelled/terminated observation.

Benefits:

- Preserves the explicit observation-only lifecycle channel comment.
- Reuses the proven durable append path without changing router semantics.
- Avoids making every lifecycle intent a channel route before the shape is
  proven beyond ACP/tool cancellation.

Costs:

- ACP edge gains a second host dependency beside the router.
- More care is needed to prevent duplicate direct durable append helpers.
- Future close/resume work may need another decision if the helper grows.

## Recommendation Shape

Both options must preserve one invariant: there is only one durable lifecycle
append path for a given semantic operation after cutover. The chosen
implementation should delete or reuse the existing `session_cancel` append
logic rather than creating a second writer with subtly different request ids,
headers, or stream binding.

Gary should decide §0 before `tf-8aw5` resumes.
