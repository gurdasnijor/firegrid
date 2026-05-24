import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import {
  ChannelRouteVerbNotSupported,
  type ChannelDispatchRequest,
} from "@firegrid/protocol/channels/router"
import {
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  targetArchitectureReferenceInputChannelTarget,
  targetArchitectureReferenceOutputChannelTarget,
  WorkflowInputSchema,
  WorkflowOutputObservationSchema,
  WorkflowOutputWaitSchema,
  type WorkflowOutputObservation,
} from "./protocol.ts"
import {
  TargetArchitectureReferenceTable,
  targetArchitectureReferenceTableOptions,
  verboseTextChunkCount,
  workflowCursorId,
  type OutputObserverRow,
  type SessionRow,
  type WorkflowCursorRow,
  type WorkflowInputRow,
  type WorkflowOutputRow,
} from "./resources.ts"

interface TargetArchitectureReferenceRuntime {
  readonly dispatch: (
    request: ChannelDispatchRequest,
  ) => Effect.Effect<unknown, unknown>
  readonly replayBoundary: (
    reason: string,
  ) => Effect.Effect<WorkflowCursorRow, unknown>
  readonly durableRows: Effect.Effect<{
    readonly sessions: ReadonlyArray<SessionRow>
    readonly inputs: ReadonlyArray<WorkflowInputRow>
    readonly outputs: ReadonlyArray<WorkflowOutputRow>
    readonly workflowCursors: ReadonlyArray<WorkflowCursorRow>
    readonly outputObservers: ReadonlyArray<OutputObserverRow>
  }, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: TargetArchitectureReferenceRuntime) => void =
    () => undefined
  const promise = new Promise<TargetArchitectureReferenceRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return {
    promise,
    resolve: resolveRuntime,
  }
})()

export const targetArchitectureReferenceRuntime = runtimeLatch.promise

const sessionId = "phase0b-session"
const toolCallId = "phase0b-sleep-tool-call"

const now = (): string => new Date().toISOString()

// tf-bz4x: inputs are addressed by `${sessionId}/${sequence}`, symmetric with
// `outputKeyForSequence`, so the workflow can point-`get` the next input by
// sequence instead of scanning the input log on the replay path. The driver
// supplies the sequence per session (SDD target model) and resends a duplicate
// with the SAME (inputId, sequence) pair, so a sequence-addressed primary key
// still converges duplicate input identity via `insertOrGet`. `inputId` stays
// on the row as identity evidence.
const inputKeyForSequence = (
  ownedSessionId: string,
  sequence: number,
) => `${ownedSessionId}/${sequence}`

const outputKeyForSequence = (
  ownedSessionId: string,
  sequence: number,
) => `${ownedSessionId}/${sequence}`

const initialSession = (): SessionRow => ({
  sessionId,
  status: "open",
  updatedAt: now(),
})

const initialWorkflowCursor = (): WorkflowCursorRow => ({
  cursorId: workflowCursorId,
  sessionId,
  lastInputSequence: 0,
  processedInputCount: 0,
  processedInputKeys: [],
  replayCount: 0,
  outputCount: 0,
  updatedAt: now(),
})

const initialOutputObserver = (
  observerId: string,
): OutputObserverRow => ({
  observerId,
  sessionId,
  nextSequence: 1,
  observationAttempts: 0,
  observedOutputKeys: [],
  updatedAt: now(),
})

const readWorkflowCursor = (
  table: TargetArchitectureReferenceTable["Type"],
) =>
  table.workflowCursors.get(workflowCursorId).pipe(
    Effect.map(Option.getOrElse(initialWorkflowCursor)),
  )

const readOutputObserver = (
  table: TargetArchitectureReferenceTable["Type"],
  observerId: string,
) =>
  table.outputObservers.get(observerId).pipe(
    Effect.map(Option.getOrElse(() => initialOutputObserver(observerId))),
  )

const ensureSession = (
  table: TargetArchitectureReferenceTable["Type"],
) =>
  table.sessions.insertOrGet(initialSession()).pipe(
    Effect.asVoid,
  )

