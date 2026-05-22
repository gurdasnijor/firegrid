# Q1 — What does the RuntimeContextWorkflow actually require of its input mechanism?

**Author:** CC1 (first-principles research brief). **Date:** 2026-05-22.
**Status:** research, not a decision. Primary sources cited at `file:line`.
**Question:** Derive the input-side requirements of the per-context workflow from
the consumer code alone, then ask whether the current shape — and the proposed
table cutover — meet them. Treat both SDDs as hypotheses.

## 1. Requirements derived from the consumer

The only authoritative source of requirements is what the workflow body *does*
with input. The merged event loop reads input through a single monotonically
advancing cursor:

- `awaitRuntimeInput(context, state.lastProcessedInputSequence + 1)`
  (`packages/runtime/src/workflow-engine/workflows/runtime-context.ts:823`), which
  is `DurableDeferred.await(runtime-context/<id>/input/<N>)`
  (`runtime-context.ts:207-220`, `:199-205`).
- `completedRuntimeInput(context, state.lastProcessedInputSequence + 1)` for the
  already-available case (`runtime-context.ts:803-805`).

From this, eight requirements fall out:

- **R1 — Total order per context.** The body consumes one input at a time via one
  cursor; it needs a single total order over *all* inputs for a context.
- **R2 — Dense, gap-free ordinals.** It awaits *exactly* `last + 1`
  (`runtime-context.ts:823`). A gap in the address space deadlocks the body
  forever. The ordinal space must be dense `0,1,2,…`.
- **R3 — Point-addressable read, no replay-path scan.** It addresses input `N`
  directly. The SDD makes this an explicit prerequisite and a stop condition:
  "Do not place `inputs.query(...)` on the workflow replay path" (SDD
  `:166-167`, `:485`).
