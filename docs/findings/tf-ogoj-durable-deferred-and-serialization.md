# tf-ogoj — DurableDeferred + per-key serialization workbench (trace evidence)

- **Date:** 2026-06-02
- **Kind:** tiny-firegrid WORKBENCH finding. The trace is the deliverable; this prose
  interprets confirm/reject. No `claimStatus`/verdict object in the sim.
- **Sim:** `packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/`
- **Runs:** v1 (confounded) `2026-06-02T23-54-22-805Z`; **v2 (isolated, authoritative)
  `2026-06-03T00-34-47-402Z`** (`packages/tiny-firegrid/.simulate/runs/<runId>/trace.jsonl`)
- **Backs:** `docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md` §2.1 (the
  "`signal.ts` is a second implementation of the `WorkflowEngine` seam" reframe) and §2.4
  (per-`contextId` serialization).

## Calibration note — v1 was confounded; this finding is the isolated v2

The **v1** run measured a race in the **sim's own channel seq-assignment**
(`nextSeq = count(rows)` then `insertOrGet`) — a workbench artifact, not production. It
made the wrong headline ("`idempotencyKey + cursor` does not serialize → data loss"). v2
**removes that confounder entirely**: there is no input-log and no count-then-insert; the
channel just `execute`s the workflow with the input in the payload, so the **only shared
mutable state is the per-`contextId` cursor**. The conclusion below **reverses** v1's
cursor claim and isolates the *real* hazard.

## H1 — `DurableDeferred` await-once rides the real engine — **CONFIRMED**

A `workbench.deferred-gate` workflow makes a `DurableDeferred`, awaits it, and a second
public prompt resolves it via `DurableDeferred.succeed(token)`. The round-trip runs on the
**real** `DurableStreamsWorkflowEngine`: `firegrid.workflow_engine.deferred.result`
(undefined → suspend) → `…deferred.done` (external resolve) → `…deferred.result` (resolved →
resume) → the body completes with the value (v2: `deferred.result`×2, `deferred.done`×1).
This makes §2.1 observable: the standard `@effect/workflow` combinator delegates to
`engine.deferredResult`/`engine.deferredDone` (`DurableDeferred.ts:114,176`), and Firegrid's
engine **implements that seam** (`engine-runtime.ts:433,458`). `signal.ts`'s
`awaitSignal`/`sendSignal` are a second implementation of it. **H1 confirms the reframe's
foundation.**

## H2 — per-`contextId` serialization under CONCURRENT inputs — **two findings, one reversal**

Driver fires **6 concurrent** same-`contextId` prompts (`idempotencyKey` `h2-0..h2-5`,
`Effect.all({concurrency: "unbounded"})`). The per-event workflow body (keyed
`(contextId,inputKey)`) reads then advances the durable cursor, then `startOrAttach` +
`send`. Trace facts (v2):

**(1) The durable cursor SERIALIZES — v1 reversed.** The 5 h2 executions that drove a body
ran **concurrently** (all `workbench.serialization.body` spans start within ~1 ms and fully
overlap, ~315 ms each) — yet each read a **distinct, sequential** `cursor_at_entry`:

| body | `cursor_at_entry` | `cursor_after` |
|---|---|---|
| h2-1 | 0 | 1 |
| h2-2 | 1 | 2 |
| h2-3 | 2 | 3 |
| h2-4 | 3 | 4 |
| h2-5 | 4 | 5 |
| terminal | 5 | 6 |

No repeated reads, no lost updates — the cursor advanced cleanly 0→6 under genuine
concurrency. The durable-table read-modify-write on a **single row** is serialized by the
durable-streams transactional backend (the `awaitTxId` commit path), so the cursor is **not**
the per-key hazard v1 claimed. **v1's "cursor doesn't serialize" was an artifact of the
sim's seq-race, not the cursor.**

