# Phase 0C migration map — collapse production runtime surfaces onto Phase 0A/0B primitives (2026-05-21)

**Bead:** `tf-b1jm` (P0). **Status:** source-grounded migration/deletion map. **This is not a production patch** — no production code is changed here; this names the cutover order and the missing primitives.

**Audience:** the convergence lanes. This doc maps the whole surface so each cutover lands as a declared transactional cutover (owner + deletion bead + blocking dep), per the transactional-cutover rule. It does not edit the `tf-7kq8` output-observation patch surface or the `tf-ly2g` output-result surface — those are tracked separately; this map only classifies them.

## What "the target" is (one line)

```
channel (public semantic surface)
  -> channel router (decode/validate/dispatch — no engine/table knowledge)
  -> channel binding (writes/reads the workflow-owned DurableTable)
  -> workflow body = state machine over its own table, durable cursor IN table state
```

Phase 0A (`SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md`, `packages/tiny-firegrid/.../target-architecture-reference`) proved the **input** seam: `channel -> SessionTable.inputs.insertOrGet -> workflow advances sessions.nextInputSequence`. Phase 0B (`docs/investigations/2026-05-21-phase0b-output-replay-oracle.md`, PRs #609/#610) proved the **output** seam: a workflow-owned append log read through a **`DurableOutputCursor`** (durable position + journaled `next()`), giving O(distinct outputs) instead of O(resumes × history). #611 added the **`WORKFLOW_ADMISSION`** rule: a `Workflow.make` is only legitimate for an owned durable resource / long-running process; one-shot commands, tool calls, waits, lifecycle requests, and routing bridges are not workflow identities (`features/.../firegrid-workflow-driven-runtime.feature.yaml:168-173`).

Phase 0C is the map from today's production surfaces to those two seams plus the admission rule.

## Classification legend

| Tag | Meaning |
| --- | --- |
| **KEEP** | Owner primitive in the target; stays. |
| **COLLAPSE** | Behavior survives but folds into the workflow-owned table seam / Phase 0B cursor; the surface as a *distinct concept* goes away. |
| **DELETE-AFTER** | Pure bridge/operation-shaped; removed once its replacement seam is live. Needs an explicit deletion bead blocked-on the replacement (transactional-cutover rule). |
| **STOP-AND-RE-EVALUATE** | Touches the control-plane / HostKernelWorkflow direction; out of Phase 0C mechanical scope — needs SDD before code. |

## Surface map (summary)

| # | Production surface | Source | Class | Replacement owner |
| --- | --- | --- | --- | --- |
| S1 | `RuntimeContextWorkflowNative` (the workflow identity) | `workflows/runtime-context.ts:876` | **KEEP** | — (it IS the owned durable resource) |
| S2 | Merged-event-loop input cursor (`Ref` `lastProcessedInputSequence`) | `runtime-context.ts:347-349,820` | **COLLAPSE** | workflow-owned `inputs` table + cursor-in-table-state |
| S3 | Output observation (`completedRuntimeOutput`→`events.initial`) | `runtime-context.ts:274-298,762`; `agent-event-pipeline/.../per-context-output.ts:110-140` | **COLLAPSE** | Phase 0B `DurableOutputCursor` |
| S4 | `appendRuntimeInputDeferred` | `workflow-engine/runtime-input-deferred.ts:94-171` | **DELETE-AFTER** | channel binding → `inputs.insertOrGet` |
| S5 | `WorkflowEngineTable.deferreds` **as input mailbox** (the `runtime-context/<id>/input/N` scan) | `runtime-input-deferred.ts:75-92` | **DELETE-AFTER** | workflow-owned `inputs` collection |
| S5b | `WorkflowEngineTable.deferreds` **as genuine durable-wait store** (DurableClock / suspended waits) | engine-internal | **KEEP** | — (engine-private wait primitive) |
| S6 | Input intents: `RuntimeInputIntentRow`, `RuntimeContextInput.dispatchIntent`, `RuntimeInputIntentDispatcherLive`, `RuntimeControlPlaneTable.inputIntents` | `kernel/runtime-context-workflow-runtime.ts:64-71,336-359,410-429` | **COLLAPSE** → **DELETE-AFTER** | channel writes workflow-owned `inputs` directly |
| S7 | `RuntimeContextWorkflowRuntime` active-execution map + reconcile pass | `runtime-context-workflow-runtime.ts:185,257-334` | mixed (see §S7) | host-engine keying KEEP; reconcile DELETE-AFTER; in-mem fence STOP-AND-RE-EVALUATE |
| S8 | Workflow-support registry (`workflowSupportRegistered` + lock) | `runtime-context-workflow-runtime.ts:207-255` | **KEEP** (shrinks) | engine lifecycle/wiring (allowed) |
| S9 | `ToolCallWorkflow` (per-tool-call workflow) | `workflows/tool-call.ts:16`; driven from `host-sdk/.../toolkit-layer.ts:76-103` | **DELETE-AFTER** | owning workflow channel/table seam (`PHASE_6.14-1`) |
| S10 | `WaitForWorkflow` (per-wait workflow) | `workflows/wait-for.ts:46` | **DELETE-AFTER** | owning workflow observation seam (`PHASE_6.10-1`) |
| S11 | Control-request workflows: `RuntimeContextProvisionWorkflow`, `RuntimeStartWorkflow`, `RuntimeLifecycleWorkflow` | `workflows/runtime-control-request.ts:50,59,68` | **STOP-AND-RE-EVALUATE** | HostKernelWorkflow control plane |
| S12 | ACP edge receipts / output forwarding | `host-sdk/src/host/acp-stdio-edge.ts:300-355` | **KEEP** (edge) + **COLLAPSE** consumption | consumes Phase 0B incremental after-stream/cursor |
| S13 | Channel router (`RuntimeChannelRouter`) | `host-sdk/src/host/channel.ts:10-73` | **KEEP** | — (this is the target's public surface) |
| S13b | Deprecated `RuntimeContextMcpChannelCatalog` shim | `channel.ts:25-76` | **DELETE-AFTER** | `RuntimeChannelRouter.route` |

## Per-surface detail

### S1 — `RuntimeContextWorkflowNative` — KEEP
The runtime-context workflow is the canonical **owned durable resource** (one execution per `contextId`, `idempotencyKey = runtimeContextWorkflowExecutionId(contextId)`, `runtime-context.ts:881`). It satisfies `WORKFLOW_ADMISSION.1` directly. The migration is entirely *internal* to its body (S2, S3) — the workflow identity stays.

### S2 — input cursor — COLLAPSE
`runMergedEventLoop` seeds an in-memory `Ref` (`runtime-context.ts:820`) at `lastProcessedInputSequence: -1` / `lastProcessedOutputSequence: -1` (`:347-349`) and re-derives position on every replay. The Phase 0A reference puts the cursor in **table state** (`sessions.nextInputSequence`, SDD §"Target State Model"). Collapse target: a workflow-owned `inputs` collection where the workflow reads `sequence === nextInputSequence` (SDD `nextInputForSession`) and advances the cursor via `sessions.upsert`. This deletes the volatile-cursor half of the `tf-7kq8` failure class (oracle doc, guarantee 1).

### S3 — output observation — COLLAPSE (Phase 0B)
`completedRuntimeOutput` (`runtime-context.ts:274-298`) calls `RuntimeAgentOutputAfterEvents.initial(...)` — a **live, non-memoized full-table scan** (`per-context-output.ts:110-140`) on the workflow replay path, the only loop op not wrapped as an `Activity`. This is the source-verified `tf-7kq8` root (triage doc §"SOURCE-VERIFIED", live: 1987 `agent_output.initial` spans for ~107 outputs). Collapse target: the Phase 0B **`DurableOutputCursor`** — durable position + journaled `next()` indexed at `position+1`, wait keyed by `position+1` (oracle doc §"The primitive"). **Boundary: this map does not edit the `tf-7kq8` output-observation patch surface or the `tf-ly2g` output-result surface — it only records the classification.**

### S4 — `appendRuntimeInputDeferred` — DELETE-AFTER
The SDD names this explicitly: *"`appendRuntimeInputDeferred` is treated as the production bridge this reference is trying to make unnecessary."* It mints a `sequenced` row and completes a numbered deferred (`runtime-input-deferred.ts:131-148`). It is a **forbidden symbol** in the target (feature `PHASE_0_TARGET_REFERENCE.6`; SDD §"Forbidden symbol references"). Replacement: the channel binding writes `inputs.insertOrGet({ inputKey, sessionId, sequence, … })` (SDD §"Channel Binding Sketch"). Delete only after the binding+table seam (Stage 2) is live and the workflow body reads from the table (S2).

### S5 / S5b — `WorkflowEngineTable.deferreds` — split classification
- **S5 (DELETE-AFTER):** `runtimeInputRowsForContext` (`runtime-input-deferred.ts:75-92`) scans `table.deferreds` filtered to `runtime-context/<contextId>/input/` and reduces to compute `nextSequence`. This is the "deferred rows as numbered input mail slots" the SDD rejects and a **forbidden symbol** (`WorkflowEngineTable.deferreds`). Goes away with S4.
- **S5b (KEEP):** the deferreds table as the engine's **genuine durable-wait store** (`DurableClock.sleep`, suspended `DurableDeferred.await`) stays. SDD §"Production Migration Signal": *"Durable waits, clocks, and Effect workflow internals may still use deferreds where the primitive is actually a suspended wait. The reference rejects deferreds as the ordinary mailbox for semantic workflow input."* The distinction is **mailbox vs. suspension**, not the table.

### S6 — input intents + dispatcher — COLLAPSE then DELETE-AFTER
`RuntimeInputIntentDispatcherLive` (`runtime-context-workflow-runtime.ts:410-429`) streams `RuntimeControlPlaneTable.inputIntents` and demuxes each to `dispatchIntent` → `appendIntentToExecution` → `appendRuntimeInputDeferred` (`:151-178,336-359`). Both `RuntimeInputIntentDispatcherLive` and `RuntimeControlPlaneTable.inputIntents` are **forbidden symbols** in the target. This is the SDD's outer mailbox: `channel -> input intent -> dispatcher -> deferredDone -> await input/N`. Collapse target: the channel binding writes the workflow-owned `inputs` table directly; the dispatcher fiber and the intent row family are deleted. **Gated on Finding F3 (engine.signal / table-write wakeup)** — see findings.

### S7 — `RuntimeContextWorkflowRuntime` coordination — mixed
SDD §"Production Migration Signal" calls this out by name: *"the active-execution map, workflow-support registry, reconcile pass, and intent dispatcher each have a clear replacement in workflow-owned table mechanics or have been deleted."*
- **active-execution `Map` (`:185`, `ensureActiveHandle :257-297`):** as *host-engine keying by `contextId`* it is `BOUNDARIES.6-1` compliant (one host-scoped engine, executions keyed by contextId) — **KEEP** for V0. As a *correctness fence for whether a context is executing*, it collides with `PHASE_5_HOST_WORKFLOW.2` ("HostWorkflow does not use app-local in-memory sets as a correctness fence") — **STOP-AND-RE-EVALUATE** under the HostKernelWorkflow direction.
- **reconcile pass (`:306-334`):** exists to replay intent rows into deferreds at startup. Once inputs live in the workflow-owned table (S2/S6), the workflow reconstructs progress from its own table on replay; reconcile becomes redundant — **DELETE-AFTER**.

### S8 — workflow-support registry — KEEP (shrinks)
`buildWorkflowSupport` + `workflowSupportRegistered` + the semaphore (`:207-255`) is engine **lifecycle/wiring** ("engine wires table + workflow lifecycle", SDD §"Engine Wiring") — allowed. It shrinks naturally: once S9/S10 delete the operation-shaped tool/wait workflows, the only registered workflow per host is the runtime-context workflow.

### S9 — `ToolCallWorkflow` — DELETE-AFTER
`Workflow.make({ name: "firegrid.agent-tool-call", idempotencyKey: ({ toolUseId }) => toolUseId })` (`tool-call.ts:16-21`) is **one workflow execution per tool call** — operation-shaped. `WORKFLOW_ADMISSION.1` ("tool calls are not sufficient workflow identities"), `.3` ("operation-shaped workflows currently present in production are migration debt, not precedent"), and `PHASE_6_AGENT_TOOLS.14-1` ("Toolkit handlers do not create operation-shaped workflows for ordinary tool calls") all converge on deletion. It is driven from `toolkit-layer.ts:76-103` (`ToolCallWorkflow.execute` per `handleTool`). Replacement: lower validated tool invocations into the owning runtime-context workflow's channel/table seam. Delete after that seam exists.

### S10 — `WaitForWorkflow` — DELETE-AFTER
`Workflow.make({ name: "firegrid.agent_tools.wait_for", idempotencyKey: ({ executionKey }) => … })` (`wait-for.ts:46-52`) is per-wait operation-shaped; `PHASE_6_AGENT_TOOLS.10-1` requires `wait_for` to lower "through the channel/runtime observation surface owned by the active workflow state machine. It must not introduce a standalone operation workflow." Note its `matchOrTimeoutActivity` uses `Stream.runHead` over a live source (`wait-for.ts:84-94`); it is wrapped in an `Activity` (so the result is replay-memoized — not a `tf-7kq8`-class amplifier today), but the **workflow wrapper** is the debt. Delete after the owning-workflow observation seam exists.

### S11 — control-request workflows — STOP-AND-RE-EVALUATE
`RuntimeContextProvisionWorkflow` / `RuntimeStartWorkflow` / `RuntimeLifecycleWorkflow` (`runtime-control-request.ts:50,59,68`) are backed by request rows + `RuntimeControlRequestCompletionRowSchema` (request/claim/completion families). By `WORKFLOW_ADMISSION.1` lifecycle requests are not workflow identities. The standing control-plane direction (memory: *control plane = HostKernelWorkflow*) wants cancel/close/resume/lifecycle to **signal a long-running HostKernelWorkflow that owns the control rows privately**, not to spawn per-request workflows. That is a separate SDD, not a Phase 0C mechanical collapse — flag and leave (Finding F4).

### S12 — ACP edge receipts — KEEP (edge) + COLLAPSE consumption
`acp-stdio-edge.ts` is a legitimate transport edge (not a workflow), so it stays. But `waitForAgentOutput` (`:300-316`) **re-creates `binding.stream` and runs `Stream.runHead` on every loop iteration**, filtering `observation.sequence > session.lastSequence` with `lastSequence` held in a volatile `EdgeSession` field (`:338`). This is the **consumer-side analogue** of the `tf-7kq8` re-subscription class — each turn iteration re-subscribes from the source head. The edge is not durably replayed so the volatile cursor is acceptable, but the per-iteration full re-subscription should consume the Phase 0B **incremental after-stream / cursor** once it lands (Finding F5). Classification: KEEP the edge; COLLAPSE its consumption onto the Phase 0B surface. Not a Phase 0C code change here.

### S13 / S13b — channel router — KEEP / DELETE-AFTER shim
`RuntimeChannelRouter` (`channel.ts:10-21,65-73`) is exactly the target's **public semantic surface / edge dispatch** (SDD §"Channel Router": "decodes target + verb + payload, validates the route, emits dispatch spans, invokes the typed channel binding; does not know workflow names, execution ids, deferred names, table collection names, stream URLs"). **KEEP** — this is what the target wants more of. The `@deprecated RuntimeContextMcpChannelCatalog` / `findRuntimeContextMcpChannel` shims (`channel.ts:25-76`) are **DELETE-AFTER** once remaining catalog call sites move to `RuntimeChannelRouter.route`.

## Findings — missing primitives (name, don't code around)

- **F1 — Workflow-owned runtime input table is absent in production.** `RuntimeContextWorkflowNative` has no `inputs`/`events` DurableTable of its own; input arrives via the deferred-name mailbox (S4/S5/S6). Phase 0A proved the shape in `tiny-firegrid` (`SessionTable.inputs` + `sessions.nextInputSequence`); production needs the equivalent owned table before S2/S4/S6 can cut over. Naming it (e.g. a runtime-context-owned session table with `inputs` + cursor columns) is the Phase 0C design step, not something to bridge around with another deferred family.
- **F2 — `DurableOutputCursor` is specified, not yet a production primitive.** Named in the Phase 0B oracle (durable position + journaled `next()`); it is the `tf-ly2g` target on the #607/#610 baseline. S3 depends on it.
- **F3 (load-bearing) — no `engine.signal` / table-write wakeup primitive.** `BOUNDARIES.7-1` is explicit: *"Until an engine.signal primitive exists, the host-scoped RuntimeContext engine may deliver input intents by completing context-scoped workflow deferreds in the shared engine table."* The deferred mailbox (S4/S5/S6) **cannot be fully deleted** until either (a) the workflow body reads its own `inputs` table with a table-write-driven resume, or (b) `engine.signal` exists. This primitive gates Stage 3. Do not delete the deferred path before one of these lands; record it as the blocking dep on the S4/S6 deletion beads.
- **F4 — HostKernelWorkflow control plane not present.** The control-request workflows (S11) and the in-memory active-execution fence (S7) want the HostKernelWorkflow direction; that is a separate SDD (control-plane memory). Out of Phase 0C scope.
- **F5 — ACP edge consumes output by per-iteration re-subscription.** `acp-stdio-edge.ts:300-309` re-creates the stream + `Stream.runHead` each loop; should consume the Phase 0B incremental after-stream/cursor (S12). Finding, not a Phase 0C change.

## Staged migration order

Each DELETE-AFTER is a **transactional cutover**: it lands only as a direct cutover with an owner + a deletion bead + a blocking dep on its replacement (transactional-cutover rule). A broad surface (e.g. "delete the deferred mailbox") must not close as "superseded" by a narrow slice without the remainder filed as a new BLOCKING bead first.

1. **Stage 0B — output observation (Phase 0B).** Land `DurableOutputCursor` (F2) and the workflow-owned output append log. Fixes `tf-7kq8`; collapses S3. *Blocking dep for the `VALIDATION.10-1` O(outputs) gate.* This map does not edit those surfaces (`tf-7kq8` / `tf-ly2g`).
2. **Stage A — workflow-owned input table (F1).** Introduce the runtime-context-owned `inputs` collection + cursor-in-table-state; have `RuntimeContextWorkflowNative` read inputs by `nextInputSequence` (collapses S2). Channel binding writes via `insertOrGet` (additive — both paths coexist).
3. **Stage B — wakeup primitive (F3).** Land `engine.signal` or table-write-driven resume so the workflow wakes on `inputs` writes without a deferred. **Gates Stage C.**
4. **Stage C — delete the input mailbox bridge.** Remove `appendRuntimeInputDeferred` (S4), the `deferreds` input scan (S5), `RuntimeInputIntentDispatcherLive` + `RuntimeContextInput.dispatchIntent` + `RuntimeControlPlaneTable.inputIntents` (S6), and the reconcile pass (S7-reconcile). Each blocked-on Stage A+B. Verifies forbidden-symbol checks (`PHASE_0_TARGET_REFERENCE.6`).
5. **Stage D — collapse operation-shaped tool/wait workflows.** Lower `ToolCallWorkflow` (S9) and `WaitForWorkflow` (S10) into the owning workflow channel/table seam (`PHASE_6.14-1`/`.10-1`); delete after. Registry (S8) shrinks to the runtime-context workflow.
6. **Stage E — control plane (STOP-AND-RE-EVALUATE).** Control-request workflows (S11) + in-memory fence (S7) under a HostKernelWorkflow SDD (F4). Not Phase 0C.

Edge consumption (S12/F5) folds in opportunistically after Stage 0B; the channel router (S13) needs no migration beyond retiring the deprecated catalog shim (S13b).

## Sources

Source-verified against `origin/main` at `bfc52f35d` (the base this branch forked from):
`packages/runtime/src/workflow-engine/workflows/runtime-context.ts`, `.../tool-call.ts`, `.../wait-for.ts`, `.../runtime-control-request.ts`, `packages/runtime/src/workflow-engine/runtime-input-deferred.ts`, `packages/runtime/src/kernel/runtime-context-workflow-runtime.ts`, `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`, `packages/host-sdk/src/host/acp-stdio-edge.ts`, `packages/host-sdk/src/host/channel.ts`; `docs/sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md`; `docs/investigations/2026-05-21-phase0b-output-replay-oracle.md`; `docs/investigations/2026-05-21-live-acp-tool-call-triage.md`; `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml` (`PHASE_0_TARGET_REFERENCE`, `PHASE_0B_OUTPUT_RESULT_RETURN`, `PHASE_6_AGENT_TOOLS`, `BOUNDARIES`, `WORKFLOW_ADMISSION`).