const outputRowsForInput = (
  input: WorkflowInputRow,
): ReadonlyArray<WorkflowOutputRow> => {
  if (input.kind === "tool_result") {
    return [
      {
        outputKey: outputKeyForSequence(
          input.sessionId,
          verboseTextChunkCount + 2,
        ),
        sessionId: input.sessionId,
        sequence: verboseTextChunkCount + 2,
        kind: "ToolResult",
        body: input.body,
        toolCallId: input.toolCallId,
        appendedAt: now(),
      },
      {
        outputKey: outputKeyForSequence(
          input.sessionId,
          verboseTextChunkCount + 3,
        ),
        sessionId: input.sessionId,
        sequence: verboseTextChunkCount + 3,
        kind: "TextChunk",
        body: `tool result returned: ${input.body}`,
        appendedAt: now(),
      },
      {
        outputKey: outputKeyForSequence(
          input.sessionId,
          verboseTextChunkCount + 4,
        ),
        sessionId: input.sessionId,
        sequence: verboseTextChunkCount + 4,
        kind: "TurnComplete",
        body: `result: ${input.body}`,
        appendedAt: now(),
      },
    ]
  }

  const textOutputs: ReadonlyArray<WorkflowOutputRow> = Array.from({
    length: verboseTextChunkCount,
  }, (_, index) => ({
    outputKey: outputKeyForSequence(input.sessionId, index + 1),
    sessionId: input.sessionId,
    sequence: index + 1,
    kind: "TextChunk",
    body: `verbose output chunk ${index + 1}`,
    appendedAt: now(),
  }))
  return [
    ...textOutputs,
    {
      outputKey: outputKeyForSequence(
        input.sessionId,
        verboseTextChunkCount + 1,
      ),
      sessionId: input.sessionId,
      sequence: verboseTextChunkCount + 1,
      kind: "ToolUse",
      body: "sleep durationMs=0",
      toolCallId,
      appendedAt: now(),
    },
  ]
}

const appendOutputIfAbsent = (
  table: TargetArchitectureReferenceTable["Type"],
  output: WorkflowOutputRow,
) =>
  table.outputs.insertOrGet(output).pipe(
    Effect.tap(result =>
      result._tag === "Inserted"
        ? Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            "firegrid.tiny_reference.output.sequence": output.sequence,
            "firegrid.tiny_reference.output.key": output.outputKey,
            "firegrid.tiny_reference.output.kind": output.kind,
          })
        }).pipe(
          Effect.withSpan("firegrid.tiny_reference.phase0b.output_append", {
            kind: "producer",
            attributes: {
              "firegrid-workflow-driven-runtime.ACID":
                "PHASE_0B_OUTPUT_RESULT_RETURN.1",
            },
          }),
        )
        : Effect.void,
    ),
  )

const markInputProcessed = (
  table: TargetArchitectureReferenceTable["Type"],
  input: WorkflowInputRow,
) =>
  table.inputs.upsert({
    ...input,
    processedAt: now(),
  })

const processInput = (
  table: TargetArchitectureReferenceTable["Type"],
  cursor: WorkflowCursorRow,
  input: WorkflowInputRow,
) =>
  Effect.gen(function*() {
    const outputs = outputRowsForInput(input)
    yield* Effect.forEach(outputs, output => appendOutputIfAbsent(table, output), {
      discard: true,
    })
    yield* markInputProcessed(table, input)
    // tf-buek: accumulate the output total from durable cursor state plus the
    // deterministic per-input append set, instead of scanning the output log
    // (`outputs.query(coll => coll.toArray.length)`) on the transition path.
    // Each input is cursor-gated to process exactly once and
    // `outputRowsForInput` is deterministic, so this is exact and replay-safe:
    // re-running a not-yet-committed input recomputes the same total (the
    // append is idempotent via insertOrGet, and the cursor advance carrying
    // both lastInputSequence and outputCount commits atomically below).
    const outputCount = cursor.outputCount + outputs.length
    const nextStatus = input.kind === "tool_result" ? "complete" : "waiting_for_tool"
    yield* table.sessions.upsert({
      sessionId: input.sessionId,
      status: nextStatus,
      result: input.kind === "tool_result" ? input.body : undefined,
      updatedAt: now(),
    })
    const nextCursor: WorkflowCursorRow = {
      ...cursor,
      lastInputSequence: input.sequence,
      processedInputCount: cursor.processedInputCount + 1,
      processedInputKeys: [...cursor.processedInputKeys, input.inputKey],
      outputCount,
      updatedAt: now(),
    }
    yield* table.workflowCursors.upsert(nextCursor)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.workflow.input_key": input.inputKey,
      "firegrid.tiny_reference.workflow.input_sequence": input.sequence,
      "firegrid.tiny_reference.workflow.output_count": outputCount,
      "firegrid.tiny_reference.workflow.cursor": nextCursor.lastInputSequence,
    })
    return nextCursor
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.phase0b.workflow.transition", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "TargetArchitectureReferencePhase0BWorkflow",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

// tf-bz4x: point-addressed next-input read, symmetric with
// `nextOutputForObserver`. Reads exactly the row at `sequence` by primary key —
// no `coll.toArray`/filter scan over the input log.
const nextInputForSequence = (
  table: TargetArchitectureReferenceTable["Type"],
  ownedSessionId: string,
  sequence: number,
) =>
  table.inputs.get(inputKeyForSequence(ownedSessionId, sequence)).pipe(
    Effect.map(Option.getOrUndefined),
  )

