# tf-r06u.28 — mcp-host port-forward: scope + plan (the port is bigger than "4 files")

Date: 2026-06-01
Owner: tf-r06u.28 (agent2 / lane-b)
Branch: sidecar/tf-r06u.28-mcp-host-port (off origin/sim/unified-kernel-validation)
Predecessor finding: docs/findings/tf-r06u-23-28-mcp-host-already-on-main.md (PR #766)

## Scope correction (verify-before-build, round 2)

The re-scope framed tf-r06u.28 as "port 4 files (mcp-host + toolkit-layer +
runtime-context-mcp-base-url + producers/codecs/mcp), preserve tf-x3sv." Checking
#765 against main shows the deleted surface is a **whole tier**, and main's
`mcp-host` sits on top of all of it:

**Deleted on #765 / present on main:**
- `composition/` — entire dir absent on #765. Needed: `mcp-host.ts`,
  `mcp-channel-metadata.ts`, `runtime-context-mcp-base-url.ts` (+ `host-live.ts`,
  `host-public.ts`, `host-substrate.ts`, `host-workflow-engine.ts`,
  `agent-tool-host-live.ts`, `per-context-host-live.ts` — #765 replaced the host
  composition with `unified/host.ts`, so these are *reconciled*, not copied).
- `subscribers/tool-dispatch/` — **12 files** absent on #765 (`toolkit-layer.ts`,
  `dispatch.ts`, `tool-host.ts`, `tool-use-to-effect.ts`, `workflow.ts`, two
  `runtime-tool-use-executor*.ts`, `runtime-agent-tool-execution.ts`,
  `bindings/tools.ts`, `bindings/tool-error.ts`, `index.ts`, README). This is where
  **`FiregridAgentToolkit` / `FiregridAgentToolkitLayer` / `FiregridPrimitiveProfileToolkit`**
  live. On #765 `FiregridAgentToolkit` is only *referenced in a comment*
  (`events/contract.ts:13`) — the `@effect/ai` `Toolkit` + `McpServer.registerToolkit`
  machinery is gone.
- `tables/runtime-control-plane.ts` — absent on #765 (`RuntimeControlPlaneTable` is
  referenced from `unified/host.ts` + `unified/codec-adapter.ts`, so #765 has an
  equivalent to bind to).
- `producers/codecs/mcp` — absent.

**Survives on #765:** `protocol/agent-tools/schema.ts` (the tool input/output
schemas) and `unified/subscribers/permission-and-tool.ts` (a workflow-based
`ToolDispatchWorkflow` + `PermissionRoundtripWorkflow`, keyed on `toolUseId`).

## The real decision (needs §4 SDD tf-r06u.22 input)

main's toolkit handlers (`toolkit-layer.ts`) bind to `ToolDispatch` + a
`ToolCallWorkflow` (`workflow.ts`) keyed `Workflow.idempotencyKey: toolUseId` over
`WorkflowEngineTable`. #765's `unified/` already has its **own**
`ToolDispatchWorkflow` (`unified/subscribers/permission-and-tool.ts:190`). So:

- **Option A — port main's whole tool-dispatch tier** (12 files + composition)
  onto #765, alongside/over the existing unified `ToolDispatchWorkflow`. Faithful
  but drags a second dispatch implementation; risks two tool-dispatch surfaces.
- **Option B — build a thin `FiregridAgentToolkit` + `FiregridMcpServerLayer`
  on top of #765's existing `unified` `ToolDispatchWorkflow`** (reuse the unified
  dispatch; only port the `@effect/ai` Toolkit definition + handler shims +
  `mcp-host.ts` + `runtime-context-mcp-base-url.ts` + `mcp-channel-metadata.ts`).
  Smaller, unified-native, but the toolkit handlers must be rewired from main's
  `ToolDispatch`/`ToolCallWorkflow` to unified's `ToolDispatchWorkflow`/signals.

**Option B is almost certainly right** (it's "port the gateway edge onto the
unified substrate," not "re-import the deleted Shape-C dispatch tier"), and it is
what §4 (tf-r06u.22, "gateway-edges tier over the durable substrate") implies.
But the handler-rewiring (toolkit `wait_for`/`schedule_me`/`spawn` → unified
workflows + the `signal` primitive + `RuntimeOutputTable` cursor) is real
reconciliation work, not a copy. Confirm against .22 before building.

## Invariant to preserve (non-negotiable)

`FiregridMcpServerLayer` must register the **full toolset before serving**
(tf-x3sv happens-before edge; `mcp-host.ts:240-257`) so a no-`list_changed`
client (codex-acp) sees a complete `tools/list` on first snapshot. Plus the
`toolProfile` full/primitive split.

## Acceptance

Port back the two main-side wire tests (deleted-as-dead on #765 in PR #766):
`agentic-patterns-primitive-profile.test.ts` + `sleep-only-substrate-smoke.test.ts`
— they hit the real bound HTTP MCP endpoint (`FiregridRuntimeContextMcpBaseUrl` →
`tools/list`) and assert the locked toolset. (Their `composition/host-live` +
`producers/codecs/mcp` imports become the ported targets.) Optionally add a
B1-style env-gated live-adapter reach check.

## Status / blockers

- **Bead `tf-r06u.28` claim is blocked** by dep `tf-r06u.22` (§4 SDD) not being
  marked closed — bookkeeping (.22 is DONE per the SDD PR #767). Needs the
  Coordinator to close .22 / drop the dep before .28 can be claimed `in_progress`.
- Awaiting Coordinator direction on **Option A vs B** and one-PR-vs-decompose,
  because the target shape is an architectural call tied to §4.
