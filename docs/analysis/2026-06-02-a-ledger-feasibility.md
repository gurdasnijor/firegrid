# A-ledger feasibility and ownership read

Date: 2026-06-02

Task: tf-di8a

Scope: read-only feasibility/design note for the option-A named costs in the
runtime org/body-shape SDD. No runtime code was changed.

This note uses the ownership lens requested by the PO: the question is not
"what cost does A pay that B avoids?" The question is "where does this concern
belong, and which primitive should own it?" A self-inflicted modeling bug should
not be laundered into a design-space property.

Verdict summary:

- Per-`contextId` process lifecycle: **owned by a keyed lifecycle owner using
  `Workflow.idempotencyKey(contextId)`; dissolves**. The current
  `codec-adapter.ts` TOCTOU is an in-memory gateway bug with zero durable-streams
  involvement. A registry mutex is a symptom patch. The right hammer is an
  explicit keyed singleton lifecycle execution that owns spawn/deregister by
  construction.
- Consume cursor: **owned by the input ledger / per-key consumer using append
  offset or producer sequence; dissolves**. The blind read-count/write cursor is
  a modeling choice, not a substrate limit. Durable streams already expose
  append order and producer fencing; the design must use those instead of a
  counter.
- Non-clock deferred recovery: **owned by workflow-engine recovery using the
  existing deferred table and registration-aware resume; dissolves**. The
  clock-only sweep is an incomplete recovery owner, not a DurableDeferred
  limitation.

## 1. Per-`contextId` process lifecycle

Status: **owned-by-keyed-lifecycle-owner-using-Workflow.idempotencyKey(contextId)
(dissolves)**.

Source-verified facts:

- `ProductionCodecAdapterLive` allocates a host-local in-memory registry as
  `Ref.make<Map<string, RegistryEntry>>(new Map())` in
  `packages/runtime/src/unified/codec-adapter.ts:406`.
- `startOrAttach` currently performs `Ref.get` at
  `packages/runtime/src/unified/codec-adapter.ts:413-415`, returns an existing
  registry entry at `:416`, resolves context at `:418-424`, performs the async
  spawn/session build at `:426-435`, then writes the registry at `:436-440`.
  That is a check-then-act race over a plain in-memory `Ref<Map>`.
- There is no durable-streams dependency in that path. The async build uses the
  context resolver, sandbox provider, codec layer, output journal, id generator,
  env policy, and MCP endpoint service at
  `packages/runtime/src/unified/codec-adapter.ts:287-384`.
- The parked session body explicitly relied on one workflow execution per
  `(contextId, attempt)`: `RuntimeContextSessionWorkflow.idempotencyKey` is
  `${p.contextId}:${p.attempt}` at
  `packages/runtime/src/unified/subscribers/runtime-context.ts:67-72`.
- That same file states the old shape's intent: one execution per
  `(contextId, attempt)` kills the production TOCTOU at
  `packages/runtime/src/unified/subscribers/runtime-context.ts:23-25`.
- The parked body used one activity to call `adapter.startOrAttach` at
  `packages/runtime/src/unified/subscribers/runtime-context.ts:99-107`, then
  per-input `adapter.send` activities at `:137-143`, and terminal
  `adapter.deregister` at `:148-154`.
- Upstream `Workflow.make` derives `executionId` from
  `workflow.name + idempotencyKey(payload)` at
  `repos/effect/packages/workflow/src/Workflow.ts:281`, and `execute` passes that
  stable execution id to the engine at `:301-312`.
- Firegrid's engine uses that execution id to find/create the execution row and
  resume it at `packages/runtime/src/engine/internal/engine-runtime.ts:270-301`;
  `resume` avoids starting another running fiber for the same execution id at
  `packages/runtime/src/engine/internal/engine-runtime.ts:188-190`.

Ownership read:

The current race is not an option-A tax. It is a skipped decomposition step.
The parked body conflated two lifetimes:

- per-event input handling, which is genuinely per-event and belongs in option A;
- per-`contextId` process lifecycle, which is a keyed singleton: at most one live
  process/session per `contextId`.

Moving input handling to per-event work correctly removes the parked body as the
owner of event processing. It should not also remove the owner of process
lifecycle. The lifecycle needs its own explicit keyed singleton owner, using the
same `Workflow.idempotencyKey` primitive that made the parked body safe by
construction.

Right-hammer design sketch:

1. Introduce a small lifecycle workflow, for example
   `RuntimeContextProcessLifecycleWorkflow`, with payload `{ contextId }` and
   `idempotencyKey: ({ contextId }) => contextId`.
