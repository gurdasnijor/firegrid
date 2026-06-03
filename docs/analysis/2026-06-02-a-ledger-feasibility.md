# A-ledger feasibility read

Date: 2026-06-02

Task: tf-di8a

Scope: read-only feasibility/design note for the option-A named costs in the
runtime org/body-shape SDD. No runtime code was changed.

Verdict summary:

- Atomic `startOrAttach`: **BUILDABLE-WITH-SUBTLETY**. The owned seam is small,
  but the reservation must cover the asynchronous spawn; a plain `Ref.modify`
  that only reserves synchronously is not sufficient unless paired with a latch
  or per-key mutex held across the spawn.
- Append-ordered / single-writer consume cursor: **BUILDABLE-WITH-SUBTLETY**.
  The durable-stream protocol exposes the right append-order and producer-fence
  primitives, but the current table `upsert` path is not producer-fenced and
  `insertOrGet` does not return the original winner offset on duplicate. The
  design should store/return the append position explicitly or use a lower-level
  input stream cursor.
- Non-clock DurableDeferred crash recovery: **BUILDABLE-WITH-SUBTLETY**. The
  deferred table and resume hook are present, but recovery must be
  registration-aware; an engine-start sweep before workflows register can no-op.

## 1. Atomic `startOrAttach`

Status: **BUILDABLE-WITH-SUBTLETY**.

Source-verified facts:

- `ProductionCodecAdapterLive` allocates one in-memory registry as
  `Ref.make<Map<string, RegistryEntry>>(new Map())` in
  `packages/runtime/src/unified/codec-adapter.ts:406`.
- `startOrAttach` currently reads the registry at
  `packages/runtime/src/unified/codec-adapter.ts:413-415`, returns an existing
  entry at `:416`, then resolves the context and builds the session at
  `:418-435`.
- The registry slot is not written until after the asynchronous
  `buildSessionForContext` completes, at
  `packages/runtime/src/unified/codec-adapter.ts:436-440`.
- Sends depend on the registry entry existing:
  `packages/runtime/src/unified/codec-adapter.ts:458-460`.
- Deregistration closes the entry scope and removes the registry key at
  `packages/runtime/src/unified/codec-adapter.ts:518-529`.

Feasibility read:

The race is in an owned Firegrid seam and is cheap to close, but it is not
solved by wrapping the existing body in a bare `Ref.modify`. `Ref.modify` can
reserve a slot atomically, but `buildSessionForContext` is an asynchronous
Effect that can fail, and the protection must cover the whole spawn/build
window. Otherwise, competing callers can still observe "no usable entry" while
the first caller is between reservation and success.

Minimal diff sketch:

1. Add an `inFlight` registry beside `registry`, keyed by `contextId`, whose
   value is a `Deferred<RegistryEntry, AdapterError>` or equivalent latch.
2. On `startOrAttach(contextId)`, first check the completed `registry`.
3. If absent, use `Ref.modify(inFlight, ...)` to atomically decide whether this
   caller is the starter or a waiter:
   - starter inserts a fresh latch and performs `resolveContext` +
     `buildSessionForContext` outside the `Ref.modify` callback;
   - waiter awaits the existing latch and returns the completed entry.
4. Starter success path writes `registry.set(contextId, entry)` and completes
   the latch with the entry.
5. Starter failure path completes the latch with the `AdapterError` and removes
   the `inFlight` key so a later call can retry.
6. Ensure cleanup removes `inFlight` even if the starter is interrupted.

Open subtlety:

`deregister` currently assumes a completed registry entry. A robust patch should
define what happens if terminal cleanup races an in-flight start. The least
surprising behavior is either to await/fail the in-flight latch before close, or
to mark the in-flight start cancelled and remove both maps in the same cleanup
path.

## 2. Append-ordered / single-writer consume cursor

Status: **BUILDABLE-WITH-SUBTLETY**.

Source-verified facts:

- Producer appends carry `producerId`, `producerEpoch`, and `producerSeq` at
  `packages/effect-durable-streams/src/protocol/Producer.ts:78-85`.
- The producer only advances local sequence after an acknowledged append or
  duplicate at `packages/effect-durable-streams/src/protocol/Producer.ts:87-93`,
  treats stale epochs as fenced at `:95-111`, and treats sequence gaps as errors
  at `:113-125`.
- The producer implementation explicitly serializes sends to preserve
  producer-sequence order at
  `packages/effect-durable-streams/src/protocol/Producer.ts:239-241`.
- Bound appends expose the server offset:
  `packages/effect-durable-streams/src/DurableStream.ts:341-348`.
- Classified producer append results include `Appended` and `Duplicate`
  variants with an offset at
  `packages/effect-durable-streams/src/DurableStream.ts:275-277`, and the
  writer returns those offsets at
  `packages/effect-durable-streams/src/Writer.ts:89-94`.
- DurableTable documents `insertOrGet` as not being a lock/claim/mutex/lease
  primitive at
  `packages/effect-durable-operators/src/DurableTable.ts:119-122`.
- DurableTable also documents the append offset as a monotonic per-stream
  arrival position for successful inserts at
  `packages/effect-durable-operators/src/DurableTable.ts:124-128`.
