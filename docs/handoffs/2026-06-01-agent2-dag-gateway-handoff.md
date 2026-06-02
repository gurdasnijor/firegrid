# Handoff — Agent2 / lane-b (dag-gateway) — 2026-06-01

For the next session picking up Agent2's lane. Two PRs open (both base
`sim/unified-kernel-validation`, the integration trunk until #765 lands), one
active in-progress build (tf-r06u.28).

## TL;DR — where to pick up

**All 4 slices of tf-r06u.28 (PR #770) are landed + green.** The MCP-host tier
#765 deleted is ported forward onto the unified substrate, library-owned
(Gurdas review r3333339003: don't reinvent `@effect/ai`). PR is still **draft**;
next is review / un-draft + the separate wire-path follow-ons. Plan:
`docs/findings/tf-r06u-28-mcp-host-port-plan.md`; spike finding:
`docs/findings/tf-r06u-28-sleep-spike-suspension-boundary.md`.

**Slice 4 (acceptance, green):** `test/mcp-host/mcp-host-http-acceptance.test.ts`
drives the REAL bound HTTP endpoint (initialize → tools/list → tools/call). tf-x3sv
holds (first `tools/list` complete: full=11, primitive=4); `sleep` e2e →
`{slept:true}`. **tf-rgdt verdict:** the default `layerJsonRpc` array-wraps a
single response (`[response]`) → strict clients (codex-acp) break → re-added the
byte-identical #224 single-response wrapper (`MCP_TRANSPORT_COMPAT.1`, anchored by
the live `firegrid-effect-ai-native-agents` constraint). OAuth-404 probes +
base-URL late-binding stay deferred (neither broke the round-trip). NO `ndJsonRpc`
swap. 5/5 green across both mcp-host test files.

**Remaining (separate milestones, not blocking #770):** un-draft/review #770;
wire-path durable sleep (**tf-qmkn**); `wait_for`/signal-blocking tools
(tf-12q9/tf-c9r9); a live env-gated codex-acp reach check if desired.

**Slices 2+3 outcome (2026-06-01, green, pushed b4836305b):**
- **Shared unit = the typed per-tool arm** `(input)=>Effect<Output,ToolError>`
  (= main's `toolUseToEffect` arm shape). `sleep` = `Clock.sleep` (permanent MCP
  answer). `ToolError` rides the typed error channel through
  `McpToolDispatchWorkflow` (`error: ToolError`, relay-free Shape D,
  idempotencyKey=toolUseId) → `ToolDispatch` facade → toolkit handler.
- **No hand-rolled MCP encoding.** `@effect/ai`'s `McpServer.registerToolkit`
  (default `failureMode: "error"`) builds `CallToolResult{isError,...}` itself.
  The `ToolResultEvent`/`AgentInputEvent` builders were DELETED from
  `tool-error.ts` (wire-path delivery → future wire-path slice). `tool-error.ts`
  keeps the `ToolError` union (the `.setFailure` schema) + constructors.
- **slice 3 `mcp-host.ts` = `McpServer.layerHttp` + `McpServer.registerToolkit`**,
  NOT a hand-rolled server. tf-x3sv register-before-serve is STRUCTURAL (toolkit
  as a build-time `Layer` dep of `HttpRouter.Default.serve()`). Keeps the
  Firegrid `/runtime-context/:contextId` resolver (`ContextResolverTag`).
- Green e2e: `test/mcp-host/mcp-tool-dispatch-sleep.test.ts` (3/3, real
  `DurableStreamsWorkflowEngine`): typed `{slept:true}` + at-most-once + typed
  `ToolError` failure.
- Beads: **tf-qmkn** (wire-path durable sleep), **tf-rgdt** (slice-3 deferrals:
  single-response JSON-RPC serializer, OAuth probes, base-URL late-binding —
  verify at slice-4 live codex-acp, re-add only if broken). `wait_for`/
  signal-blocking tools = separate milestone (tf-12q9/tf-c9r9). **Scope = sleep.**

For slice 4: port back `agentic-patterns-primitive-profile.test.ts` +
`sleep-only-substrate-smoke.test.ts` to hit the REAL bound HTTP endpoint
(`tools/list` complete + `sleep` e2e). This is ALSO where **tf-rgdt** gets its
verdict against live codex-acp (re-add the deferred customizations ONLY if the
round-trip breaks).

## Open PRs

| PR | Branch | Scope | State |
|---|---|---|---|
| **#766** | `sidecar/pr765-adapter-divergence-spike` | tf-r06u.12 (B1) + tf-r06u.25 (inventory) + tf-r06u.24 (R1–R4 guards + cleanup + methodology + task-enter) | draft; guards proven green; **ready for review** |
| **#770** | `sidecar/tf-r06u.28-mcp-host-port` | tf-r06u.28 port-forward (slice 1/4) | draft / WIP; typechecks |

Both worktrees were created **manually off `origin/sim/unified-kernel-validation`**
(the `task-enter.sh --base` default fix rides on the unmerged #766; until #766
lands, manual-off-trunk is correct — or `git worktree add -b <branch> <wt>
origin/sim/unified-kernel-validation`).

## Bead state

- **CLOSED:** tf-r06u.12 (B1 verdict delivered), tf-r06u.23 (workbench premise
  subsumed by main — see below).
- **IN_PROGRESS (in PR #766):** tf-r06u.24, tf-r06u.25.
- **IN_PROGRESS (in PR #770, active):** tf-r06u.28.
- **OPEN ledger beads (shrink the grandfathers):** tf-r06u.29 (UKV R2 airgap
  conformance), tf-r06u.30 (relocate internals-reaching tests, R3).
- **Agent1:** tf-r06u.27 owns `unified-firegrid-host-compose.test.ts` (R3
  grandfathered it; flagged Agent1; .27 decides its home).

## tf-r06u.28 — the active build (Option B, Coordinator-approved)

**What/why:** #765 deleted the host-owned MCP-surfacing tier; it still exists on
`origin/main`. The `@effect/ai` McpServer ↔ ACP-adapter wire-compat is already
implemented + validated on main (see `docs/findings/tf-r06u-23-28-mcp-host-already-on-main.md`
in PR #766). So this is a **port-forward**, and it's the first real §4
gateway-edge-over-substrate implementation.

**Option B (do NOT do Option A):** build a thin `FiregridAgentToolkit` +
`FiregridMcpServerLayer` **over #765's existing unified `ToolDispatchWorkflow`**
(`unified/subscribers/permission-and-tool.ts`, generic over an injected
`ToolExecutor`). Do NOT drag main's `ToolCallWorkflow` / a second dispatch
(that's the dual-dispatch debt #765 deliberately collapsed).

**Slices (sequence; full mapping in the plan doc):**
1. ✅ `unified/mcp-host/{tool-error,toolkit}.ts` — toolkit definition + failure
   schema (landed, typechecks).
2. ⏭ **`unified/mcp-host/tool-dispatch.ts` — THE REWIRE (start here).** Provide a
   `ToolDispatch` Tag whose `.call({contextId,toolUseId,toolName,input})` drives
   the unified `ToolDispatchWorkflow` via a **`FiregridAgentToolExecutor`**
   mapping each tool → unified primitive:
   - `sleep` → `Workflow.sleep`/clock
   - `wait_for`/`wait_for_any` → ingress channel + `awaitSignal` (`unified/signal.ts`, `channel-bindings.ts`)
   - `send` → egress channel append (`channel-bindings.ts`)
   - `schedule_me` → `ScheduledPromptWorkflow` (`unified/subscribers/scheduled-webhook-peer.ts`)
   - `spawn`/`session_new`/`session_prompt`/`session_cancel`/`session_close` → `RuntimeContextSessionWorkflow` (`unified/subscribers/runtime-context.ts`) + signal
   - `execute` → sandbox/codec path (`unified/codec-adapter.ts`)
   - `call` → egress channel request/response
   **First green milestone = the `sleep` slice end-to-end** (don't try all 11 at
   once; land `sleep` through the real path, then iterate).
3. `mcp-host.ts` server + `runtime-context-mcp-base-url.ts` + `mcp-channel-metadata.ts`,
   ported from main `composition/`. **PRESERVE the tf-x3sv invariant**
   (register the full toolset as a build-time happens-before dep of
   `HttpRouter.Default.serve()` — `main composition/mcp-host.ts:240-257`; without
   it a no-`list_changed` client like codex-acp sees a partial `tools/list`) +
   the `toolProfile` full/primitive split. Reconcile main's
   `../tables/runtime-control-plane.ts` → #765's `RuntimeControlPlaneTable` home;
   `../subscribers/tool-dispatch/index.ts` → the new local `tool-dispatch.ts`.
4. Acceptance: port back `agentic-patterns-primitive-profile.test.ts` +
   `sleep-only-substrate-smoke.test.ts` (deleted-as-dead on #765 in PR #766; they
   hit the real bound HTTP endpoint → `tools/list` complete + `sleep`).

## Load-bearing findings / decisions (don't re-derive)

- **B1 verdict (routes to §4/§6 registry decision):** fleet onboarding is CONFIG
  not code — single divergent field is `newSessionMeta` (claude `alwaysLoad`
  `_meta` coax; codex none), + a `mcpToolNamePrefix` normalization (claude bare
  `schedule_me` vs codex `mcp.firegrid.schedule_me`). Both adapters reach+call a
  Firegrid MCP tool. (`docs/findings/tf-r06u-12-adapter-divergence-mcp-reach.md`.)
- **tf-x3sv reconciles the stale "codex defers MCP" memory:** the "codex only saw
  `sleep` of 11" was a registration-ordering race (no-`list_changed` client lists
  mid-registration), fixed on main by register-before-serve. NOT a codex dialect
  limit. Preserve that invariant in slice 3.
- **Deletion-audit (A3) signal:** #765 *re-implemented* tool-dispatch (unified has
  its own) but *deleted-without-replacement* the mcp-host surfacing + the
  `@effect/ai` toolkit — the "replaced-differently vs deleted-not-replaced"
  granularity. Coordinator flagged this as the 3rd such tier (after #746/#748
  parent/child + read-side) = D1 evidence.
- **Workbench pattern** (methodology, PR #766): Context.Tag → stub in `host(env)`
  → public client driver → trace → prose finding. Stays useful for genuinely
  unbuilt tiers; the mcp-host tier was already built (hence .23 closed).

## Environment gotchas (cost real time)

- **No macOS `timeout`.** Use node-side timing.
- **Read tool intermittently hallucinates** — trust `grep`/`git show`/`sed` for
  exact strings before editing.
- **dep-cruiser `includeOnly: "^packages/.*/src"`** — `lint:deps` scans `src`
  only; the R3 test rule needs the dedicated second invocation in `lint:deps`
  (`--include-only '(^packages/.*/src|^packages/tiny-firegrid/test)'`) so the
  forbidden `to`-edges (runtime/src) are in the graph to match.
- **`pnpm install` in a fresh worktree** prunes a phantom `experiments/agent-coordination-patterns`
  importer from `pnpm-lock.yaml` (that dir is absent on #765) — `git checkout
  pnpm-lock.yaml` to keep the diff scoped if you don't intend to touch it.
- **Pre-existing UKV lint debt:** `production-flow-acp-scenario.ts` /
  `production-flow-scenario.ts` have comma-dangle/type-import eslint errors on the
  base — NOT introduced by this lane (confirmed with config stashed). Other
  session's territory; don't fix in this lane.
- **codex-acp** isn't a workspace dep — the B1 live test locates it via
  `FIREGRID_CODEX_ACP_BIN` (an isolated `npm i` outside the pnpm workspace; was at
  `/tmp/acp-adapters`).

## Coordinator protocol (this session)

- Dispatch via `bash scripts/cmux-dispatch.sh Coordinator -` (label is
  `Coordinator`, capital C). Surface cross-lane / architectural decisions
  (verify-before-build paid off 3×); don't unilaterally touch other lanes' files.
- Base future branches on `origin/sim/unified-kernel-validation` until #765 lands.

## Memory pointers

`project_adapter_divergence_spike` (B1 + inventory + relocation + #766),
`project_codex_acp_defers_mcp_tools` (RESOLVED note), and this lane's beads
(tf-r06u.24/.25/.28/.29/.30) are the durable trail.
