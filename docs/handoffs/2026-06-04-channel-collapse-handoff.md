# tf-s9uj — host-plane channel collapse: HANDOFF (2026-06-04)

Stopped at a CLEAN checkpoint (context limit). **No code edits applied** — the
branch is at `origin/main` (07a4bdb74); only survey + base-selection done. This
handoff captures the full survey so the next session resumes in <5 min.

## GOAL

Collapse the host-plane channel machinery: the fixed-target MCP ops dispatch
**MCP-tool → handler → durable-op DIRECT**, no router. Proven viable in spike
PR #912 (`runSessionClose` direct + a green real-path test); verdict +
delete-set in `docs/findings/tf-hzln-channel-collapse-verdict.md`. Target
**−300 to −450 LoC**.

DELETE: `channels/host-plane-router.ts` (HostPlaneSessionControlRouterLive, ~101
LoC); the host-plane Channel Tags + `*ChannelSignalingLive` +
`makeDurableEventChannel`/`makeCallableChannel` wrappers in
`unified/channel-bindings.ts` (368 LoC — keep the BARE durable ops); per-channel
`*ChannelTarget` Tags + host-plane `ChannelInventory`; the `hostPlaneDispatch`
helper in tool-dispatch.ts.
KEEP: the agent-dynamic-plane route core in `channels/router.ts` (`RuntimeChannelRouter`
+ `routeByTarget` Map + `runHeadOrNever` ingress `Effect.never` park +
bidirectional verb-gate) — `send`/`call`/`wait_for` target RUNTIME-NAMED
channels, so the registry is irreducible. router.ts shrinks ~340 → ~80–120; do
NOT delete its core.

## BASE (important)