**(2) The REAL per-`contextId` race is the adapter `startOrAttach` TOCTOU.** All **6**
`firegrid.unified.adapter.start_or_attach` spans are for the **one** contextId, but the trace
shows **5 distinct `open_byte_pipe` spawns and 5 distinct `firegrid.process.id`s** — i.e.
**five `claude-agent` processes were spawned for one logical session** (four leaked). Cause:
`ProductionCodecAdapterLive.startOrAttach` does a non-atomic `Ref.get(registry)` → `if
(existing) return` → *build/spawn* → `Ref.update(registry, set)`
(`codec-adapter.ts:408-440`). Five concurrent per-event executions all read an empty registry
before any committed, so all five spawned. **This is exactly the production TOCTOU
`runtime-context.ts:66` says the parked body's `idempotencyKey` `(contextId, attempt)`
prevents** — "kills the production TOCTOU that spawned two `claude-agent-acp` processes for
one logical session." The **single-execution parked body (B) gets a single `startOrAttach`
for free; the per-event shape (A), with N executions per `contextId`, re-introduces the
race.**

**(3) The client (`firegrid.ts`) did NOT serialize the prompts.** All 6
`session_prompt.append` spans start within ~1 ms; the per-handle `session.prompt` path is
stateless (no mutex/queue) — so the concurrency was real, not masked upstream. One of the 6
(`h2-0`) returned its `execute({discard})` in ~4.5 ms without driving a body (the other 5
joined their body fibers, ~333 ms) — a minor engine artifact under concurrency (5 of 6
concurrent discard-executes drove a body); it does not affect findings (1) or (2).

### Net for §2.4 / §0.1 (corrected, decision-grade)

The per-`contextId` serialization question splits cleanly:
- **Cursor / durable state: serializes** (durable-streams single-row tx). The per-event
  `(state, event)` cursor is **safe** under concurrency. So §2.4's worry was mis-located by
  v1: `idempotencyKey + cursor` *state* is fine.
- **Process/session lifecycle: races under the per-event shape.** The adapter
  `startOrAttach` registry is an **in-memory `Ref` TOCTOU** that the parked body (B) hides
  behind one execution per `contextId`. **Option A's real cost is making `startOrAttach`
  idempotent/atomic per `contextId`** (a per-key spawn lock, or an atomic get-or-create on
  the registry) — a cost B got for free. This is a concrete, nameable §0.1 input that the v1
  framing missed entirely, and it is *more* useful than the v1 "rejection."

## H3 — non-clock `DurableDeferred` crash-recovery — **public-surface-blocked (not driven)**

Unchanged from v1: not reachable from the airgapped public client surface; no crash faked.
Source status: deferred-row **persistence is real** (`engine.deferredDone` upserts,
`engine-runtime.ts:473-482`; `deferredResult` reads, `:433-440`), but **resume-on-recovery
for non-clock deferreds does NOT exist** — startup recovery runs only
`recoverPendingClockWakeups` (`:149-159,527`). The proof belongs in a runtime-package engine
test + the fix (extend `recoverPendingClockWakeups` to the `deferreds` table). SDD §6
confirm-item.

## Does the simplifying hypothesis hold?

- **H1 — YES.** `DurableDeferred` rides the real engine seam Firegrid implements → `signal.ts`
  await/resolve dissolves onto the seam (§2.1-2.2).
- **H2 — corrected.** The cursor serializes; the per-event shape's real concurrency hazard is
  the **adapter `startOrAttach` TOCTOU**, which §0.1 option A must close (and B avoids by
  construction). The SDD no longer rests on the v1 (confounded) "cursor doesn't serialize"
  claim.
- **H3 — deferred** to a runtime-package engine test + the named engine fix (§2.3).

## Sources

`packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/{host,driver,index}.ts` ·
v2 trace `runs/2026-06-03T00-34-47-402Z__durable-deferred-and-serialization/trace.jsonl`
(H1 `deferred.result`×2/`deferred.done`×1; H2 `serialization.body`×6 with `cursor_at_entry`
0–5 distinct; `adapter.start_or_attach`×6 same contextId; `open_byte_pipe`×5 + 5 distinct
`firegrid.process.id`; `session_prompt.append`×6 within ~1 ms) ·
`packages/runtime/src/unified/codec-adapter.ts:408-440` (the `startOrAttach` `Ref` TOCTOU) ·
`packages/runtime/src/unified/subscribers/runtime-context.ts:66` (idempotencyKey kills the TOCTOU) ·
`packages/client-sdk/src/firegrid.ts:1340-1351` (stateless per-handle prompt path) ·
`repos/effect/packages/workflow/src/DurableDeferred.ts:102-122,176` ·
`packages/runtime/src/engine/internal/engine-runtime.ts:149-159,290-294,433-440,458-484,527` ·
`docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md` §2.1-2.4, §9.
