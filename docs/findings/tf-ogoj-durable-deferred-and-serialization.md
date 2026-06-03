# tf-ogoj — DurableDeferred + per-key serialization workbench (trace evidence)

- **Date:** 2026-06-02
- **Kind:** tiny-firegrid WORKBENCH finding (methodology.md "The workbench pattern"). The
  trace is the deliverable; this prose interprets confirm/reject. The sim emits **no**
  `claimStatus`/verdict object.
- **Sim:** `packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/`
- **Run:** `2026-06-02T23-54-22-805Z__durable-deferred-and-serialization`
  (`packages/tiny-firegrid/.simulate/runs/<runId>/trace.jsonl`)
- **Backs:** `docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md` §2 (the
  "`signal.ts` is a second implementation of the `WorkflowEngine` seam" reframe) and §2.4
  (per-`contextId` serialization is an OPEN gap, not given by `idempotencyKey + cursor`).

## What the sim does

Host composes the REAL `FiregridRuntime` factory and overrides only the inbound
session-input channels to route public prompts to two workbench workflows on the real
`DurableStreamsWorkflowEngine`. No fakes; the H2 workflow drives a real ACP example-agent
spawn through the production codec adapter (one `open_byte_pipe` span). Driver is
`@firegrid/client-sdk`-only.

## H1 — `DurableDeferred` await-once rides the real engine — **CONFIRMED**

A `workbench.deferred-gate` workflow makes a `DurableDeferred`, awaits it, and a second
public prompt resolves it via the standard `DurableDeferred.succeed(token)` combinator. The
trace shows the round-trip on the **real** engine, in order:

| trace | span | meaning |
|---|---|---|
| L41 | `firegrid.workflow_engine.deferred.result` (`input-gate`) | first read → **undefined** |
| L42 | `workbench.deferred_gate.body` (`phase=awaiting`) | body **suspends** (`Workflow.suspend`) |
| L55 | `firegrid.workflow_engine.deferred.done` (`input-gate`) | external resolve → `engine.deferredDone` |
| L59 | `firegrid.workflow_engine.deferred.result` (`input-gate`) | resume → reads the **stored exit** |
| L60 | `workbench.deferred_gate.body` (`phase=resumed`, `resolved_value=tf-ogoj-h1-resolved-value`) | body **completes** with the value |

This is exactly the §2.1 claim made observable: the standard `@effect/workflow`
`DurableDeferred` combinator delegates to `engine.deferredResult`/`engine.deferredDone`
(`DurableDeferred.ts:114,176`), and **Firegrid's `DurableStreamsWorkflowEngine` implements
that seam** (`engine-runtime.ts:433,458`). `signal.ts`'s `awaitSignal`/`sendSignal` duplicate
this — they are a second implementation beside a seam Firegrid already implements. **H1
confirms the simplifying hypothesis's foundation.**

## H2 — per-`contextId` serialization under CONCURRENT inputs — **REJECTED** (the load-bearing result)

c71h drove inputs **sequentially** and observed `seq === cursor.consumed` every time. This sim
fires **6 concurrent** same-`contextId` prompts (`idempotencyKey` `h2-0..h2-5`,
`Effect.all({concurrency: "unbounded"})`). The trace shows the `idempotencyKey + cursor` shape
does **NOT** serialize them — it **loses data**:

- **Channel-level seq race → silent input loss.** Each concurrent append computes its seq as
  `nextSeq = count(inputLog rows for contextId)` then `insertOrGet`s `${contextId}:${seq}`. All
  six raced **before any row committed**, so all six read count `0` → all assigned **seq 0** →
  all wrote key `${contextId}:0`. The trace shows **1 `Inserted` + 5 `Found`** on the input-log
  table: **five of the six inputs were silently deduplicated away.** (Read-count-then-write is a
  textbook lost-update race; `insertOrGet`'s dedup turns it into *silent loss*, not an error —
  there are **zero** error/`die` spans in the run.)
- **Workflow-level: no ordered serialization.** Seven `workbench.serialization.execute` calls
  reached the engine (6 h2 + 1 terminal), creating **7 distinct executions** (distinct
  `idempotencyKey`s) — but only **2 bodies ran** (`workbench.serialization.body` = 2: the one
  surviving prompt at seq 0, and the terminal at seq 1). The cursor advanced **exactly once**
  (`advance_cursor` = 1; `consumed` 0→1). So `Workflow.idempotencyKey` did **not** turn six
  concurrent inputs into an ordered, each-advances-the-cursor sequence; it created six racing
  executions that collapsed onto the single surviving input row.