Rebased on **origin/main 07a4bdb74** (post-#910 MERGE): `firegrid.ts` DELETED,
`firegridHost` composition root + `McpIngressLive` present, comp-sim-idempotent
HELD (deleted; see `docs/findings/tf-ll90-8-4-held-sims.md`). The host-plane
channel layer is composed **inside `McpIngressLive`** (`unified/mcp-ingress.ts`,
via `ToolDispatchLive` + `HostPlaneSessionControlRouterLive`) — the collapse
SIMPLIFIES that composition root (drop the host-plane router from it). Do NOT
collapse any pre-#910 shape. NOTE: the spike's `runSessionClose`-direct (PR #912)
was branched off PRE-#910 main, so it is NOT in this base — redo session_close
as one of the rewires below.

## SURVEY (all done — concrete, source-verified on this base)

**6 `hostPlaneDispatch` call sites, 4 MCP-tool handlers** (`packages/runtime/src/unified/mcp-host/tool-dispatch.ts`):
- `runSessionNew` (L443): 3 dispatches —
  - L457 `HostSessionsCreateOrLoadChannelTarget` verb `call` → durable op = create-or-load insert.
  - L476 `SessionPromptChannelTarget` verb `send` → `signalPromptToSession`.
  - L494 `HostSessionsStartChannelTarget` verb `call` → **vestigial ack** (see below) — DROP.
- `runSessionPrompt` (L514): L519 `SessionPromptChannelTarget` `send` → `signalPromptToSession`.
- `runSessionCancel` (L542): L546 `SessionCancelChannelTarget` `call` → `emitSessionTerminalSignal`(op:"cancel").
- `runSessionClose` (L559): L563 `SessionCloseChannelTarget` `call` → `emitSessionTerminalSignal`(op:"close").

**The durable ops (this is the whole rewire):**
- create-or-load → `insertHostBoundRuntimeContext` (`channels/host-control.ts:36`, **PRIVATE**)
  + `runtimeContextProvenance` (host-control.ts:64, PRIVATE). The Live
  (`HostSessionsCreateOrLoadChannelLive`, host-control.ts:102) does:
  `id = `session:${externalKey.source}:${externalKey.id}``; `insertHostBoundRuntimeContext({ control, hostSession, contextId: id, ...runtimeContextProvenance({createdBy, parentContextId}), runtime })`;
  returns `{ sessionId: id, contextId: id }`. Needs **RuntimeControlPlaneTable + CurrentHostSession** in scope.
  → EXPORT a small helper (e.g. `createOrLoadRuntimeContext(request)` requiring
  RuntimeControlPlaneTable+CurrentHostSession) from host-control.ts, OR export
  the two privates and inline in the handler.
- prompt → `signalPromptToSession` (`unified/channel-bindings.ts:142`, **PRIVATE** — EXPORT it).
  Call: `signalPromptToSession({ engine, contextId: input.sessionId, payload: input.prompt, target: String(SessionPromptChannelTarget), idempotencyKey: inputId })`. Needs **WorkflowEngine**.
- terminal (cancel/close) → `emitSessionTerminalSignal` (channel-bindings.ts:165, **EXPORTED**).
  Call: `emitSessionTerminalSignal({ engine, contextId: input.sessionId, idempotencyKey: `session.${op}:${input.sessionId}`, payloadJson: JSON.stringify({ operation: op, ...(reason? {reason}:{}) }) })`. Needs **WorkflowEngine**. (`terminalPayloadJson` at channel-bindings.ts:186 is PRIVATE — inline the 3-line JSON.)
- start → `HostSessionsStartChannelLive` (channel-bindings.ts:127) is just
  `makeDurableEventChannel({ append: req => stableOffset(target, req.sessionId) })`
  — a PURE ACK, no engine, no spawn. The real spawn happens when the prompt
  input drives `RuntimeContextSessionWorkflow` body (startOrAttach on first
  input). So **DROP the L494 start dispatch** in runSessionNew (its result is
  discarded anyway). session_new = create-or-load + signalPromptToSession.

**R-channel:** the direct handlers need `WorkflowEngine` (prompt/terminal) and
`RuntimeControlPlaneTable + CurrentHostSession` (create-or-load) in the dispatch
arm's R. Spike proved `WorkflowEngine` flows: widen `dispatchArm` +
`FiregridAgentToolExecutor.execute` R to include them; `McpToolDispatchWorkflow`
body runs under the engine and `Activity.make` carries R through (no new
plumbing). **VERIFY** RuntimeControlPlaneTable + CurrentHostSession are in the
ToolDispatch context (they're provided by firegridHost/McpIngressLive's runtime —
likely yes; if not, that's the one thing to surface).

## STATE

- Rewired to direct: **NONE yet** (clean checkpoint).
- Deleted: nothing.
- Spike reference (`runSessionClose` direct + the proof test) lives in PR #912
  branch `codex/tf-hzln-channel-collapse-spike` (off pre-#910 main) — copy the
  pattern; the test harness add (`mcp-tool-dispatch-sleep.test.ts` →
  `tf-hzln: session_close ... no channel router`) is the template for proving
  each rewired op without a router.

## FOLD-IN (tf-focr — comp-sim-idempotent restore)

While making create-or-load a direct handler: expose **idempotent
create-or-load-by-external-key** (`HostSessionsCreateOrLoad` insert-or-get by
`[source,id]`) as its own MCP tool (new `agent-tools` schema, e.g.
`session_create_or_load` with `{ externalKey, runtime?, createdBy? }` → `{ sessionId, contextId }`),
dispatch-arm → the `createOrLoadRuntimeContext` direct op (insert-or-get; the
insert is already idempotent on contextId via upsert). Wire
`FiregridMcpClient.sessions` (a new `createOrLoadByKey` or extend) in
`packages/client-sdk/src/mcp.ts`. Then RESTORE comp-sim-idempotent (it's deleted;
`git checkout <pre-#910> -- packages/tiny-firegrid/src/simulations/comp-sim-idempotent` or recreate)
and migrate it onto firegridHost (the #910 pattern) + the new MCP op. Update
`docs/findings/tf-ll90-8-4-held-sims.md`. (verified-webhook-wait stays HELD —
dynamic-plane send/read, separate.)

## GOTCHAS

- **WorkflowEngine into the arm R-channel**: proven OK (spike) — Activity.make in
  `McpToolDispatchWorkflow` body carries it; just widen the type annotations on
  `dispatchArm`/`executor.execute`. create-or-load additionally needs
  RuntimeControlPlaneTable + CurrentHostSession — verify they're in context.
- **Do NOT delete `router.ts` core** — the agent dynamic plane (send/call/wait_for
  over runtime-named channels) needs `routeByTarget` Map + `runHeadOrNever`
  ingress park + verb-gate. Only delete the HOST-PLANE machinery.
- **decode is already at the MCP boundary** (`dispatchArm` → `decodeJson(...Schema)`),
  so the router's `decodeRoutePayload` was redundant — direct handlers don't
  re-decode.
- **#911 gitignores the tool-generated `docs/findings/tf-{uc8u,pxxe,7whh,o7id}` artifacts**
  (`docs/findings/.gitignore`). `git add -A` after preflight must NOT recommit
  them; verify the staged set is clean (they regenerate, gitignored).
- **bin/_compose.ts / bin/run.ts / bin/acp.ts** route through `firegridHost`
  (McpIngressLive http transport) — the host-plane router lives inside
  McpIngressLive; removing it there is the single composition-root edit.

## NEXT STEPS (ordered)

1. EXPORT `signalPromptToSession` (channel-bindings.ts) + a `createOrLoadRuntimeContext`
   op (host-control.ts, wrapping insertHostBoundRuntimeContext+provenance).
2. Rewire the 4 handlers to direct durable-op calls (drop the L494 start
   dispatch). Widen `dispatchArm` + `FiregridAgentToolExecutor.execute` R to
   `WorkflowEngine | RuntimeControlPlaneTable | CurrentHostSession`. Typecheck —
   surface any service NOT in the dispatch context.
3. Prove: run creds-free sims — `control-plane-cancel-close` (session_close +
   session_cancel via mcp.ts), `unified-kernel-validation` (session_new). Both
   already drive these over MCP through firegridHost. Green = direct path works.
4. FOLD-IN: external-key create-or-load MCP tool + schema + mcp.ts wiring; restore
   + migrate comp-sim-idempotent; run it.
5. DELETE the dead host-plane machinery (host-plane-router.ts; channel-bindings
   Signaling Lives + per-channel Tags + makeDurableEventChannel/Callable if
   unused; per-channel `*ChannelTarget`; host-plane ChannelInventory;
   hostPlaneDispatch). SIMPLIFY McpIngressLive (drop HostPlaneSessionControlRouterLive).
   Keep router.ts core + the bare durable ops.
6. Full `pnpm preflight` green; check net LoC (−300 to −450). Push, finalize
   DRAFT PR "refactor(tf-s9uj): collapse host-plane channel router → direct MCP
   handlers" — lead with LoC delta + what survived for the dynamic plane.

Branch: `codex/tf-s9uj-host-plane-collapse` @ 07a4bdb74 (== origin/main, clean).
