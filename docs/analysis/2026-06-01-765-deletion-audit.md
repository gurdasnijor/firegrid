# PR #765 comprehensive deletion audit

**Task:** tf-r06u.32 · **Status:** read-only audit (no production code) · **Date:** 2026-06-01
**Branch:** `codex/tf-r06u.32-765-deletion-audit` · **Base:** `sim/unified-kernel-validation`
**Diff audited:** `git diff --diff-filter=D origin/main...origin/sim/unified-kernel-validation` — **359 deleted files**

---

## 0. Method & grounding

Goal: make the "#765 deleted a working+validated tier without replacement" pattern **systematic** rather than incidental, and complete the D1 (cutover-vs-validation) picture for the merge call.

For every deleted capability/tier/test/channel we classify against the **declared intent of the SDDs on the branch** (not mere grep-presence):

- **SANCTIONED-CUTOVER** — an intended Phase-2 deletion, SDD-backed (not a regression).
- **PORTED** — capability survived into `unified/` (or elsewhere), behavior preserved.
- **REPLACED-DIFFERENTLY** — intentionally reshaped; cite the SDD.
- **DEFERRED-TO-SDD** — explicitly deferred behind a named phase/bead/typed-TODO.
- **DELETED-NOT-REPLACED → SILENT** — capability the old tier had (or was actively tracking) that **no SDD addresses as ported or deferred**. *These are the real findings.*

Each finding carries a **Tracked?** column (SDD §, bead id, or `SILENT`) and a **D1-severity**. The audit was run as 7 parallel subsystem sweeps + one SDD-intent-ledger sweep; the highest-severity findings were re-verified by direct reads (cited inline).

**Deletion landscape (by area):**

| Area | Files | Nature |
|---|---|---|
| `packages/tiny-firegrid/src/simulations` | 166 | sim pruning (proof-chain GC) |
| `packages/runtime/src` | 76 | old `composition/` + `subscribers/` + parts of `channels/`+`tables/` tiers |
| `experiments/agent-coordination-patterns/*` | 84 | experiment dir restructure (out of audit scope, LOW) |
| `packages/runtime/test` | 22 | tests for deleted/ported behavior |
| `packages/protocol/src` + `test` | 5 | launch request bindings + schema/control-request tests |
| `packages/client-sdk/src` + `test` | 4 | standalone channel defaults + session-facade tests |

---

## 1. Executive verdict

**#765 has a TWO-LAYER posture, and the layers must be judged by different rules.** The "deleted a working tier" alarm is *partly* the design working as intended and *partly* a real, growing set of silent capability drops.

- **LAYER 1 — the Phase-2 protocol/subscriber collapse is a SANCTIONED aggressive cutover.** `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION_PREFLIGHT.md` makes a **≥5,000-line net source deletion a hard acceptance gate** and forbids `@deprecated`/keep-for-now shims. Deleting the old subscriber loops, `composition/`, `capabilities/`, the bespoke response schemas, the control-plane row families, `wait-router` (→ `Workflow.suspend`), and `keyed-dispatch` (→ engine single-fiber + `idempotencyKey`) **is the deliverable**, not a regression. These are correctly out of the regression set.

- **LAYER 2 — the production wiring on `unified/` is a VALIDATION skeleton.** `SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md` (line 12): *"The substrate is settled. This phase is surface work,"* run as phases A–I, with the real-agent e2e explicitly deferred. **Several production capabilities are sim-proven-only or simply absent**, and the danger zone is precisely the gap between *"Phase 2 deleted X"* and *"no later phase claims to have re-ported X."*

**The cutover-vs-validation call:** treat `sim/unified-kernel-validation` as a **validation skeleton, NOT a production cutover** — which is consistent with the branch's own framing and the prior `rec=A+validation-posture`. The audit surfaces **10 silent capability drops + 9 load-bearing coverage regressions** that are neither ported nor gate-deferred by any SDD. Per the transactional-cutover rule, each must become a **blocking bead before any production cutover**. The 3 incidentally-known cases (mcp-host, parent→child output, read-side stubs) are confirmed and are a **subset** of a materially larger set.

**Headline (the silent-drop set), worst-first:**