- **R4 — Faithful arrival order.** The ordinal must reflect the order inputs
  actually arrived ("preserves today's single-dispatcher arrival-order
  semantics", SDD Amendment §A2), across all authors.
- **R5 — Idempotent, exactly-once delivery.** A duplicate producer must yield
  exactly one ordinal and one delivery.
- **R6 — Durable replay reconstruction.** The cursor must be rebuildable from
  durable state across restart/replay, not an in-memory `Ref` alone.
- **R7 — Wakeup on new arrival (F3).** A suspended body must resume when a new
  input is written.
- **R8 — Multi-author write safety.** `client | workflow | tool | system`
  (`RuntimeIngressAuthor`) all append; concurrent distinct inputs must each get a
  distinct ordinal with no loss or duplication.

## 2. Evidence: how the current shape satisfies each requirement

**Producers write idempotent intent rows.** All four call sites lower input into
`RuntimeControlPlaneTable.inputIntents.insertOrGet(stamped)`, keyed by
idempotency id:
- prompt: `appendInputIntent` → `control.inputIntents.insertOrGet(stamped)`
  (`packages/protocol/src/launch/host-control-request.ts:72`);
- permission: `control.inputIntents.insertOrGet(stamped)`
  (`packages/runtime/src/channels/session-permission.ts:54`);
- host command: `control.inputIntents.insertOrGet(intent)`
  (`packages/host-sdk/src/host/commands.ts:121`);
- scheduled self-prompt (author = `workflow`):
  `control.inputIntents.insertOrGet(intent)`
  (`packages/runtime/src/agent-event-pipeline/authorities/scheduled-prompt-append.ts:41`).

These satisfy **R5/R8 at the write boundary** (insert-if-absent on the idempotency
key), but they assign **no order**.

**A single host-scoped dispatcher is the arrival-order authority.**
`RuntimeInputIntentDispatcherLive` streams `inputIntents.rows()` on one forked
fiber and calls `dispatchIntent` per row
(`packages/runtime/src/kernel/runtime-context-workflow-runtime.ts:410-429`).
Startup `reconcile` reads *all* intents for a context and **sorts them by
`runtimeInputIntentOrder`** = `createdAt` then `intentId`
(`runtime-context-workflow-runtime.ts:306-334`, sort fn `:92-98`).

**Dense sequence is allocated at dispatch time by a scan.**
`appendRuntimeInputDeferred` reads existing input rows for the context out of
`WorkflowEngineTable.deferreds` via `query`/`toArray`/`filter`
(`packages/runtime/src/workflow-engine/runtime-input-deferred.ts:75-92`),
computes `nextSequence = reduce(max, row.sequence + 1, 0)` (`:126-130`), dedups by
`inputId` (`:123-124`), and writes the numbered durable deferred via
`engine.deferredDone(runtime-context/<id>/input/<N>)` (`:138-148`). This is
single-writer only because the dispatcher fiber is the sole caller.

**The workflow reads point-addressed by dense ordinal.**
`DurableDeferred.await(.../input/N)` (`runtime-context.ts:211`) and
`engine.deferredResult(.../input/N)` (`runtime-context.ts:229`) are O(1) point
reads; wakeup is `engine.deferredDone` (R7, the temporary `BOUNDARIES.7-1`
bridge, SDD `:80-81`).

**The substrate smell (the reason this brief exists).**
`DurableTable.rows()` is `readableCollection.subscribeChanges(…,
{ includeInitialState: true })` over the TanStack materialized collection
(`packages/effect-durable-operators/src/DurableTable.ts:722-735`). Its initial
state is **primary-key-sorted, not arrival-ordered** — empirically confirmed by
the tf-vrz6 probe (`docs/investigations/2026-05-22-tf-vrz6-p3-rows-ordering-boundary.md:13-22`).
The one true arrival total-order in the stack — the durable-stream append offset
that `appendInsertWithPrimaryKeyFence` → `appendWithProducer` computes
(`DurableTable.ts:772-781`) — is **discarded**: `insertOrGet` returns
`InsertOrGetResult = { Inserted } | { Found; row }` with no offset field
(`DurableTable.ts:99-101`, `:787-789`).

## 3. Conclusion — does the current shape meet the requirements?

| Req | Met? | Where it rests |
|---|---|---|
| R1 total order | yes | dispatcher serializes; dense deferred ordinals |
| R2 dense/gap-free | yes | `max(sequence)+1` allocation |
| R3 point read | **read yes / write no** | body reads by point `await`; but **allocation scans deferreds** (`runtime-input-deferred.ts:75-130`) |
| R4 faithful arrival | **weak** | live `rows()` change order + **`createdAt` timestamp sort** on reconcile (`:92-98`) — not a substrate total order |
| R5 idempotent | yes | `insertOrGet` + dispatcher dedup |
| R6 durable replay | **partial** | next sequence re-derived by *scan*, not a durable point cursor |
| R7 wakeup | yes | `deferredDone` bridge (F3-pending) |
| R8 multi-author | yes *via the serializer* | single dispatcher fiber — the thing the cutover deletes |

The current shape **functions**, but the two requirements it meets least cleanly
(R4 faithful arrival order, R8 contention safety) are met *only* by the
single host-scoped serializer, and R3/R6 are violated on the *allocation* path by
a deferred scan. The architect's hypothesis holds at the requirements level:
**R2+R3+R4 together describe an arrival-ordered, dense, point-addressable
append-log read — and the substrate exposes only keyed-state reads** (PK-sorted
`rows()`, point `get`). There is no log-read primitive.

This is precisely why the proposed cutover stalled. Amendment 1 (P3) moves
ordinal assignment to consume time and keys `inputs` by `inputId`; P3-A then
tries to recover arrival order from `inputs.rows()` — which is PK(`inputId`)
order, unrelated to arrival (tf-vrz6 STOP). The only compliant path, P3-B,
surfaces the append offset that already exists internally but is dropped at
`DurableTable.ts:99-101` — i.e. it converts a keyed-state read back into a
log-offset read. The smell is structural, not a bug: a keyed-state primitive is
carrying an ordered-log requirement, and every escape route either re-grows the
serializer (P2), needs a CAS the substrate can't give (P1/tf-i05u STOP), or
re-surfaces a stream offset (P3-B substrate change).

## 4. Open questions

- **Is R4 even correctly met today?** The reconcile path orders by `createdAt`
  (wall clock). The tf-vrz6 doc rejects timestamp ordering as "not a reliable
  total order (skew/ties)" (`:27`). Does the live-dispatch path's `rows()`
  change-stream order give a stronger guarantee than the reconcile path's
  timestamp sort — and do the two paths agree across a restart boundary? If not,
  the *current* shape already has a latent cross-author ordering bug, independent
  of the cutover.
- **Is per-context arrival order a real product requirement, or an artifact?**
  R4 is asserted as "preserve today's semantics." Do any consumers actually
  depend on cross-author arrival order (e.g. permission-response vs prompt
  interleaving), or would a per-author FIFO with arbitrary cross-author merge
  suffice? The SDD itself says cross-author preference "must be tested
  explicitly" (`:338-339`, Amendment §A2) — meaning it is currently *untested*.
- **Is the durable-stream append offset a stable per-context total order?**
  `appendWithProducer` is called with `producerEpoch: 0, producerSeq: 0`
  (`DurableTable.ts:521-522`). Does the offset returned by `Appended` give a
  monotonic per-stream order under concurrent producers, or only per-producer?
  P3-B's viability depends entirely on this, and it was not verified here.
- **Should input and output share one cursor primitive?** Amendment §A2/§A3 argue
  the input arm and `DurableOutputCursor` (tf-qk6h) are the same shape and should
  converge. The output arm's `sequence` is single-producer caller-supplied
  (per the SDD source note); input is multi-author. Is the asymmetry small
  enough that one primitive serves both, or does multi-author input need its own
  arrival-order source the output arm never needs?
- **Does "keyed-state vs log" generalize beyond input?** If `rows()` PK-sort vs
  arrival-order is a substrate-wide gap, every place that reads a DurableTable
  collection expecting insertion order (the dispatcher's own `inputIntents.rows()`
  consumption, output replay) inherits the same latent bug. Worth a sweep.
