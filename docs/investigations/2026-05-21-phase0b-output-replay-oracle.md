# Phase 0B output-replay amplification oracle — finding + primitive spec (2026-05-21)

**Bead:** `tf-q4uz` (P0 de-risk/prototype for `tf-ly2g`).
**Status:** prototype + spec complete; oracle GREEN.
**Audience:** lane 2 (`tf-ly2g`, the real Phase 0B target-reference on the #607
Phase 0A baseline). This is the additive-constraint + primitive contract lane 2
asked for.

## TL;DR

The `tf-7kq8` hang is one structural class, not a tuning bug: **output
observation cost scales with workflow replays × output history instead of with
the number of distinct outputs.** This doc (a) states that class in clean-room
terms, (b) names the durable-cursor primitive that makes it *structurally
impossible*, and (c) ships a runnable oracle that gates the O(outputs)
invariant. Treat today's `runtime-context.ts` output loop as the **failure
specimen**, not as the design to preserve.

Oracle verdict (`pnpm --filter @firegrid/tiny-firegrid simulate:run
phase0b-output-replay-oracle`): `GREEN-ORACLE-VALID` — the candidate primitive
holds `O(outputs)`; the specimen violates it; the specimen's cost scales with
turn length while the candidate's stays flat at 1.0 read/output.

| D (turn length) | specimen reads/output | candidate reads/output |
| ---: | ---: | ---: |
| 4 | 2.50 | 1.00 |
| 8 | 4.50 | 1.00 |
| 16 | 8.50 | 1.00 |
| 32 | 16.50 | 1.00 |
| 64 | 32.50 | 1.00 |

Specimen amplification = `(D+1)/2` — it grows without bound in turn length.
This is the clean-room analogue of the live trace's 1987 `agent_output.initial`
spans for ~107 real outputs (`docs/investigations/2026-05-21-live-acp-tool-call-triage.md`).

## The failure class (clean-room)

A durable workflow body must consume an **append-only output log** and deliver
each distinct output exactly once, until a terminal output (TurnComplete). Under
`@effect/workflow` (and Temporal-style engines generally) the body **re-executes
top-to-bottom on every replay/resume**; only Activities and durable primitives
are memoized. Each newly appended output resumes the parked workflow → one
replay per append.

`tf-7kq8` is the conjunction of exactly two conditions (both source-verified
against `packages/runtime/src/workflow-engine/workflows/runtime-context.ts` in
the triage doc):

1. **Volatile cursor.** The "last delivered sequence" lives in an in-memory
   `Ref` seeded `-1` (`runtime-context.ts:820`, init `:349`). It does **not**
   survive replay, so each resume re-derives position by re-walking the log from
   the start.
2. **Live read on the replay path.** "Find the next output" is a plain,
   non-memoized Effect (`runtime-context.ts:749/762` → `events.initial`,
   `per-context-output.ts:110-140`) and is a **full output-table scan**. It
   re-executes on every replay.

Conjunction ⇒ replay `r` (head `= r-1`) re-reads `r` elements; a turn of `D`
outputs costs `Σ(1..D) = D(D+1)/2` reads = **O(resumes × history)**. The
earliest sequences are re-read the most (the "decay" signature in the triage).
The terminal output never gets delivered cleanly inside the edge's turn timeout.

## The invariant

> **O(outputs):** total output-log reads across a turn is bounded by
> `distinctOutputs × c` for a small constant `c`, and is **independent of the
> number of replays/resumes**.

Operationalized as a gate: `amplification = logReads / distinctOutputs`. A
replay-safe output path must hold `amplification ≤ 2` **and** deliver every
distinct output exactly once **and** deliver TurnComplete exactly once. The
specimen blows the ratio; the candidate sits at `1.0`.

## The primitive: `DurableOutputCursor`

A workflow-owned, replay-safe iterator over the append-only output log. One
operation, observed from inside the workflow body:

```
cursor.next(): Effect<Option<{ sequence: number; output: AgentOutput }>>
// Option.none  => terminal/closed (TurnComplete consumed); body completes.
// Suspends durably when no output past the cursor exists yet.
```

It makes `tf-7kq8` impossible by construction via five guarantees. Guarantees
1–2 each independently kill one of the two failure conditions; 3–5 keep genuine
work O(1) per output and delivery exactly-once.

1. **Durable position.** The cursor's delivered position is durable workflow
   state, reconstructed from the journal on replay — never an in-memory `Ref`
   re-seeded each replay. Replay cannot reset the cursor to `-1`.
2. **Replay-memoized read.** Each `next()` is a journaled step (Activity- /
   DurableDeferred-shaped). On replay, the Nth `next()` returns the **recorded**
   result with **zero log touches**. There is no live scan on the replay path to
   re-run.
3. **Indexed, not full-scan.** A genuine (first-execution) `next()` reads exactly
   the one element at `position+1` (point/range-after-1 lookup), never a
   reduce-over-all-rows. Each genuine read is O(1) in history.
4. **Wait keyed by position.** When the log has nothing past the cursor, `next()`
   parks on a durable wait woken by the append at `position+1` — not a
   from-sequence-0 re-subscription. One wake per genuine append.
