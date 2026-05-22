# SDD — `DurableOutputCursor`: replay-safe output observation primitive (tf-qk6h, Phase 0C)

**Bead:** `tf-qk6h` (P0). Lane = primitive/design. **Not** lane 1's production
hotfix (`tf-7kq8`), **not** lane 4's migration map.
**Status:** design + prototype plan. No production patching in this lane.
**Inputs:** `docs/investigations/2026-05-21-phase0b-output-replay-oracle.md`
(tf-q4uz oracle + spec, PR #609/#610),
`docs/investigations/2026-05-21-live-acp-tool-call-triage.md` (the live P0),
`docs/sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md` (target model),
`features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`
(`PHASE_0B_OUTPUT_RESULT_RETURN`, `WORKFLOW_ADMISSION`).

---

## §0 The load-bearing decision (read this first)

> **The primitive is a workflow-owned durable table cursor advanced by output
> sequence, whose `next()` is an O(1) point `get` at `position + 1` and whose
> wait is an incremental tail re-derived from the durable cursor. It is NOT a
> per-sequence `DurableDeferred` mail slot, and NOT an `Activity`-memoized read.**

This is decisive — not a preference — because **three independent sources
agree**, and a fourth (the substrate) makes it feasible with zero new
primitives:

1. **Feature contract.** `PHASE_0B_OUTPUT_RESULT_RETURN.1` requires output be a
   "workflow-owned DurableTable append log … **not** a host-owned replay scan,
   request row, claim row, completion row, **deferred mailbox**, or adapter
   subsystem"; `.2` requires "a durable observer cursor by output sequence …
   resume after the last observed sequence"; `.3` forbids "re-read the full
   output history inside the replay boundary." `WORKFLOW_ADMISSION.6` states the
   target reference "**does not reference `appendRuntimeInputDeferred`,
   `WorkflowEngineTable.deferreds`**."
2. **SDD target** (`SDD_TARGET…REFERENCE.md:180`): "The cursor lives in table
   state, **not in memory, not in a deferred name**"; `:172` lists "deferred
   rows as numbered input mail slots" as a thing the table must **not** include.
3. **The oracle** (tf-q4uz): the failure class is "output observation cost
   scales with replays × history instead of distinct outputs"; the invariant is
   `log_reads ≤ 2 × distinct_outputs`, independent of resumes.
4. **The substrate makes it free** (the key new finding in this lane): the
   output event row's primary key **already encodes**
   `[contextId, activityAttempt, "events", sequence]`
   (`packages/protocol/src/launch/table.ts:80-93,123-137`), and
   `DurableTableService.get(key)` is an O(1) point lookup by primary key
   (`packages/effect-durable-operators/src/DurableTable.ts:129`). So
   "read the output at `sequence = position + 1`" needs **no new index, no new
   table, no deferred** — only `events.get(...)` instead of the current
   `events.query(coll => coll.toArray.filter(...))` full scan
   (`packages/runtime/src/agent-event-pipeline/authorities/per-context-output.ts:119-137`).

### Why NOT the production input-deferred pattern

The production **input** path is a per-sequence `DurableDeferred` mail slot:
`runtime-context/${contextId}/input/${sequence}`, completed by
`appendRuntimeInputDeferred` carrying the row in the deferred exit
(`packages/runtime/src/workflow-engine/runtime-input-deferred.ts:139-148`),
read by `engine.deferredResult` / `DurableDeferred.await`
(`runtime-context.ts:206-241`). It works for **inputs** (sparse: a few prompts
per turn) and it is the obvious symmetric thing to reach for. **Reject it for
outputs** for three reasons:

- It is the **explicitly forbidden** surface for the convergent target
  (`WORKFLOW_ADMISSION.6`, `PHASE_0B…1`, SDD `:172`).
- It is **O(outputs²) engine-internal point-lookups**: `@effect/workflow`
  replays the body top-to-bottom, re-running every `next()` step, each a point
  lookup into `deferreds` — `Σ(1..D)` lookups across a D-output turn. Sparse
  inputs hide this; **dense outputs (text chunks + tool calls) do not.**
- It **duplicates every output payload** into the engine `deferreds` table.

The table-cursor model is **strictly better than O(outputs²)**: because the
durable cursor column lets the replaying body **skip directly to `position`**
(read one column, continue), each resume does O(1) work and a turn is **O(D)
total point reads** — true `O(outputs)`. See §4.

### Why NOT `Activity`-memoized read

The oracle spec floats "wrap `next()` as an Activity" (guarantee 2). On this
engine an Activity is **not** zero-cost on replay: `activityExecute` does a
`table.activities.get(key)` point lookup **every** replay before returning the
memoized result (`engine-runtime.ts:344-405`) — same O(outputs²) replay
footprint as deferreds, plus the SDD says output observation "is **not** an
activity" (`SDD_TARGET…:374`). Activities remain correct for **side-effecting**
steps (tool execution, session send); they are the wrong fence for **reading
the next row**.

---

## §1 The failure being made impossible (source-pinned)

`tf-7kq8` is the conjunction of two conditions in the **output** arm of the
merged event loop (`runtime-context.ts`):

1. **Volatile cursor.** `lastProcessedOutputSequence` lives in an in-memory
   `Ref` seeded `-1` (`runtime-context.ts:347-352,820`). It does not survive
   replay → each resume re-derives position from scratch.
2. **Full scan on the replay path.** "Find the next output" is
   `completedRuntimeOutput` → `RuntimeAgentOutputAfterEvents.initial`
   (`runtime-context.ts:274-298,762`), which is
   `table.events.query(coll => coll.toArray …)` — a **full materialization +
   linear filter** (`per-context-output.ts:119-137`). It re-executes every
   replay.

Conjunction ⇒ replay `r` (cursor reset to `-1`) re-scans `r` rows ⇒
`Σ(1..D) = D(D+1)/2 = O(resumes × history)`. Live trace: **1987
`agent_output.initial` spans for ~107 real outputs** (triage doc). The terminal
output never returns inside the edge's turn timeout.

The **input** arm does **not** have this bug — but only because inputs are
sparse and it uses a durable wait (the deferred mail slot). The output arm is
the **only loop read that is neither durable-cursored nor point-indexed.**

---

## §2 Questions answered

### Q1 — What mechanism should `next()` use?

**Durable table cursor (position) + O(1) point `get` (read) + cursor-derived
incremental tail (wait).** Concretely, three engine-native pieces, no new
primitive:

| Concern | Mechanism | Source it relies on |
| --- | --- | --- |
| **Position** | a durable column `lastDeliveredSequence` in a workflow-owned per-`(contextId, activityAttempt)` row, advanced by `upsert` in the same step that consumes the output | `DurableTable.upsert/get` (`DurableTable.ts:127,129`); SDD `:289-300` |
| **Read** | `events.get({ contextId, activityAttempt, target: "events", sequence: position + 1 })` — O(1) point lookup | composite PK `table.ts:80-93`; `get` `DurableTable.ts:129` |
| **Wait** | `events.rows()` (incremental projection tail) filtered to `sequence > position`, entered **only** when the point read misses | `DurableTableService.rows()` `DurableTable.ts:116`; engine optional resume-on-write `engine-runtime.ts` |

Rejected: (b) per-sequence `DurableDeferred` mail slot (forbidden + O(outputs²) +
payload duplication); (a) `Activity`-memoized read (O(outputs²) replay lookups +
SDD "not an activity"); (d) raw `events.rows()`/`.after` from sequence 0 (the
re-subscription storm itself — this is what the live trace shows). `DurableQueue`
(`repos/effect/packages/workflow/src/DurableQueue.ts`) is the wrong direction
(workflow→worker offer/await, `@effect/experimental`, long-running consumer
loop — does not map to a replay-safe per-step pull).

### Q2 — Where should the primitive live (no leak to channels / bodies)?

A new runtime module **`packages/runtime/src/workflow-engine/durable-output-cursor.ts`**
(sibling to `runtime-input-deferred.ts`), owning:

- the cursor-row schema + key helper (workflow-private control state);
- `runtimeOutputCursor(context, activityAttempt): DurableOutputCursor` — the
  workflow-body-facing seam exposing **only** `next()`;
- the point-read + tail-wait implementation against `RuntimeOutputTable`.

Direction (top imports bottom; never the reverse):

```
workflow body (runtime-context.ts)
  └─uses→ DurableOutputCursor.next()            ← only this verb crosses in
            └─reads→ RuntimeOutputTable.events.get / .rows()   (runtime-private)
                       └─schema→ @firegrid/protocol/launch (RuntimeEventRow, PK)
appender (per-context-output.ts appendAgentEvent) → events.upsert (unchanged)
channels / host-sdk / client → NOTHING here
```

The body imports the **cursor seam**, never the table; channels keep owning the
table write (`appendAgentEvent`) and are untouched; the protocol owns only the
row + PK schema (public contract), not the cursor. This satisfies
`WORKFLOW_ADMISSION.3` (no output-table/handle leak to callers) and
`PHASE_0B…1` (workflow-owned log, not a host scan).

### Q3 — Replay-safety invariants & O(outputs) trace gates

Invariants (each kills a failure condition):

- **INV-1 (durable position).** Position is the durable cursor column,
  reconstructed by one `get` on replay — never an in-memory `Ref` reset to `-1`.
  *Kills condition 1.*
- **INV-2 (no replay re-walk).** On resume the body reads the cursor and
  resumes at `position + 1`; outputs `0..position` are **never re-read**.
  *Kills the `resumes × history` term.*
- **INV-3 (point, not scan).** A genuine read is `events.get(position + 1)`
  (O(1) by PK), never `query`/`toArray`/`reduce` over all rows. *Kills
  condition 2.*
- **INV-4 (tail keyed by position).** The wait is `events.rows()` filtered to
  `> position`, entered only on a point-read miss — never a from-sequence-0
  re-subscription. *Kills the live storm.*
- **INV-5 (exactly-once + terminal).** Cursor advance is idempotent (`upsert`
  of a monotonic column); each sequence delivered once; `Terminated`/
  `TurnComplete` delivered once.

Trace contract (emit on the real engine, area prefix
`firegrid.runtime_context.workflow.output`):

- `…cursor.next` per `next()` with `read.sequence`, `read.memoized`
  (true = served from cursor without a genuine read), `read.indexed`
  (**must never be false** — false means a scan leaked back in).
- `…output.append` per genuine append (the denominator).
- `…turn_complete` once per terminal delivery.
- a run/summary span carrying `log_reads`, `distinct_outputs`, `amplification`,
  `turn_complete_deliveries`, `o_outputs`.

**Gate:** `log_reads ≤ 2 × distinct_outputs`, `turn_complete_deliveries == 1`,
no `read.indexed = false` after warmup, and **zero
`firegrid.runtime_output.per_context.agent_output.initial` spans on the workflow
replay path** (its presence = regression). Target amplification ≈ 1.0 (one
genuine point read per distinct output). Drive the gate with a **≥ 8-output
turn** — short turns hide the class (`PHASE_0B…5`; oracle "Do not" list).

### Q4 — Minimal API shape that makes live scans unexpressible

```ts
export interface DurableOutputCursor {
  /**
   * Option.none  => terminal/closed (TurnComplete consumed); body completes.
   * Suspends durably (via the events tail) when nothing past the cursor exists.
   * Advances the durable cursor as part of producing the value.
   */
  readonly next: Effect.Effect<
    Option.Option<{ readonly sequence: number; readonly observation: RuntimeAgentOutputObservation }>,
    RuntimeContextError,
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | RuntimeOutputCursorTable
  >
}

export const runtimeOutputCursor: (
  context: RuntimeContext,
  activityAttempt: number,
) => DurableOutputCursor
```

The prevention is **in the requirement set**, not in discipline: `next`'s `R`
channel is `WorkflowEngine | WorkflowInstance | RuntimeOutputCursorTable`. It
**does not include `RuntimeAgentOutputAfterEvents`** (the `initial`/`after`
scan+stream authority). Removing that tag from
`RuntimeContextWorkflowExecutionEnv` (`runtime-context.ts:125-133`) makes the
body **unable to type-check a live full-table read** — `events.initial` is no
longer reachable from the body. The cursor wraps the table and exposes only the
point-read + bounded-tail; it never hands `query`/`toArray` to the body. (The
`after`/`forContext` stream authorities stay for **wait-router consumers**
elsewhere; this only removes them from the *workflow body's* env.)

### Q5 — First production migration slice (after lane 1's hotfix)

Lane 1 (`tf-7kq8`) ships the in-place hotfix (resume-after-last-sequence /
once-per-turn) so production is already safe. The **first structural slice** is
the smallest additive change that makes the storm unexpressible:

1. **Add** `durable-output-cursor.ts`: the `RuntimeOutputCursorTable` cursor row
   (`{ contextId, activityAttempt }` PK, `lastDeliveredSequence`), the key
   helper, and `runtimeOutputCursor` (point `get` + tail). Additive; no behavior
   change yet.
2. **Swap the output arm only.** Replace `completedRuntimeOutput`
   (`runtime-context.ts:762`, the `events.initial` scan) and the output read in
   `completedRuntimeContextEvent` (`:749-768`) with `cursor.next`. Leave the
   **input** arm (deferred) and tool/session Activities untouched — this slice
   is output-read-shaped only.
3. **Drop the volatile output cursor.** `lastProcessedOutputSequence` moves from
   the in-memory `stateRef` (`:347-352,820`) to the durable cursor row.
4. **Remove `RuntimeAgentOutputAfterEvents` from the body env**
   (`:125-133`) so the scan is unexpressible (Q4). Keep it for wait-router.
5. **Gate** with the §3 trace contract on a live **≥ 8-output ACP turn** on the
   #607 Phase 0A baseline (the lane that owns real-engine acceptance is
   `tf-ly2g`; this slice adopts its trace prefix).

Slice boundary: **does not touch** inputs, tool execution, session adapters,
channels, host-sdk, or client. One new runtime file + one edited workflow arm.

---

## §3 Validation plan

1. **Clean-room re-gate (no engine).** Re-run the tf-q4uz oracle
   (`pnpm --filter @firegrid/tiny-firegrid simulate:run phase0b-output-replay-oracle`)
   as the red→green target; confirm the table-cursor candidate holds
   amplification ≈ 1.0 across the D∈{4,8,16,32,64} sweep where the scan specimen
   blows `(D+1)/2`.
2. **Substrate proof (point vs scan).** A focused tiny-firegrid sim or
   `effect-durable-operators` test asserting `events.get(compositeKey)` returns
   the row at `sequence` in O(1) (no `toArray`), proving the read needs no new
   index. (This is the load-bearing substrate claim; pin it with a test.)
3. **Replay re-walk proof.** Drive ≥ 8 outputs with forced resumes (engine
   resume-on-write) and assert the §3 trace gate: `log_reads ≤ 2×distinct`,
   no `agent_output.initial` span, `turn_complete == 1`, and that outputs
   `0..position` are not re-read after a resume.
4. **Real-engine acceptance** is `tf-ly2g`'s on the #607 baseline (verbose
   stream + ToolUse/ToolResult/TurnComplete must hold the same ratio); this lane
   hands it the contract above. `check:specs` / `check:docs` run if specs/docs
   touched.