- `insertOrGet` derives a producer id from table, collection, and encoded
  primary key at
  `packages/effect-durable-operators/src/DurableTable.ts:515-526`, then appends
  with `producerEpoch: 0` and `producerSeq: 0` at `:527-534`.
- The current generic `insert`/`upsert`/`delete` actions use plain
  `stream.append(...)`, not `appendWithProducer`, at
  `packages/effect-durable-operators/src/DurableTable.ts:376`,
  `:406`, and `:431`.
- On successful `insertOrGet`, DurableTable returns the server-assigned offset
  at `packages/effect-durable-operators/src/DurableTable.ts:800-812`; on
  duplicate it returns the found row without the original arrival offset, and
  the comment says callers needing original order must capture it at first
  write at `:815-822`.

Feasibility read:

The infrastructure can support an append-ordered cursor, but the design should
not pretend the existing blind row update is already race-free. The safe model
is to make the cursor a position in an append-ordered log, or to ensure a single
writer per `contextId` advances the cursor. That uses the stream offset or
producer sequence as the order source instead of allocating `nextSeq` from a
read-modify-write count.

Minimal diff sketches:

Option 2A, input-log cursor:

1. Write per-event inputs to a durable stream/table action that returns the
   append `offset`.
2. Persist the consume cursor as `{ contextId, lastConsumedOffset }`.
3. The per-context session/body is the only writer that advances
   `lastConsumedOffset`, after processing all input events up to that offset.
4. Replays scan from `lastConsumedOffset` forward and filter by `contextId` if
   the stream is global.

Option 2B, table-backed idempotent input rows:

1. Add a row field for the append position, or add a DurableTable API that can
   return the original winner offset on duplicate.
2. Use the primary-key producer fence for idempotent per-input rows.
3. Order consumption by captured append position, not by a dense counter
   computed from existing rows.
4. Keep cursor advancement single-writer-per-`contextId`; do not use normal
   `upsert` as a compare-and-swap substitute.

Open subtlety:

`insertOrGet` is close but not sufficient by itself for a reusable consume
cursor because the duplicate path does not expose the original append offset.
If the A-ledger design needs deterministic order for duplicate/replayed input
facts, it must either store that offset at first write or consume from the
lower-level stream append path where the offset is already returned.

## 3. Non-clock DurableDeferred crash recovery

Status: **BUILDABLE-WITH-SUBTLETY**.

Source-verified facts:

- The workflow engine table has a `deferreds` collection keyed by
  `deferredKey` at `packages/runtime/src/engine/internal/table.ts:53-59`, and a
  separate `clockWakeups` collection at `:62-70`.
- `deferredResult` reads the deferred row from `table.deferreds` using
  `${executionId}/${deferred.name}` at
  `packages/runtime/src/engine/internal/engine-runtime.ts:433-440`.
- `deferredDone` writes a deferred row when none exists at
  `packages/runtime/src/engine/internal/engine-runtime.ts:473-482`, then calls
  `resume(executionId)` at `:484`.
- `resume` returns without action when the execution row is absent or the
  workflow is not registered at
  `packages/runtime/src/engine/internal/engine-runtime.ts:184-187`.
- Existing startup recovery only scans pending clock wakeups:
  `packages/runtime/src/engine/internal/engine-runtime.ts:149-158`, and
  `makeWorkflowEngine` invokes only `recoverPendingClockWakeups` at
  `packages/runtime/src/engine/internal/engine-runtime.ts:527`.
- Workflow registration stores the workflow in the in-memory registry at
  `packages/runtime/src/engine/internal/engine-runtime.ts:254-261`.
- The unified runtime already has a registration-gated recovery pattern for
  pending session signals:
  `packages/runtime/src/unified/host.ts:276-319`.

Feasibility read:

The missing recovery is in an owned seam: deferred rows are durable, completion
already resumes the execution, and `resume` is idempotent enough to call from a
sweep. The important sequencing constraint is workflow registration. A sweep at
engine construction time can observe completed deferred rows, call `resume`,
and then no-op because the workflow catalog is still empty.

Minimal diff sketch:

1. Add `recoverPendingDeferredsForWorkflow(workflowName)` or a generalized
   `recoverPendingWakeups`.
2. Query `table.deferreds`, group or filter rows by `workflowName`, and dedupe
   by `executionId`.
3. For each execution id, skip rows whose execution is absent or final; calling
   `resume(executionId)` handles suspended/running checks.
4. Invoke the deferred sweep after `register` stores the workflow, or mirror
   the unified host pattern by waiting for a workflow-registered signal before
   recovery.
5. Keep `recoverPendingClockWakeups` for clock rows; the deferred sweep catches
   the crash window where a non-clock deferred row was written but its
   post-write resume did not complete.

Open subtlety:

The sweep should be registration-aware and probably once-per-workflow per engine
instance. Running it only at `makeWorkflowEngine` startup would overstate the
fix because `resume` can no-op before the workflow is registered.

## Bottom line for option A

All three A-ledger costs appear cheaply closeable in Firegrid-owned seams, but
none should be described as already solved. The strongest decision-grade caveat
is item 1: atomic `startOrAttach` needs a latch or per-key mutex that spans the
asynchronous spawn/build, not just a synchronous `Ref.modify` reservation.