5. **Exactly-once delivery.** Position advances are journaled and idempotent, so
   a delivered sequence is never re-delivered across replay or host restart.
   TurnComplete is delivered exactly once.

The deep reframe: **the cursor position is the workflow's durable iteration
state, and reading is a journaled step.** Once both hold, "re-walk history on
replay" is not expressible — there is no live scan and no volatile position to
reset. The amplification term `resumes × history` collapses because `history`
never enters the per-resume cost. This is *not* "call `events.after` more": the
existing `.after` stream is incremental, but it is consumed inside a body that
re-creates it from a volatile seed every replay, and the `initial` probe beside
it is a full scan. The fix is to make the cursor a durable primitive whose
`next()` is journaled so replay never re-enters the read at all.

## Mapping onto `@effect/workflow` (for the #607 baseline)

A concrete shape lane 2 can build directly:

- **Position** = workflow-owned durable resource (e.g. an `outputCursors` row
  keyed by `(contextId, executionId)`), advanced inside the same journaled step
  that consumes the element — so the seed for the *next* `next()` is the
  *previous* `next()`'s memoized result, reconstructed deterministically on
  replay without any `Ref`.
- **`next()`** = an `Activity` whose success schema is
  `{ sequence, output } | { terminal: true }`. Activity result memoization gives
  guarantee 2 for free. The Activity body does the indexed read of `position+1`
  and, when absent, awaits a `DurableDeferred` keyed by `(contextId, position+1)`
  that the output appender completes (guarantees 3+4).
- **Body** = `cursor.next()` in a loop until `Option.none`; deliver each output;
  no in-body `Stream.unfoldEffect(seed, …)` over a live `events.initial`.

`tf-7kq8`'s root is precisely that today's output read is the **only** loop op
*not* wrapped as an Activity (triage §"SOURCE-VERIFIED"): siblings
(`startSessionActivity`, `sendSessionActivity`, `runToolUseActivity`,
`transitionRuntimeContextEventActivity`) are memoized; the output read is a bare
live Effect over a volatile `Ref`. The primitive moves the read behind the same
journaled fence as its siblings.

## Trace invariant contract (gate lane 2 should emit)

So the O(outputs) gate is checkable on the real engine, emit:

- `firegrid.<area>.output.cursor.next` per `next()` with
  `…read.sequence`, `…read.memoized` (true on replay), `…read.indexed` (true =
  point read, false = scan — must never be false in steady state).
- `firegrid.<area>.output.append` per genuine output append (the denominator).
- `firegrid.<area>.output.turn_complete` once per terminal delivery.
- A run/summary span carrying `…log_reads`, `…distinct_outputs`,
  `…amplification`, `…turn_complete_deliveries`, `…o_outputs`.

Gate: `log_reads ≤ 2 × distinct_outputs`, `turn_complete_deliveries == 1`, and
no `…read.indexed=false` after warmup. The oracle emits this exact shape under
the `firegrid.phase0b.oracle.*` namespace; rename to lane 2's area prefix.

## Additive constraints for `tf-ly2g`

Do:

- Make the delivered cursor **durable workflow state**; reconstruct on replay,
  never re-derive by re-scanning.
- Wrap "observe next output" as a **journaled step** (Activity / durable
  deferred) so replay returns the recorded element with zero log reads.
- Read **one element at `position+1`** (indexed), and **wait keyed by
  `position+1`** — never re-subscribe from sequence 0.
- Carry the trace invariant contract above and assert the O(outputs) gate in
  the tf-ly2g acceptance trace (verbose stream + ToolUse/ToolResult/TurnComplete
  must hold the same ratio).

Do not:

- Put the output cursor in an in-memory `Ref` inside the workflow body.
- Read outputs with a live, non-memoized full-table scan on the replay path
  (the `events.initial`-shaped read).
- Treat "use `events.after`" as the fix without also making the cursor durable
  and the read journaled — the incremental stream re-seeded from a volatile
  cursor every replay is still O(resumes × history).
- Gate solely on a single short turn — short turns hide the class (few resumes).
  Drive the gate with a multi-output turn (the sweep shows ≥ 8 outputs already
  separates the strategies cleanly).

## Running the oracle

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run phase0b-output-replay-oracle
pnpm --filter @firegrid/tiny-firegrid simulate:show   # span tree
```

Source: `packages/tiny-firegrid/src/simulations/phase0b-output-replay-oracle/`.

## What this oracle is and is not

- **Is:** a clean-room, deterministic structural-invariant oracle. It faithfully
  reproduces the two source-verified failure conditions and proves the candidate
  primitive removes both, parametrically across turn length. It is the
  red→green target and the trace-contract reference for `tf-ly2g`.
- **Is not:** a real `@effect/workflow` durable-engine run. The *failure* is
  already source-verified on production (triage doc, pinned to lines); this
  oracle validates the *invariant and the primitive shape*. Real-engine
  validation on the #607 baseline is `tf-ly2g`'s acceptance, which should adopt
  the trace invariant contract above so the gate is enforced on real replay.
- **Clean-room boundary:** the oracle imports only `effect`; it does not import
  `@firegrid/runtime` output tables, the runtime-context workflow, or any #607
  Phase 0A file. No conflict with PR #607.