---

## §4 Cost model (why this is true `O(outputs)`)

| Model | per-resume work | total over D-output turn | output-log reads |
| --- | --- | --- | --- |
| **tf-7kq8 (volatile Ref + scan)** | re-scan from 0 = O(history) | `O(D²)` element reads | `O(D²)` |
| Deferred mail slot (input pattern) | re-run all `next()` steps = O(position) point lookups | `O(D²)` point lookups (cheap, but quadratic) + payload dup | 0 (rides in deferred) |
| Activity-memoized read | re-run all `next()` Activities = O(position) `activities.get` | `O(D²)` point lookups | 0–D |
| **Table cursor + point `get` (this SDD)** | read cursor (1 get) + read `position+1` (1 get) = **O(1)** | **`O(D)` point reads** | **`O(D)`** (1/output, amplification ≈ 1.0) |

The table-cursor model is the only one that is O(1)-per-resume: the durable
column lets the replaying body **skip** to its position instead of re-deriving
it by replaying every prior step. That is the SDD's "core proof: replay
reconstructs progress from table state" (`SDD_TARGET…:300`).

---

## §5 Forbidden surfaces (regression guards)

- **No `DurableDeferred` per output sequence** / no `appendRuntimeInputDeferred`
  analogue / no `WorkflowEngineTable.deferreds` for outputs
  (`WORKFLOW_ADMISSION.6`, `PHASE_0B…1`).
