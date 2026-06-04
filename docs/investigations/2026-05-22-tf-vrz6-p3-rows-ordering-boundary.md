# tf-vrz6 STOP — P3 consume-time ordering needs the append offset (rows() is PK-sorted, not arrival-ordered)

**Bead:** `tf-vrz6` (P1, Phase 0C Stage A). **Outcome:** **STOPPED per the dispatch/bead STOP rule** before implementation. The smallest P3 Stage A slice cannot be built on the current substrate: its load-bearing ordering premise is false. No production code was changed; one throwaway probe was run and removed.

## What P3-A assumes, and why it fails

`SDD_RUNTIME_CONTEXT_WORKFLOW_INPUT_TABLE_CUTOVER.md` Amendment 1 (P3) assigns input **delivery order** at *consume* time by walking the workflow-owned `inputs` collection in **arrival order**:

> **P3-A (no substrate change, preferred):** the workflow tails `inputs.rows()` (arrival-ordered projection) … (Amendment 1 §A2)

and keys `inputs` by **`inputId`** (a derived idempotency key), explicitly dropping the write-time `sequence`/`nextInputSequenceToAssign`.

**Both cannot hold at once.** `DurableTable.rows()` surfaces rows in **primary-key-sorted order, not arrival/insertion order.** Empirically (focused probe on the production `DurableStreamsWorkflowEngine` substrate, since removed):

```
inserted (arrival order):  m-charlie(0), a-alpha(1), z-zulu(2), b-bravo(3)
inputs.rows() returned:    a-alpha(1), b-bravo(3), m-charlie(0), z-zulu(2)   # sorted by id
```

`rows()` is built on the TanStack materialized collection (`DurableTable.ts:722` → `subscribeChanges`/`toArray`), which orders by primary key. Because P3 keys `inputs` by `inputId` — a derived idempotency identity, **not monotonic by arrival** — `inputs.rows()` yields PK(`inputId`)-sorted order, which has **no relationship to arrival order**.

So a P3-A cursor that "tails `inputs.rows()` and assigns the next dense ordinal" would assign ordinals in **`inputId` lexical order**, not arrival/delivery order. That silently changes delivery semantics (the SDD's model is "arrival order … preserves today's single-dispatcher arrival-order semantics", §A2) — a latent correctness bug, not a tuning issue. **P3-A is infeasible as specified.**

## Why the forbidden escapes don't apply

- **Re-introduce a write-time arrival index** (`nextInputSequenceToAssign` / a monotonic `inputId`): explicitly forbidden by the dispatch and Amendment §A4 (it re-grows the contention/serializer P3 removes).
- **Order by `acceptedAt` timestamp**: not a reliable total order (skew/ties); not sanctioned by the SDD.
- **Use PK order as delivery order**: a behavior change vs. arrival-order semantics; the SDD requires arrival order and says cross-author ordering "must be tested explicitly."

## The only compliant path is P3-B — and it is a substrate change

P3-B (Amendment §A2) surfaces the durable-stream **append offset** as the per-context arrival sequence. The offset exists internally — `appendInsertWithPrimaryKeyFence` → `DurableStream.appendWithProducer` returns an `Appended` result (`DurableTable.ts:772-782`) — but `insertOrGet` **discards it**, returning `{ _tag: "Inserted" }` / `{ _tag: "Found", row }` with **no offset** (`DurableTable.ts:787-789` and the `InsertOrGetResult` shape).

Surfacing it requires an **additive API change in `effect-durable-operators`** (a new `InsertOrGetResult` field carrying the append offset/position, plumbed from `appendWithProducer`), then a runtime cursor that point-reads arrival by that offset. That is a **substrate change in a different package**, which is exactly the dispatch STOP ("STOP if this becomes broad/multi-stage beyond a focused slice") and the bead/SDD §A4 STOP ("a second cursor source-of-truth" / broad rewrite). It is the P3-B prerequisite, not the tf-vrz6 runtime Stage-A slice.

## Why there is no smaller landable sub-slice

The replay path (point-`get` `assignedInputs[${contextId}/${cursor}]` → `inputs.get(inputId)`) works fine and needs no substrate change. But it only re-reads **already-assigned** ordinals. The **new-arrival discovery** — the step that assigns the ordinal in the first place — is precisely the part that needs arrival order, and is the broken part. A cursor that cannot discover new arrivals in arrival order cannot consume inputs correctly end-to-end, so there is no useful table+cursor sub-slice that lands without the ordering source. (The earlier `tiny-input-append-wakeup` GREEN finding used the **superseded** write-time `sequence` + `inputIds` shape, so it did not exercise — and does not validate — P3 consume-time arrival ordering.)

## Recommendation

1. **`tf-qtfb` — P3-B substrate prerequisite** (`effect-durable-operators`): surface the `insertOrGet`/`appendWithProducer` append offset on `InsertOrGetResult` as a per-stream/per-context arrival position, with a test proving distinct concurrent inserts get monotonic offsets. **Blocks tf-vrz6 Stage A.**
2. **tf-vrz6 stays OPEN, re-blocked** on that substrate bead. Once the offset is surfaced, the P3 cursor is buildable as a focused runtime slice (point-read arrival by offset; `Workflow.suspend` on no-arrival; `engine.resume` on write — both proven by `tf-e5rf`/#651).
3. Do **not** ship P3-A (PK-order ordinals = wrong delivery order) and do **not** reintroduce write-time allocation.

## Sources

- Probe: `DurableTable.rows()` PK-sort vs insertion order (production `DurableStreamsWorkflowEngine` substrate; throwaway test, removed).
- `packages/effect-durable-operators/src/DurableTable.ts` (`:722` rows()/`subscribeChanges`; `:504` `appendInsertWithPrimaryKeyFence`; `:772-789` `Appended`→`Inserted`, offset discarded).
- `docs/sdds/SDD_RUNTIME_CONTEXT_WORKFLOW_INPUT_TABLE_CUTOVER.md` Amendment 1 §A2 (P3-A/P3-B), §A4 (forbidden surfaces / stop conditions).
- `tf-e5rf`/#651 (F3 wakeup: `engine.resume` + `Workflow.suspend` proven — the *wakeup* half is ready; this STOP is the *ordering* half).
- `packages/firelab/src/simulations/tiny-input-append-wakeup/FINDING.md` (superseded write-time shape; does not validate P3 ordering).