// tf-bz4x: drain contiguous pending inputs by point `get` from
// `lastInputSequence + 1`, mirroring the durable output observer. On replay the
// durable cursor lets this resume at its position with O(1) reads per input,
// not an O(history) re-scan inside the replay boundary.
const processPendingInputs = (
  table: TargetArchitectureReferenceTable["Type"],
) =>
  Effect.gen(function*() {
    yield* ensureSession(table)
    let cursor = yield* readWorkflowCursor(table)
    while (true) {
      const next = yield* nextInputForSequence(
        table,
        cursor.sessionId,
        cursor.lastInputSequence + 1,
      )
      if (next === undefined) break
      cursor = yield* processInput(table, cursor, next)
    }
    return cursor
  })

const replayBoundaryFor = (
  table: TargetArchitectureReferenceTable["Type"],
  reason: string,
) =>
  Effect.gen(function*() {
    const before = yield* readWorkflowCursor(table)
    yield* table.workflowCursors.upsert({
      ...before,
      replayCount: before.replayCount + 1,
      updatedAt: now(),
    })
    const after = yield* processPendingInputs(table)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.workflow.replay_reason": reason,
      "firegrid.tiny_reference.workflow.replay_count": before.replayCount + 1,
      "firegrid.tiny_reference.workflow.last_input_sequence":
        after.lastInputSequence,
      "firegrid.tiny_reference.workflow.output_count": after.outputCount,
    })
    return after
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.phase0b.workflow.replay_boundary", {
      kind: "internal",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

const runWorkflow = (
  table: TargetArchitectureReferenceTable["Type"],
) =>
  table.inputs.rows().pipe(
    Stream.runForEach(row =>
      Effect.gen(function*() {
        yield* Effect.succeed(row).pipe(
          Effect.withSpan("firegrid.tiny_reference.workflow.read_table", {
            kind: "consumer",
            attributes: {
              "firegrid.channel.target": String(
                targetArchitectureReferenceInputChannelTarget,
              ),
              "firegrid.tiny_reference.input_id": row.inputId,
              "firegrid.tiny_reference.input_sequence": row.sequence,
            },
          }),
        )
        yield* processPendingInputs(table)
      }),
    ),
  )

const writeInput = (
  table: TargetArchitectureReferenceTable["Type"],
  payload: unknown,
) =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknown(WorkflowInputSchema, {
      onExcessProperty: "error",
    })(payload)
    const row: WorkflowInputRow = {
      ...decoded,
      inputKey: inputKeyForSequence(decoded.sessionId, decoded.sequence),
      acceptedAt: now(),
    }
    yield* ensureSession(table)
    const result = yield* table.inputs.insertOrGet(row)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.input.key": row.inputKey,
      "firegrid.tiny_reference.input.sequence": row.sequence,
      "firegrid.tiny_reference.input.insert_result": result._tag,
    })
    return result._tag === "Inserted" ? row : result.row
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.phase0b.channel.input_write", {
      kind: "producer",
      attributes: {
        "firegrid.channel.target": String(
          targetArchitectureReferenceInputChannelTarget,
        ),
        "firegrid.channel.verb": "send",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.3",
      },
    }),
  )

const nextOutputForObserver = (
  table: TargetArchitectureReferenceTable["Type"],
  observer: OutputObserverRow,
) =>
  table.outputs.get(
    outputKeyForSequence(observer.sessionId, observer.nextSequence),
  ).pipe(
    Effect.map(Option.getOrUndefined),
  )

const waitForCurrentOrFutureOutput = (
  table: TargetArchitectureReferenceTable["Type"],
  observer: OutputObserverRow,
) =>
  Effect.gen(function*() {
    const current = yield* nextOutputForObserver(table, observer)
    if (current !== undefined) return current
    return yield* table.outputs.rows().pipe(
      Stream.filter(row =>
        row.sessionId === observer.sessionId &&
        row.sequence === observer.nextSequence),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () => Effect.never,
        onSome: row => Effect.succeed(row),
      })),
    )
  })