- **No `events.query` / `coll.toArray` / `reduce`-over-rows on the read path.**
  The read is `events.get(position+1)`; the wait is `events.rows()` filtered to
  `> position`. A `…agent_output.initial` span on the workflow path is a
  regression.
- **No in-memory `Ref` cursor** for the delivered output position.
- **No re-subscription from sequence 0** (the live storm); the tail is always
  derived from the durable cursor.
- **No output-table / engine / `query` handle exposed to channels, host-sdk, or
  client** (`WORKFLOW_ADMISSION.3`). The body sees only `cursor.next()`.
- **No second source of truth for position.** Position is the durable cursor
  column, not also a journal-implicit count.
- **Stop-and-re-evaluate** (SDD `:200-211`, `WORKFLOW_ADMISSION.7`) if the slice
  needs a new public abstraction, a request/claim/completion bridge, a registry,
  an adapter subsystem, or a secondary-index primitive — the substrate already
  has the O(1) point read, so none of these should be necessary.

---

## §6 Source evidence index

- `@effect/workflow` Activity replay cost (point lookup per replay):
  `repos/effect/packages/workflow/src/Activity.ts:239-259` →
  `engine-runtime.ts:344-405`.
- `DurableDeferred` mail-slot read (point lookup, payload in exit):
  `repos/effect/packages/workflow/src/DurableDeferred.ts`; production input use
  `runtime-input-deferred.ts:139-148`, `runtime-context.ts:206-241`.
- `DurableQueue` (considered, rejected — wrong direction/experimental):
  `repos/effect/packages/workflow/src/DurableQueue.ts:42-218`.
- Engine resume-on-deferred / body re-execution model:
  `engine-runtime.ts:175-245,431-463`.
- `DurableTableService`: `get` (O(1) PK), `query` (scan), `rows()` (tail),
  `upsert`: `packages/effect-durable-operators/src/DurableTable.ts:116-130`.
- Output event composite PK encodes the sequence:
  `packages/protocol/src/launch/table.ts:53-93,123-137,189-219`.
- Production output scan (the bug surface):
  `packages/runtime/src/agent-event-pipeline/authorities/per-context-output.ts:111-199`.
- Volatile cursor + scan call sites:
  `packages/runtime/src/workflow-engine/workflows/runtime-context.ts:274-298,347-352,749-845`.