1. **Scheduled-prompt delivery is dead** — `schedule_me` fires the durable timer but **never re-injects the prompt** into the session (no relay, no producer). *Verified.*
2. **Session-lifecycle cancel/close has no consumer** — request schema still ships; no reconciler, no `HostKernelWorkflow`, no unified path drives a context to terminal. *Verified.*
3. **Terminal-completion trigger is unwired** — nothing converts a `Terminated`/`TurnComplete` journal row into the session's terminal signal, so the body parks on `Workflow.suspend` forever and `deregister` never fires (per-context process leak).
4. **Read-side snapshot/lifecycle channels return empty** — real `makeHostControlSnapshot` exists but is unwired; bindings hardcode `runs:[],events:[],logs:[],agentOutputs:[]` and `Stream.empty`. *Verified. (→ routed to A2/tf-r06u.6.)*
5. **Host-owned runtime-context MCP server (`FiregridMcpServerLayer`) + toolkit surfacing gone** — agents can't reach Firegrid's own tools (`schedule_me`, `wait_for`, …) via MCP; only client-declared external `mcpServers` pass through. *(→ tracked by #767 §6.6 / tf-r06u.28.)*
6. **Parent→child agent_output observation unwired** — route/channel survive but are imported only by tests; the unified host wires no `SessionAgentOutputChannel` router; resolver does no parent-child authority check.
7–10. Host-locality guard, `bin`/CLI entrypoints (dangling), `@firegrid/host-sdk` fate, malformed-input fail-fast behavior change — see §3.
11. **Parked body not re-armed on restart** — the engine recovers only clock wakeups; the unified context-lifetime body parks on a domain signal and `recoverPendingSignals` is defined-but-unwired. Engine-grounded; see **§1.5 / R14** (added after a Shape-C/Shape-D frame sanity check).

---

## 1.5 Architectural-frame sanity check (Shape C / Shape D) — was the baseline stale?

A reviewer asked whether the audit graded against a **stale architectural frame** (Shape C
vs Shape D, `docs/architecture/shape-c-vs-shape-d.md`). Checked — the baseline is correct, and
the check produced one extra finding. Grounded at the engine.

- **Baseline used was the target, not the stale frame.** The audit graded against the 6 trunk
  SDDs + `unified-subscriber-kernel.md` (the "every subscriber is a workflow" target).
  `shape-c-vs-shape-d.md` is explicitly **transitional** and *defers to that same target* ("treat
  the Shape C path as bridge state expected to collapse … once the kernel-owned write+arm primitive
  lands, tf-c9r9"). It was last updated by the unified-kernel commit itself (`c379f0b65`). So the
  sanctioned-collapse classifications (keyed-dispatch, wait-router, subscriber loops → §2) are right
  under both frames; none was mis-graded as a regression against the obsolete Shape-C rules.
- **The doc corroborates the findings.** Its scheduled-prompt Shape-D *falsifier* — "a scheduled
  fact that needs to fire at a future instant with **no external producer to write a 'due' trigger
  row**" — is exactly **R1**. Its `input-suspend-crash-recovery` falsifier — "a Shape-D body parked
  on `Workflow.suspend` is **not** re-armed by reconstruction" — underpins **R3** and the item below.
- **NEW finding R14 (engine-grounded): the production parked body is not re-armed on restart.**
  The unified `RuntimeContextSessionWorkflow` *is* a context-lifetime body parked on
  `Workflow.suspend` (`unified/subscribers/runtime-context.ts:103-138`) — which `shape-c-vs-shape-d`
  C5 permits **only** once kernel-owned write+arm exists. The engine's startup recovery runs **only**
  `recoverPendingClockWakeups` (`engine/internal/engine-runtime.ts:527`; def :149) — there is **no**
  recovery for domain-signal-suspended workflows (the exact gap the doc cites). The intended sweep,
  `recoverPendingSignals` (`unified/signal.ts:197`, "walks the signal table deduped by executionId;
  re-issues `engine.resume` for executions whose bodies are still unresolved"), **is correct and
  proven** — exported on the unified surface (`unified/index.ts`) and exercised by the sim's
  restart-recovery harness (`unified-kernel-validation/substrate.ts:126` `runGeneration` runs it once
  per generation; the production-flow scenarios call it too). But it has **zero production callers**:
  it is **not invoked by `FiregridHost` nor by engine startup**, and **no SDD mentions wiring or
  deferring it** (verified — whole-repo grep + SDD grep). Live operation re-arms via
  `resume(executionId)` on signal-send (`engine-runtime.ts:290/339/484`); **restart does not
  proactively re-arm a domain-signal-parked body.** D1: **HIGH** (durability/recovery), **SILENT**.
  This is the cleanest single instance of the audit's thesis — *substrate proven in the sim,
  production wiring absent and untracked* — and the substrate-level reason the validation-skeleton
  posture must not be cut over as-is.
- **Doc-hygiene nit:** `shape-c-vs-shape-d.md` lines 155-168 ("Ground Truth / Production
  subscribers") still reference the `subscribers/{tool-dispatch,scheduled-prompt,wait-router,runtime-
  control,runtime-context,runtime-context-session}/` paths that #765 deleted — stale, worth scrubbing.

## 2. The sanctioned cutover (NOT regressions)

These deletions are SDD-backed Phase-2 cuts; listed so the regression set is unambiguous.

| Deleted | Why sanctioned (SDD) |
|---|---|
| `subscribers/keyed-dispatch/*` (`runKeyedDispatch`, `per-key-mutex`) | `unified-subscriber-kernel.md`: per-key serialization given by `Workflow.idempotencyKey` admission + engine single-fiber. **Verified**: `engine/internal/engine-runtime.ts` keeps one live fiber per `executionId`; body is a single `recordedAt`-ordered loop. |
| `subscribers/wait-router/*` (`WaitForWorkflow`) | collapsed into the canonical "wait via `Workflow.suspend` + kernel" pattern. (Caveat: `wait_for_any` race + agent-facing `wait_for` surfacing — see §3/§4.) |
| `subscribers/runtime-context*`, `runtime-context-session*` loops | replaced by `unified/subscribers/runtime-context.ts` `RuntimeContextSessionWorkflow` (WIRING Phase A). |
| `composition/*` tier | replaced by the `FiregridHost` factory `unified/host.ts` (WIRING Phase D). |
| bespoke response schemas, control-plane **row families** (`inputIntents`/`startRequests`/`permissionRequests`/`contextRequests`/`claims`/`completions`/lifecycle), dropped row fields (`inserted`/`inputId`/`status`/`kind`/`_otel`) | `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION(_PREFLIGHT)` — collapse to one `DurableEventChannel<P>` + `EventOffset`; keep only the `contexts` derivation index. |
| protocol `launch/host-*-request*.ts` factories | folded into `protocol/channels/host-control.ts` Tags (response unification). |
| client-sdk `channels/host-*-default.ts` | `FiregridLive` no longer ships standalone channel defaults; the host's `unified/channel-bindings` is canonical (in-code misuse-resistance citation at `firegrid.ts:1421`). |
| `capabilities/` provider-uniqueness tier, `runtime-control-plane-runs` table tests | tier collapsed. |

Permission roundtrip is a **clean PORT** (`PermissionRoundtripWorkflow` + `HostPermissionRespondChannelSignalingLive`), behavior preserved via signal payload instead of row-status.

---

## 3. THE REGRESSION SET — silent drops & behavior deltas (decision-grade)

Capabilities the old tiers had that the unified tier neither demonstrably ports nor explicitly defers behind a gate. **Tracked?** = is it already owned by a bead/SDD, or `SILENT`.

| # | Capability | Deleted-from | Status | Evidence (current tree) | Tracked? | D1 |
|---|---|---|---|---|---|---|
| R1 | **`schedule_me` delivery**: timer fires → re-inject prompt into session | `subscribers/scheduled-prompt/workflow.ts` (`appendScheduledPromptIntent`), `tables/scheduled-prompt-append.ts` | DELETED-NOT-REPLACED | `unified/subscribers/scheduled-webhook-peer.ts:64-95` body records+`DurableClock.sleep`+`return {scheduleId,firedAt}` — **no `sendSignal` relay**; **no non-test producer** calls `.execute`. *Directly verified.* Sibling permission/tool workflows DO relay (`permission-and-tool.ts:139-147,262-270`). | **SILENT** | **HIGH** |
| R2 | **Session-lifecycle cancel/close** (claim → drive per-context engine to terminal) | `subscribers/runtime-control/{dispatcher,workflows,control-request-side-effects}.ts` | DELETED-NOT-REPLACED | request schema still ships (`protocol/launch/control-request.ts:141`) but **zero consumer**; **no `HostKernelWorkflow` anywhere** (*verified: grep empty*); no cancel/close path in `unified/subscribers/runtime-context.ts` (*verified*). | **SILENT** | **HIGH** |
| R3 | **Terminal-completion trigger** (observe `Terminated`/`TurnComplete` → emit session terminal signal → `deregister`) | `subscribers/runtime-context/handler.ts` (exit-evidence → recordExited + resume) | DELETED-NOT-REPLACED | `observers.ts` switch handles only `PermissionRequest`/`ToolUse` — **no `Terminated` branch**; body returns only on a `kind:"terminal"` signal (`runtime-context.ts:124-127`) that nothing emits → body parks forever, `deregister` (`:142-146`) never fires → per-context process leak. WIRING §C diagram lists "observer → terminal signal relay" but Phase C shipped only 2 of 3 legs; **not in the "Out of scope" list**. | **SILENT** | **HIGH** |
| R4 | **Read-side snapshot** (materialize `runs/events/logs/agentOutputs`) | `channels/host-control/live.ts` (wired `makeHostControlSnapshot`) | DELETED-NOT-REPLACED (impl exists, **unwired**) | `unified/channel-bindings.ts:448-480` snapshot Lives hardcode empty arrays; `makeHostControlSnapshot` (`channels/host-control.ts:31`) materializes from tables but has **zero non-test callers**. *Directly verified.* | **tf-r06u.6 (A2)** | **HIGH** |
| R5 | **Read-side lifecycle/contexts streams** | `channels/host-control-routes.ts` | DELETED-NOT-REPLACED (stub) | `SessionLifecycleChannelLive` & `HostContextsChannelLive` = `Stream.empty` (*verified*); old path streamed `control.runs.rows().filter(...)`. | tf-r06u.6 (A2) | MED-HIGH |
| R6 | **Host-owned runtime-context MCP server** (`FiregridMcpServerLayer`) + `FiregridAgentToolkit` surfacing + `AgentToolHost` bridge + base-URL Tag + URL-less-marker resolution (fail-loud) | `composition/mcp-host.ts`, `mcp-channel-metadata.ts`, `runtime-context-mcp-base-url.ts`, `agent-tool-host-live.ts`, `runtime-context-session-codec-adapter.ts` (`resolveEffectiveMcpServers`) | DELETED-NOT-REPLACED | no `McpServer.layerHttp`/`registerToolkit`/`FiregridRuntimeContextMcpBaseUrl`/`enrichRuntimeContextMcpToolsList...` in source; `codec-adapter.ts:184 mcpServersForAcp` maps **only** client-owned `runtime.config.mcpServers`, ignores the marker, no fail-loud. Dangling doc comment at `protocol/launch/schema.ts:199-200`. | **#767 §6.6 / tf-r06u.28** | **HIGH** |
| R7 | **Parent→child `agent_output` observation** (parent context `wait_for`s a child session's output) | (the #746/#748 gap) | DELETED-NOT-REPLACED (dead-but-tested) | `channels/session-agent-output{,-route}.ts` survive but **only test importers**; `unified/host.ts:261-264` wires no `SessionAgentOutputChannel`/router; `session-agent-output/live.ts:29-37` `forContext` does **no parent-child authority check** despite the route's own doc claiming authority lives there. (Distinct from peer-event shared-state, which IS ported.) | **SILENT** | **HIGH** |
| R8 | **Host-locality guard** (`requireLocalRuntimeContextWithHostSession` → typed `ContextNotLocal`) | `subscribers/runtime-context/host-lookup.ts` | DELETED-NOT-REPLACED | symbol only in README/ARCHITECTURE prose; no equivalent guard in unified composition. | SILENT | LOW-MED |
| R9 | **`bin`/CLI entrypoints** (`firegrid run\|acp\|host\|start`) | `bin/host.ts`, `bin/run.ts`, `composition/sync-run.ts` | DELETED-NOT-REPLACED (**dangling**) | `packages/cli/src/bin/{host,run}.ts` still subprocess into the missing `runtime/src/bin/*` → launch breakage. SDDs call bins "an independent decision" (decision-deferred, **not bead-owned**). | SILENT (decision-punt) | **HIGH** (broken launch) / context-dependent |
| R10 | **Malformed-input handling** changed skip-and-continue → `Effect.orDie` (kills session body) | `subscribers/runtime-context-session-workflow/workflow.ts` | REPLACED-DIFFERENTLY (undocumented delta) | `runtime-context.ts:116-123` `orDie` on a bad payload; old path logged + advanced cursor past it. No SDD notes the behavior change. | SILENT | LOW-MED |

Adjacent state-layer notes (corroborating, lower-severity):
- **R11 — tf-aseo durable loop-state + tf-7kq8 output-scan storm guard** (`tables/runtime-context-state.ts`): the durable cursor/pending-permission/exit table and the `nextOutputObservation` gap-skip walker are gone; the new body redefines progress as "read own signals" (legitimate reshape) but the **O(outputs) replay invariant has no production guard** and is exercised only in tiny-firegrid. `unified/tables.ts:1-27` carries rationale prose but no bead re-asserts the invariant. **SILENT / MED.**
- **R12 — `runs` family half-cutover**: ledger says "keep only `contexts`," but `runs` survives in schema (`protocol/launch/table.ts:179`), is **read** by `channels/host-control.ts`+`session-self/live.ts`, yet has **no production writer**. Either dead legacy that should also have been cut, or a wiring gap. **SILENT / MED — author should confirm.**
- **R13 — `claude session/new._meta alwaysLoad` coax**: ledger's unified/-only grep flagged this as gone, but it **EXISTS** at `sources/codecs/acp/index.ts:182-234` (`claudeAgentAcpMeta`). **NOT a drop** — reconciliation note, not a finding.

---

## 4. Coverage regressions — deleted tests for SURVIVING behavior

A deleted test for a *sanctioned-cut* behavior is expected. A deleted test for a behavior that **survived in production code but is now tested nowhere** is a coverage regression (load-bearing invariant left unguarded). 26 deleted tests triaged; the load-bearing untested survivors:

| # | Invariant (survived, now untested) | Deleted test | D1 |
|---|---|---|---|
| C1 | **`schedule_me` true-future exact-once durable delivery** (tf-sto7: 0 intents pre-deadline, exactly 1 after, ==1 across replay) | `workflow-engine/scheduled-prompt-true-future.test.ts` | **HIGH** (compounds R1) |
| C2 | **client-sdk session-facade contract** (createOrLoad idempotent; **bounded-error-not-hang** on unknown ctx; #560/tf-aago **no-orphan-input** on nonexistent-ctx permission respond; autoApprove policies; tf-85bs afterSequence auto-thread) — 24 it-blocks | `client-sdk/test/firegrid.sessions.test.ts` | **HIGH** |
| C3 | **agent-tool schema validation** (sleep neg/non-int reject; wait_for old-source-shape reject; channel-only projection; catalog metadata) | `protocol/test/agent-tools/schema.test.ts` | **HIGH** |
| C4 | **channel-router rejection guards** (`UnsupportedVerb`, pre-invocation parse-fail, `UnknownChannelTarget`, structured `RuntimeChannelDispatchError`) — code survives in `router.ts`, only happy-path now tested | `channels/host-control-router.test.ts` | **HIGH** |
| C5 | **tf-aseo replay invariants** — shared-sequence **log-gap skip** + pending-permission **request+response reload across replay**; terminal evidence durable-row-owned; ToolUse non-state-relevant under ACP | `workflow-engine/runtime-context-state{,.sparse}.test.ts` | **HIGH** (compounds R11) |
| C6 | **`wait_for_any` multi-source race + durable race-replay** (tf-0xe4) | `workflow-engine/workflows/wait-for-workflow.test.ts` | **HIGH** — *and a silent-drop candidate*: confirm whether multi-source agent waiting is still in scope (if yes → untested survivor; if no → dropped capability) |
| C7 | adapter **dup-command-claim "no duplicate stdin/bytes"** + evict-immediately-exited; #738 out-of-order spawn-once | `subscribers/runtime-context-session/{codec,raw}-adapter.test.ts`, `runtime-context-session-workflow/regression.test.ts` | MED (only shape-level tiny-firegrid coverage) |
| C8 | input-facts `insertOrGet` exactly-once + cross-context isolation + history-reconstruct; decode-ingress error-Left; control-request builder semantics; runtimeOutput layer-hoisting (tf-ivl6); runtime root-barrel kernel-tag hiding | `tables/runtime-context-input-facts.test.ts`, `transforms/decode-ingress-row.test.ts`, `protocol/test/launch/control-request.test.ts`, `client-sdk/test/firegrid.layer-hoisting.test.ts`, `public-surface-boundary.test.ts` | MED |

> **Cross-cutting coverage-posture note:** the entire `packages/runtime/src/unified/` production module has **no dedicated `*.test.ts`** — its only validation is the surviving `unified-kernel-validation` tiny-firegrid sim (whose `invariants.ts` scans both the sim tree and `runtime/src/unified/`). The sim's own README states "Not a production cutover." So the substrate shape is proven, but the production module is unguarded by the standard test gate.

---

## 5. tiny-firegrid simulations (166 deleted) — triage

**Verdict: routine cutover churn, no lost proofs.** The deletion GC'd an iterative proof-chain (37 sim dirs) that converged into one surviving successor sim (`simulations/unified-kernel-validation/`, explicitly the rebuild base per its README), four surviving `shape-c-*` sims, and production `unified/` code. tiny-firegrid itself is intact (bin/experiment/prototypes/runner/types.ts). Every spot-checked load-bearing theme (output-replay/cursor, loop-state/fact-matrix, crash-recovery/write-arm, wait, channel-registry/choreography, ACP/codec) has surviving sim and/or production-test coverage. The only caveat is the §4 posture note (unified/ has no standard test, only the sim). **No blocking action from the sim prune itself.**

---

## 6. The three incidentally-known cases — confirmed & situated

| Known case | Confirmed? | This audit's placement |
|---|---|---|
| **mcp-host wire-fix thrown away (tf-x3sv)** | **Yes** — host-owned MCP server + toolkit surfacing + base-URL + marker resolution + AgentToolHost all gone; only client-declared `mcpServers` pass through. | **R6** (tracked → #767 §6.6 / tf-r06u.28). |
| **parent/child output (#746/#748)** | **Yes** — peer-event shared-state IS ported; the *child agent_output observation* is dead-but-tested and unwired in the host. | **R7** (SILENT). |
| **read-side stubs** | **Yes** — snapshot Lives empty, lifecycle `Stream.empty`, real materializer unwired. | **R4/R5** (tracked → tf-r06u.6 / A2). |

**The material conclusion:** all three were real, and they are a **subset** of a 10-item silent-drop set + 9-item coverage-regression set. The pattern is systematic, not incidental — consistent with a validation-skeleton posture where re-porting is genuinely incomplete and, in several cases, **not yet owned by any SDD or bead**.

---

## 7. D1-completion verdict & recommended beads

**Substrate shape: validated. Production re-port: materially incomplete and partly untracked.** Recommend Gurdas treat `sim/unified-kernel-validation` explicitly as a **validation skeleton, not a cutover**, and — per the transactional-cutover rule — convert each untracked silent drop into a **blocking bead** gating production cutover. Suggested owners/beads (new unless noted):

- **P0 (functional gaps that fail silently):** R1 `schedule_me` delivery relay+producer · R2 cancel/close + `HostKernelWorkflow` control plane · R3 terminal-completion trigger (+ `deregister`/process-leak) · R7 parent→child agent_output wiring + authority check · **R14 wire `recoverPendingSignals` into `FiregridHost`** (the engine recovers only clock wakeups; domain-signal-parked bodies are not re-armed on restart — see §1.5).
- **Already tracked:** R4/R5 read-side population (**tf-r06u.6 / A2**) · R6 host-owned MCP surfacing (**#767 §6.6 / tf-r06u.28**).
- **P1 (correctness/operational):** R9 CLI/bin entrypoints (dangling launch) · R11/C5 tf-aseo replay-invariant guard on the new model · R12 `runs` family half-cutover (confirm dead-vs-gap) · R8 host-locality guard.
- **Coverage beads (re-test surviving invariants):** C1 schedule_me true-future · C2 client-sdk session facade (incl. no-hang / no-orphan) · C3 agent-tool schema · C4 router rejection guards · C6 `wait_for_any` race (+ scope decision) · plus a standing item to give `runtime/src/unified/` dedicated `*.test.ts` coverage.
- **Decisions for Gurdas:** `@firegrid/host-sdk` fate (currently `export {}`) · whether multi-source `wait_for_any` remains in scope (C6) · R10 malformed-input fail-fast (intentional?).

**Net:** the deletions are ~80% sanctioned cutover and ~20% genuine, mostly-untracked capability/coverage loss. The audit closes D1 by enumerating that 20% so the cutover-vs-validation decision is made on a complete ledger rather than incidental discovery.