2. The lifecycle workflow owns spawn and cleanup. It resolves the context and
   calls the adapter/gateway's lower-level "open process/session" operation once
   for that key, then waits until a terminal/close signal before calling
   deregister/close.
3. Per-event handlers do not call `startOrAttach` directly as a registry
   get-or-create. They ensure the lifecycle workflow is armed/executing for the
   `contextId`, then deliver event input to the session/lifecycle owner or to an
   input ledger the owner consumes.
4. `codec-adapter.ts` stops being the concurrency authority. It remains the
   gateway that knows how to open a sandbox, build an ACP/raw `AgentSession`,
   gate codec input kinds, drain outputs, and close resources. The architecture
   read of what `codec-adapter.ts` should be is separate; this note only names
   the lifecycle ownership correction.
5. If a short-term patch is required before the lifecycle workflow lands, an
   in-flight latch or per-key mutex in the registry can contain the race. That is
   a tactical containment patch, not the design answer.

Why this is the right hammer:

The keyed execution primitive is already the system's durable "one owner for this
key" mechanism. Recreating that with a hand-rolled in-memory mutex inside
`codec-adapter.ts` makes host-local process state pretend to be runtime
coordination. A keyed lifecycle execution puts ownership back in the runtime
model and makes "once per context id" true by construction.

Open question:

The exact lifecycle surface still needs a design spike: whether per-event
handlers signal the lifecycle workflow directly, append to an input ledger it
consumes, or use a tiny service facade around both. That is an interface question,
not a durable-streams blocker.

## 2. Append-ordered / single-writer consume cursor

Status: **owned-by-input-ledger/per-key-consumer-using-append-offset-or-producer-seq
(dissolves)**.

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

Ownership read:

This is also self-inflicted modeling, not a genuine substrate limit. A blind
"count existing rows, write next cursor" counter makes ordering a read-modify-
write race. The owner should be the input ledger plus the single per-key
consumer/lifecycle owner, and the primitive should be append order: stream offset
or producer sequence.

Design sketch:

1. Per-event input writes append an input fact with an idempotent key and capture
   the returned append offset or producer sequence.
2. The per-`contextId` owner consumes input facts in append order. Its cursor is
   `{ contextId, lastConsumedOffset }` or equivalent, advanced by the owner after
   processing.
3. If the implementation uses DurableTable rows, extend the row/API so the
   original append offset is stored or returned on duplicate. Current
   `insertOrGet` is close, but duplicate reads do not expose the winner offset.
4. Do not use normal DurableTable `upsert` as a compare-and-swap substitute; it
   is a plain append path, and DurableTable explicitly says `insertOrGet` is not
   a locking primitive.

Open question:

Choose the concrete ledger surface: lower-level durable stream input log, or a
table API that captures and preserves the first append offset. Either is
buildable; the wrong owner is the blind counter.

## 3. Non-clock DurableDeferred crash recovery

Status: **owned-by-workflow-engine-recovery-using-deferred-table-plus-registration-aware-resume
(dissolves)**.

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

Ownership read:

The substrate already persists non-clock deferred completions. The missing piece
is recovery ownership: engine startup currently owns only clock wakeup recovery,
so a crash after a non-clock deferred row is written but before the post-write
`resume` completes can leave a resumable execution asleep. That is a clock-only
recovery sweep bug, not a DurableDeferred limit.

Design sketch:

1. Add `recoverPendingDeferredsForWorkflow(workflowName)` or a generalized
   recovery pass over both clock wakeups and deferred completions.
2. Query `table.deferreds`, group or filter rows by `workflowName`, and dedupe by
   `executionId`.
3. For each execution id, skip rows whose execution is absent or final; call
   `resume(executionId)` for the rest.
4. Run the deferred sweep after workflow registration, or mirror the unified
   host pattern that waits for workflow registration before recovering pending
   signals. A construction-time sweep can no-op because `resume` returns when
   the workflow is not registered.

Open question:

Whether to implement this as a generic engine recovery hook or a
per-workflow/register-time sweep. The owner should be workflow-engine recovery,
not caller code and not clock-specific recovery.

## Bottom line

All three items are buildable because they are Firegrid ownership/modeling gaps,
not hard substrate limitations:

- process lifecycle belongs to a keyed singleton lifecycle execution;
- input ordering belongs to the append-ordered ledger and its per-key consumer;
- deferred wakeup recovery belongs to workflow-engine recovery over all deferred
  completion rows, not just clock rows.

The important correction is item 1: do not frame the `startOrAttach` TOCTOU as
an intrinsic option-A cost. Option A separates per-event input handling from
per-context process lifecycle; the lifecycle simply needs its own explicit keyed
owner instead of inheriting ownership accidentally from the parked body.
