# SDD — Runtime-context input write+arm migration

Status: draft (cutover surface enumerated; implementation is a future
transactional wave, NOT tf-c9r9)
Date: 2026-05-22
Beads: tf-c9r9 (validated the target shape in tiny-firegrid; this SDD scopes the
production cutover)
Depends on: `docs/cannon/architecture/kernel-owned-write-arm.md`,
`docs/cannon/architecture/transactional-cutover-rule.md`

## §0 — Load-bearing decision

Migrate the runtime-context **input** path from the per-sequence
`DurableDeferred` mailbox to a **workflow-owned table input + kernel-owned
write+arm** (the shape validated green in
`packages/tiny-firegrid/src/simulations/kernel-owned-write-arm/`). The body parks
on a table read (`Workflow.suspend`), and a single serialized kernel command
writes the input row and arms the owning execution as one durable fact, with
restart recovery replaying only owned pending facts. The mailbox + intent-stream
dispatcher is the path being retired.

This SDD does **not** implement the cutover. It enumerates the exact production
surface so the cutover lands as one transactional wave (per the cutover rule —
no half-ship).

## Current production path (to retire)

The runtime-context body waits on a **per-sequence `DurableDeferred` mailbox**,
not a table input:

| Concern | Location | Behavior |
|---|---|---|
| Body await | `packages/runtime/src/workflow-engine/workflows/runtime-context.ts:208-221` (`awaitRuntimeInput`) | `DurableDeferred.await(runtimeInputDeferredFor(contextId, sequence))` — suspends on a per-sequence deferred. |
| Replay-safe read | `runtime-context.ts:223-250` (`completedRuntimeInput`) | reads `engine.deferredResult(...)`. |
| Deferred factory | `runtime-context.ts:200-206` (`runtimeInputDeferredFor`) | `DurableDeferred.make(inputWaitName(contextId, sequence), {success: RuntimeIngressInputRowSchema})`. |
| Write **and** arm (coupled in one call) | `packages/runtime/src/workflow-engine/runtime-input-deferred.ts:94-171` (`appendRuntimeInputDeferred`) | sequences the input, then `engine.deferredDone(...)` writes the deferred row (exit = the sequenced input row) **and** resumes the body. Idempotent (dedup by `inputId`; deferredDone first-writer-wins). |
| Arm trigger (dispatcher) | `packages/runtime/src/kernel/runtime-context-workflow-runtime.ts` (`RuntimeInputIntentDispatcherLive`, `dispatchIntent`, `appendIntentToExecution`) | a forked daemon subscribes to `RuntimeControlPlaneTable.inputIntents.rows()` and calls `appendRuntimeInputDeferred` per intent. Replays all intent rows on restart (re-subscribe from start) — the current recovery mechanism. |
| Edge write (intent) | `packages/host-sdk/src/host/commands.ts:115-132` (`insertRuntimeInputIntent`), `:260-270` (`appendRuntimeIngress`); also `runtime/src/channels/session-permission.ts:46-62`, `runtime/src/agent-event-pipeline/authorities/scheduled-prompt-append.ts:34-42` | `control.inputIntents.insertOrGet(intent)` — idempotent intent write at the edge. |
| Authority position | `kernel/runtime-context-workflow-runtime.ts` (`RuntimeContextWorkflowRuntimeLive`) | owns the host-scoped engine + active-execution map; holds the engine reference and execution identity to drive write+arm. The old-shape position; there is no `HostKernelWorkflow` symbol. |

Note: the production path is already crash-recoverable *via the mailbox* (the
dispatcher re-subscribes to `inputIntents` on restart and re-delivers
idempotently). The migration is not a bug-fix; it removes the mailbox in favor of
the table-wait + owned-fact model so input has the same workflow-owned table
shape as the rest of the runtime, with bounded kernel-owned recovery.

## Target path (validated shape)

Mirror `kernel-owned-write-arm` sim into production:

1. **Body parks on a table input.** Replace `awaitRuntimeInput`/
   `completedRuntimeInput` with a point-read of a workflow-owned runtime-context
   input row keyed by `(contextId, sequence)`; absent ⇒ `Workflow.suspend`;
   present ⇒ proceed. Remove `runtimeInputDeferredFor` and the per-sequence
   `DurableDeferred`.
2. **Kernel-owned write+arm command + control table.** Introduce a kernel-private
   table of write+arm facts (`{commandKey, contextId, executionId, sequence,
   inputRef, status}`). The kernel command: record the fact → write the
   workflow-owned input row (`insertOrGet`) → arm via `engine.resume(executionId)`.
   This replaces `appendRuntimeInputDeferred`'s `deferredDone`.
3. **Restart replay of owned facts.** In the kernel layer
   (`RuntimeContextWorkflowRuntimeLive`), after engine build + workflow
   registration, replay pending owned facts (input present, execution not
   `finalResult`) → re-write + re-arm. Replaces the dispatcher's re-subscribe-all
   recovery. Bounded to owned facts; no generic sweep.
4. **Edge unchanged in spirit.** Edge still records the intent; the kernel
   command consumes the intent and performs the durable write+arm. The
   `inputIntents` edge write (`commands.ts:115-132`, `session-permission.ts`,
   `scheduled-prompt-append.ts`) stays as the request channel; the dispatcher's
   `deferredDone` is replaced by the kernel write+arm.

## Cutover surface (files that must change together)

- `runtime/src/workflow-engine/workflows/runtime-context.ts` — body await → table read.
- `runtime/src/workflow-engine/runtime-input-deferred.ts` — **delete/replace**; `deferredDone` write+arm → kernel command write+arm. (Retire `runtimeInputDeferredFor`, `appendRuntimeInputDeferred`, `runtimeInputDeferredName`.)
- `runtime/src/kernel/runtime-context-workflow-runtime.ts` — dispatcher (`RuntimeInputIntentDispatcherLive`, `dispatchIntent`, `appendIntentToExecution`) → kernel write+arm controller + restart replay; add kernel control table to the kernel layer.
- `runtime/src/workflow-engine/internal/table.ts` — add the kernel write+arm control row schema (kernel-private) + the workflow-owned runtime-context input row schema (if not already a table row).
- Callers of the edge intent write are unaffected by signature (`commands.ts`, `session-permission.ts`, `scheduled-prompt-append.ts`), but the delivery semantics behind them change.
- Tests/contracts referencing `runtimeInputDeferred*` / `firegrid.runtime_context.workflow.input.await|completed` seam spans (e.g. tf-mmh2 contract annotations) must be re-pointed to the table-wait + write+arm seams.

## Constraints (carried from the architecture canon)

- No input deferred mailbox in the target.
- No generic resume-all engine sweep (recovery keyed off owned facts).
- No ordering authority (facts independent; kernel is not a sequencer). The
  existing per-sequence numbering, if retained, is a body/edge concern, not a
  kernel ordering guarantee.
- Transactional: the mailbox path (`runtime-input-deferred.ts` + dispatcher) is
  removed in the same wave that lands the table-wait + kernel write+arm, or
  retired behind a named compatibility boundary with a blocking deletion bead.

## Open questions for the cutover wave

1. **Multi-input sequencing.** The reference sim is single-input per execution.
   Runtime-context takes a sequence of inputs; the table-input + write+arm model
   needs a per-sequence input row and a body loop that point-reads the next
   sequence. Confirm this stays free of kernel-side ordering authority (the body
   advances its own sequence cursor; the kernel only writes+arms a given
   sequence's row).
2. **Output path interaction.** This SDD covers the INPUT path only. The output
   cursor work (tf-aseo / DurableOutputCursor) is independent; confirm no shared
   deferred assumptions break when the input mailbox is removed.
3. **Intent → command handoff identity.** Confirm the kernel can resolve the
   owning `executionId` (`runtime-context:{contextId}`) and the engine reference
   for every intent source (edge prompt, permission response, scheduled prompt)
   at the point it performs write+arm.
