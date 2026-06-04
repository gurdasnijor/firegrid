# tf-hzln — channel-collapse viability spike: VERDICT

**VERDICT: GREEN LIGHT for the FIXED-target ops; the router is pure indirection
there and collapses to MCP-tool→handler-direct. The GENERIC dynamic-plane ops
(send/call/wait_for over runtime-named channels) carry a load-bearing
name→binding registry + ingress-park and do NOT collapse to a fixed direct path
— that residue is the finding.**

Proven on ONE representative op end-to-end, real path, no backdoor.

## What was proven

Re-wired `session_close`'s MCP handler (`runSessionClose`, tool-dispatch.ts) to
dispatch **directly** to the durable terminal op `emitSessionTerminalSignal`
(→ `RuntimeContextSessionWorkflow` terminal input), bypassing the ENTIRE channel
router stack: no `RuntimeChannelRouter`/`HostPlaneChannelRouter`, no string
target resolution, no `SessionCloseChannel` Tag, no `SessionCloseChannelSignalingLive`,
no `makeDurableEventChannel` wrapper. The durable execution is unchanged.

Real-path proof (`packages/runtime/test/mcp-host/mcp-tool-dispatch-sleep.test.ts`
→ `tf-hzln: session_close dispatches direct to the terminal op — no channel
router`, GREEN): a composition that provides **no router at all** drives
`session_close` through the real `ToolDispatch` + `McpToolDispatchWorkflow` +
`DurableStreamsWorkflowEngine` + real `RuntimeContextSessionWorkflow`, and:
- the tool returns `{ closed: true, sessionId }`, and
- the REAL durable terminal body runs `adapter.deregister(contextId)` (observed
  after settle) — i.e. the terminal reached the kernel, not a stub.

Before this rewire the same router-less composition fails
`"session tools require HostPlaneChannelRouter"` (the old `hostPlaneDispatch`
path). So the router was carrying nothing load-bearing for this fixed-target op.

## What the handler had to absorb (≈ nothing)

The router's `dispatch` does four things; for a FIXED-target op all four are
free:
- **name→route resolution** (`routeByTarget` Map) — UNNEEDED: the target
  (`SessionCloseChannelTarget`) is statically known to the handler.
- **verb-gating** (`supportsVerb`) — trivial: one verb.
- **payload schema-decode** (`decodeRoutePayload`) — REDUNDANT: `dispatchArm`
  already decodes `SessionCloseToolInputSchema` at the MCP boundary; the router
  re-decoded.
- **`route.invoke`** — for close this is just `emitSessionTerminalSignal`.

The ONE real thing absorbed: `WorkflowEngine` moved into the dispatch arm's
R-channel. The channel `*SignalingLive` captured `engine = yield* WorkflowEngine`
at Live-build; going direct, `runSessionClose` does `yield* WorkflowEngine`
instead. This needed only widening `dispatchArm` / `FiregridAgentToolExecutor.execute`
R to `WorkflowEngine` — the `McpToolDispatchWorkflow` body already runs under the
engine and `Activity.make` carries it through. **No new plumbing, no
engine-threading.** (~+10 LoC of handler; ~3 type-annotation widenings.)

## Shortest collapse path

**Collapsible NOW (fixed-target / host-plane ops — the bulk of the machinery):**
session_close (done here), session_cancel, session_new (its 3 sub-dispatches:
create-or-load + prompt + start), session_prompt, host prompt, host
contexts-create/start, permission-respond. Each MCP handler calls its durable op
directly — the ops already exist and are exported / trivially exportable:
`emitSessionTerminalSignal`, `signalPromptToSession`, `insertHostBoundRuntimeContext`,
the start-ack, the permission `DurableDeferred` resolve. All currently routed via
the 5 `hostPlaneDispatch(...)` calls in tool-dispatch.ts.

DELETE set once those are rewired:
- `packages/runtime/src/channels/host-plane-router.ts` (~101 LoC —
  `HostPlaneSessionControlRouterLive`, the whole host-plane router).
- The host-plane Channel Tags + `*ChannelSignalingLive` + `makeDurableEventChannel`/
  `makeCallableChannel` wrappers in `unified/channel-bindings.ts` (~180–250 of its
  368 LoC) — KEEP the bare durable ops (`emitSessionTerminalSignal`,
  `signalPromptToSession`, the permission resolve).
- The per-channel `*ChannelTarget` Tags in `@firegrid/protocol/channels` once
  nothing but the router consumes them; `ChannelInventory` for the host-plane set.
- The `hostPlaneDispatch` helper in tool-dispatch.ts.

**NOT collapsible (load-bearing residue) — the generic dynamic plane**
(`send`/`call`/`wait_for`, `runSend`/`runCall`/`waitOnChannel`): the agent NAMES
the channel at runtime (`send({ channel, payload })`), so a **name→binding
registry is irreducible** — there is no static handler target. `router.ts`
(~340 LoC) SHRINKS (drop the descriptor/verb-gate/ChannelInventory ceremony) but
its core must survive for this plane:
- `routeByTarget` name→binding Map,
- the `runHeadOrNever` ingress **`Effect.never` durable-wait park** (the `wait_*`
  block-until-row semantics),
- verb-gating for bidirectional channels (send-vs-wait on one target).
This is exactly the §7 dynamic agent-plane indirection that is load-bearing by
design — it cannot become MCP-tool→handler-direct because the target is data.

## Rough LoC delta

Net **≈ −300 to −450 LoC**: delete host-plane-router.ts (~100) + the host-plane
Tag/Live/wrapper machinery in channel-bindings.ts (~180–250) + per-channel Tags +
the hostPlaneDispatch helper, MINUS ~+40 absorbed into ~5 handlers. `router.ts`
shrinks further (descriptor/ChannelInventory ceremony) but its generic-plane core
(~80–120 LoC: Map + invoke + ingress park) stays. So "delete ~all the channel
machinery" holds for the **host-plane/session half**; the **agent dynamic-plane
half stays as a thin registry**.

## No blocker

The direct path works and is clean. The only non-collapsible piece (generic
runtime-named channels) is a deliberate architectural surface (§7), not a defect
— and it's a thin Map + ingress-park, not the full router/Tag/Live/inventory
stack. Recommend: collapse the fixed-target/host-plane ops first (highest LoC
payoff, zero behavior risk — proven), keep a minimal `send/call/wait_for` route
table for the agent dynamic plane.
