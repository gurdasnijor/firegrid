import { Console, Effect } from "effect"
import { appendTinyInput } from "./protocol.ts"
import {
  tinyInputAppendRuntime,
  type TinyInputAppendSnapshot,
  type WorkflowInputRow,
} from "./host.ts"

interface TinyInputAppendWakeupVerdict {
  readonly verdict: "GREEN"
  readonly uniqueInputs: number
  readonly appendAttempts: number
  readonly assignedSequences: ReadonlyArray<number>
  readonly pointReads: number
  readonly replayPathInputQueries: number
  readonly wakeupSignals: number
  readonly wakeupAwaits: number
}

const contextId = "phase0c-context"

const distinctInputIds = Array.from(
  { length: 4 },
  (_, index) => `input-${index + 1}`,
)

const allInputIds = ["duplicate-0", ...distinctInputIds]

const sortedBySequence = (
  rows: ReadonlyArray<WorkflowInputRow>,
): ReadonlyArray<WorkflowInputRow> =>
  [...rows].sort((left, right) => left.sequence - right.sequence)

const assertInvariant = (
  condition: boolean,
  message: string,
  snapshot: TinyInputAppendSnapshot,
) =>
  condition
    ? Effect.void
    : Effect.fail(new Error(
      `tiny input append wakeup invariant failed: ${message}; ${
        JSON.stringify(snapshot)
      }`,
    ))

export const tinyInputAppendWakeupDriver:
  Effect.Effect<TinyInputAppendWakeupVerdict, unknown> = Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => tinyInputAppendRuntime)

    const duplicatePayload = {
      contextId,
      inputId: "duplicate-0",
      body: "duplicate prompt must allocate once",
    }

    const duplicateResults = yield* Effect.all([
      runtime.dispatch(appendTinyInput(duplicatePayload)),
      runtime.dispatch(appendTinyInput({
        ...duplicatePayload,
        body: "duplicate prompt must converge idempotently",
      })),
    ], { concurrency: "unbounded" })

    yield* Effect.forEach(
      distinctInputIds,
      inputId =>
        runtime.dispatch(appendTinyInput({
          contextId,
          inputId,
          body: `distinct concurrent input ${inputId}`,
        })),
      { concurrency: "unbounded", discard: true },
    )

    yield* runtime.waitForProcessedCount(allInputIds.length)
    const snapshot = yield* runtime.snapshot(allInputIds)
    const inputs = sortedBySequence(snapshot.inputs)
    const sequences = inputs.map(input => input.sequence)
    const uniqueSequences = new Set(sequences)
    const duplicateInputResults = duplicateResults as ReadonlyArray<
      WorkflowInputRow
    >

    yield* assertInvariant(
      snapshot.context.nextInputSequence === allInputIds.length,
      "workflow cursor did not advance to every unique input",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.context.nextInputSequenceToAssign === allInputIds.length,
      "allocation cursor did not reserve exactly every unique input",
      snapshot,
    )
    yield* assertInvariant(
      inputs.length === allInputIds.length,
      "input table row count differs from unique input count",
      snapshot,
    )
    yield* assertInvariant(
      sequences.every((sequence, index) => sequence === index),
      "input sequences are not dense point-addressable keys",
      snapshot,
    )
    yield* assertInvariant(
      uniqueSequences.size === allInputIds.length,
      "distinct concurrent producers reused a sequence",
      snapshot,
    )
    yield* assertInvariant(
      duplicateInputResults[0]?.inputKey === duplicateInputResults[1]?.inputKey,
      "duplicate inputId did not converge on the same inputKey",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.inputIds.length === allInputIds.length,
      "inputIds idempotency index row count differs from unique input count",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.context.processedInputKeys.join(",") ===
        inputs.map(input => input.inputKey).join(","),
      "processed input keys do not follow durable cursor order",
      snapshot,
    )
    yield* assertInvariant(
      inputs.every(input => input.processedAt !== undefined),
      "workflow did not mark every point-read input processed",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.atomicAppendAttempts === allInputIds.length + 1,
      "append attempts did not include the duplicate attempt",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.atomicAppendInserted === allInputIds.length,
      "atomic append inserted count differs from unique input count",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.atomicAppendFound === 1,
      "inputIds idempotency index did not serve exactly one duplicate",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.replayPathInputQueries === 0,
      "workflow used a replay-path scan",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.maxExistingSequenceAllocations === 0,
      "allocator used scan-derived sequence assignment",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.bridgeRows === 0,
      "legacy bridge rows were used",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.pointReads >= allInputIds.length,
      "workflow did not point-read by inputKey",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.wakeupSignals >= allInputIds.length,
      "table-write wakeup signal did not fire for each unique append",
      snapshot,
    )
    yield* assertInvariant(
      snapshot.instrumentation.wakeupAwaits > 0,
      "workflow never awaited the table-write wakeup",
      snapshot,
    )

    const verdict: TinyInputAppendWakeupVerdict = {
      verdict: "GREEN",
      uniqueInputs: allInputIds.length,
      appendAttempts: snapshot.instrumentation.atomicAppendAttempts,
      assignedSequences: sequences,
      pointReads: snapshot.instrumentation.pointReads,
      replayPathInputQueries:
        snapshot.instrumentation.replayPathInputQueries,
      wakeupSignals: snapshot.instrumentation.wakeupSignals,
      wakeupAwaits: snapshot.instrumentation.wakeupAwaits,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_phase0c.verdict": verdict.verdict,
      "firegrid.tiny_phase0c.input.unique_count": verdict.uniqueInputs,
      "firegrid.tiny_phase0c.input.append_attempts": verdict.appendAttempts,
      "firegrid.tiny_phase0c.input.point_reads": verdict.pointReads,
      "firegrid.tiny_phase0c.input.replay_path_queries":
        verdict.replayPathInputQueries,
      "firegrid.tiny_phase0c.input.max_existing_allocations":
        snapshot.instrumentation.maxExistingSequenceAllocations,
      "firegrid.tiny_phase0c.input.bridge_rows":
        snapshot.instrumentation.bridgeRows,
      "firegrid.tiny_phase0c.input.wakeup_signals": verdict.wakeupSignals,
      "firegrid.tiny_phase0c.input.wakeup_awaits": verdict.wakeupAwaits,
      "firegrid-workflow-driven-runtime.ACID":
        "PHASE_0_TARGET_REFERENCE.3,PHASE_0_TARGET_REFERENCE.4,PHASE_0_TARGET_REFERENCE.5,PHASE_0_TARGET_REFERENCE.6,BOUNDARIES.7-1",
    })

    yield* Console.log(
      [
        `tiny input append wakeup: ${verdict.verdict}`,
        `  unique inputs: ${verdict.uniqueInputs}`,
        `  append attempts: ${verdict.appendAttempts}`,
        `  sequences: ${verdict.assignedSequences.join(",")}`,
        `  point reads: ${verdict.pointReads}`,
        `  replay-path scan counter: ${verdict.replayPathInputQueries}`,
        `  wakeup signals/awaits: ${verdict.wakeupSignals}/${verdict.wakeupAwaits}`,
      ].join("\n"),
    )

    return verdict
  }).pipe(
    Effect.withSpan("firegrid.tiny_phase0c.verdict", {
      kind: "internal",
      attributes: {
        "firegrid.tiny_phase0c.scope":
          "atomic-input-append-point-read-wakeup",
      },
    }),
  )