const waitForOutput = (
  table: TargetArchitectureReferenceTable["Type"],
  payload: unknown,
) =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknown(WorkflowOutputWaitSchema, {
      onExcessProperty: "error",
    })(payload)
    const observer = yield* readOutputObserver(table, decoded.observerId)
    const sessionObserver = observer.sessionId === decoded.sessionId
      ? observer
      : initialOutputObserver(decoded.observerId)
    const output = yield* waitForCurrentOrFutureOutput(table, sessionObserver)
    const observedOutputKeys = sessionObserver.observedOutputKeys.includes(
      output.outputKey,
    )
      ? sessionObserver.observedOutputKeys
      : [...sessionObserver.observedOutputKeys, output.outputKey]
    const nextObserver: OutputObserverRow = {
      ...sessionObserver,
      sessionId: decoded.sessionId,
      nextSequence: output.sequence + 1,
      observationAttempts: sessionObserver.observationAttempts + 1,
      observedOutputKeys,
      updatedAt: now(),
    }
    yield* table.outputObservers.upsert(nextObserver)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.output.sequence": output.sequence,
      "firegrid.tiny_reference.output.kind": output.kind,
      "firegrid.tiny_reference.output.observer_id": nextObserver.observerId,
      "firegrid.tiny_reference.output.next_sequence": nextObserver.nextSequence,
      "firegrid.tiny_reference.output.observation_attempts":
        nextObserver.observationAttempts,
    })
    const observation: WorkflowOutputObservation = {
      observerId: nextObserver.observerId,
      nextSequence: nextObserver.nextSequence,
      observationAttempts: nextObserver.observationAttempts,
      output,
    }
    return yield* Schema.decodeUnknown(WorkflowOutputObservationSchema)(
      observation,
    )
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.phase0b.output_observe", {
      kind: "consumer",
      attributes: {
        "firegrid.channel.target": String(
          targetArchitectureReferenceOutputChannelTarget,
        ),
        "firegrid.channel.verb": "wait_for",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.2",
      },
    }),
  )

const unsupportedVerb = (
  request: ChannelDispatchRequest,
  supportedVerbs: ReadonlyArray<"send" | "call" | "wait_for">,
) =>
  new ChannelRouteVerbNotSupported({
    target: String(request.target),
    verb: request.verb,
    direction: "bidirectional",
    supportedVerbs,
  })

const dispatchFor = (
  table: TargetArchitectureReferenceTable["Type"],
): TargetArchitectureReferenceRuntime["dispatch"] =>
  (request) =>
    Effect.gen(function*() {
      if (String(request.target) === String(targetArchitectureReferenceInputChannelTarget)) {
        switch (request.verb) {
          case "send":
            return yield* writeInput(table, request.payload)
          case "call":
          case "wait_for":
            return yield* Effect.fail(unsupportedVerb(request, ["send"]))
        }
      }
      if (String(request.target) === String(targetArchitectureReferenceOutputChannelTarget)) {
        switch (request.verb) {
          case "wait_for":
            return yield* waitForOutput(table, request.payload)
          case "call":
          case "send":
            return yield* Effect.fail(unsupportedVerb(request, ["wait_for"]))
        }
      }
      return yield* Effect.fail({
        _tag: "UnknownChannelTarget",
        target: String(request.target),
      })
    }).pipe(
      Effect.withSpan("firegrid.channel.dispatch", {
        kind: "internal",
        attributes: {
          "firegrid.channel.target": String(request.target),
          "firegrid.channel.verb": request.verb,
          "firegrid.channel.direction": "bidirectional",
        },
      }),
    )

const runtimeFor = (
  table: TargetArchitectureReferenceTable["Type"],
): TargetArchitectureReferenceRuntime => ({
  dispatch: dispatchFor(table),
  replayBoundary: reason => replayBoundaryFor(table, reason),
  durableRows: Effect.gen(function*() {
    const sessions = yield* table.sessions.query(coll =>
      coll.toArray.sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId),
      ),
    )
    const inputs = yield* table.inputs.query(coll =>
      coll.toArray.sort((left, right) => left.sequence - right.sequence),
    )
    const outputs = yield* table.outputs.query(coll =>
      coll.toArray.sort((left, right) => left.sequence - right.sequence),
    )
    const workflowCursors = yield* table.workflowCursors.query(coll =>
      coll.toArray.sort((left, right) =>
        left.cursorId.localeCompare(right.cursorId),
      ),
    )
    const outputObservers = yield* table.outputObservers.query(coll =>
      coll.toArray.sort((left, right) =>
        left.observerId.localeCompare(right.observerId),
      ),
    )
    return { sessions, inputs, outputs, workflowCursors, outputObservers }
  }),
})

export const targetArchitectureReferenceHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const tableLayer = TargetArchitectureReferenceTable.layer(
    targetArchitectureReferenceTableOptions(env),
  )
  const workflowLayer = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* TargetArchitectureReferenceTable
      const runtime = runtimeFor(table)
      runtimeLatch.resolve(runtime)
      yield* runWorkflow(table).pipe(Effect.forkScoped)
    }),
  )

  return workflowLayer.pipe(
    Layer.provide(tableLayer),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