**Interpretation:** `Workflow.idempotencyKey + cursor` is the **execution-identity + state**
shape, **not** a per-`contextId` serialization guarantee. Under concurrency it neither orders
nor preserves the inputs. This **rejects** the assumption the v1 SDD promoted to a fact and
**confirms** SDD §2.4 / the tf-o8zu review finding 4: per-key serialization is a **real open
capability gap** that needs an explicit per-key **owner / atomic-append** discipline at the
**engine seam** — and B "gets it free" only by being the canon-banned single parked body, so
the gap favors **neither** `signal.ts` **nor** B.

> Honest scope note: the channel-level seq race (1 inserted / 5 found, deterministic given the
> non-atomic read-then-write) is the **solid, reproducible** load-bearing datum. The
> workflow-level "7 executions created but only 2 drove a body (no errors)" is reported as
> observed; the precise reason the five collapsed/undriven executions did not each emit a body
> (lazy `discard` drive vs. teardown timing in the embedded sim) is a secondary detail and is
> **not** load-bearing — under either reading, **no clean per-key serialization occurred and
> inputs were lost**. The fix is the same: an explicit per-key owner / atomic append, not a
> seq-count race.

## H3 — non-clock `DurableDeferred` crash-recovery — **public-surface-blocked (not driven)**

The §2.3 question — does the engine resume a workflow that has an already-written **non-clock**
deferred row if the producer crashes *after* writing the row but *before* the trailing
`resume`? — is **not reachable from the airgapped public client surface** (the same class c71h
marked public-surface-blocked: it needs host generation teardown/recovery controls the client
SDK does not expose). **No crash was faked.** Source-grounded status:

- **Persistence is real** [read]: `engine.deferredDone` upserts the deferred row
  (`engine-runtime.ts:473-482`); `deferredResult` reads it on resume (`:433-440`).
- **Resume-on-recovery for non-clock deferreds does NOT exist today** [read]:
  `makeWorkflowEngine`'s startup recovery runs **only** `recoverPendingClockWakeups`
  (`engine-runtime.ts:149-159,527`), which sweeps the `clockWakeups` table. There is no startup
  sweep over the `deferreds` table.

**Where the proof belongs:** a runtime-package engine test
(`packages/runtime/test/workflow-engine/`) that writes a non-clock deferred row, drops the
in-process resume, restarts the engine, and asserts the waiter resumes — paired with the fix
(extend `recoverPendingClockWakeups` to also re-arm pending `deferreds`, or generalize to a
`recoverPendingWakeups` over both tables). This is on the SDD §6 confirm-before-building list.

## Net: does the simplifying hypothesis hold?

**Yes for the seam reframe (H1), and the serialization caveat is now data-backed (H2).**
- H1 **confirms** `DurableDeferred` rides the real engine seam Firegrid implements → `signal.ts`'s
  await/resolve is a second implementation that **dissolves onto the seam** (SDD §2.1-2.2).
- H2 **rejects** "`idempotencyKey + cursor` serializes" → the per-`contextId` serialization gap is
  **real and open**, belongs to the engine seam, and **favors neither option A's cursor nor
  option B's `signal.ts`** (SDD §2.4). A successful rejection: the SDD no longer rests on an
  unproven serialization claim.
- H3 is honestly **deferred** to a runtime-package engine test + the named engine fix (SDD §2.3).

## Sources

`packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/{host,driver,index}.ts` ·
trace `runs/2026-06-02T23-54-22-805Z__durable-deferred-and-serialization/trace.jsonl`
(H1: L41/L42/L55/L59/L60; H2: `serialization.execute`×7, `serialization.body`×2, inputLog
inserted=2/found=5, `advance_cursor`×1, `open_byte_pipe`×1) ·
`repos/effect/packages/workflow/src/DurableDeferred.ts:102-122,176,431-458` ·
`repos/effect/packages/workflow/src/WorkflowEngine.ts:61,140-170` ·
`packages/runtime/src/engine/internal/engine-runtime.ts:149-159,433-440,458-484,527` ·
`packages/runtime/src/engine/internal/table.ts:53-77` ·
`docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md` §2.1-2.4, §9.
