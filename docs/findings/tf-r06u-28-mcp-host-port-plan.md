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

## Option B — FINALIZED build spec (approved; deps verified on #765)

**Placement:** new cohesive gateway-edge dir `packages/runtime/src/unified/mcp-host/`
(the §4 rename/split tf-r06u.14 relocates the gateway tier later — keep it
self-contained for an easy move).

**Files to create (port + reconcile imports):**
1. `tool-error.ts` — port verbatim from main `bindings/tool-error.ts` (`ToolError`
   union + `toolExecutionFailed`). Reconcile `../../../events` → `../../events`.
2. `toolkit.ts` — port the toolkit DEFINITION from main `bindings/tools.ts`:
   `FiregridAgentToolContext`, `FiregridAgentToolkit` (`Toolkit.make` over the
   11 `Tool.make` from `@firegrid/protocol/agent-tools`), `FiregridPrimitiveProfileToolkit`,
   `FiregridMcpToolFailureSchema`. Mostly verbatim (deps — agent-tools, projection,
   launch, `@effect/ai` Tool/Toolkit — all present on #765).
3. `toolkit-layer.ts` — port the handler shape from main: `FiregridAgentToolkitLayer`
   / `FiregridPrimitiveProfileToolkitLayer` via `Toolkit.toLayer(makeToolkitHandlers)`.
   Handlers stay identical (each → `ToolDispatch.call({contextId, toolUseId,
   toolName, input})`). **The rewire is behind `ToolDispatch`, not in the handlers.**
4. `tool-dispatch.ts` — **THE REWIRE.** Provide a `ToolDispatch` Tag whose `.call`
   drives #765's unified `ToolDispatchWorkflow` (`unified/subscribers/permission-and-tool.ts`)
   — which is generic over an injected `ToolExecutor`. So implement
   **`FiregridAgentToolExecutor`** mapping each tool → unified primitive:
   | tool | #765 unified primitive |
   |---|---|
   | `sleep` | `Workflow.sleep` / clock (unified) |
   | `wait_for` / `wait_for_any` | ingress channel + `awaitSignal` (`unified/signal.ts` + `channel-bindings.ts`) |
   | `send` | egress channel append (`channel-bindings.ts`) |
   | `schedule_me` | `ScheduledPromptWorkflow` (`unified/subscribers/scheduled-webhook-peer.ts`) |
   | `spawn` / `session_new` / `session_prompt` / `session_cancel` / `session_close` | `RuntimeContextSessionWorkflow` (`unified/subscribers/runtime-context.ts`) + signal |
   | `execute` | sandbox/codec path (`unified/codec-adapter.ts`) |
   | `call` | egress channel (request/response) |
   This executor is the bulk of the work; some tools may map to a thin wrapper,
   others (spawn/session_*) need the unified session workflow wiring.
5. `runtime-context-mcp-base-url.ts` + `mcp-channel-metadata.ts` — port from main
   `composition/` (the TFIND-048 host-owned URL late-binding; mostly self-contained).
6. `mcp-host.ts` — port `FiregridMcpServerLayer` from main `composition/mcp-host.ts`.
   **PRESERVE the tf-x3sv invariant** (register full toolset as a build-time
   happens-before dep of `HttpRouter.Default.serve()`) + `toolProfile` full/primitive.
   Reconcile `../tables/runtime-control-plane.ts` → #765's `RuntimeControlPlaneTable`
   home; `../subscribers/tool-dispatch/index.ts` → the new local `tool-dispatch.ts`.

**Acceptance:** port `agentic-patterns-primitive-profile.test.ts` +
`sleep-only-substrate-smoke.test.ts` (hit the real bound HTTP endpoint →
`tools/list` complete + `sleep` end-to-end). Optionally a B1-style env-gated
live-adapter reach check.

**Sequencing:** (1) tool-error + toolkit + toolkit-layer (toolkit DEFINITION
compiles, `tools/list` shape correct) → (2) tool-dispatch executor over unified
(the rewire; sleep first, then the rest) → (3) base-url + channel-metadata +
mcp-host server (the gateway edge; wire-fix) → (4) compose into a host layer +
port the two acceptance tests → green. Size: multi-session; sleep-path slice is
the first green milestone (proves the §4 gateway-edge pattern end-to-end).

## Status

- **Option B APPROVED** (Coordinator): it's the §4-coherent answer — the mcp-host
  is a gateway-edge over the unified substrate, so tf-r06u.28 is the FIRST real
  §4-design implementation. Do NOT drag main's `ToolCallWorkflow` (Option A =
  dual-dispatch debt #765 deliberately collapsed).
- **Unblocked** — the `.28 → .22` blocking dep was dropped (§4 design informs,
  doesn't gate); `.28` claimed `in_progress`.
- Worktree manual off `origin/sim/unified-kernel-validation` is correct (the
  task-enter `--base` fix rides on unmerged #766).
- Executing per the sequencing above; first green milestone = the `sleep` slice
  (toolkit definition + `tools/list` + sleep through unified + mcp-host wire-fix).
