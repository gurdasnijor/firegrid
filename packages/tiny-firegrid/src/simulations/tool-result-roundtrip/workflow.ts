import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import {
  Effect,
  Layer,
  Option,
} from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  ToolRoundtripTable,
  roundtripSessionId,
  toolRoundtripTableOptions,
  type LoopStateRow,
  type OutputRow,
  type ToolResultRow,
} from "./resources.ts"

interface ToolRoundtripRuntime {
  // Agent emits an output row (text / tool_use / turn_complete), then the
  // workflow drains: a tool_use triggers an idempotent tool execution + result
  // append; turn_complete marks the turn done.
  readonly emitOutput: (
    output: Pick<OutputRow, "sequence" | "kind" | "toolUseId" | "body">,
  ) => Effect.Effect<LoopStateRow, unknown>
  // A replay boundary: reconstruct loop state from the table and drain again.
  // Nothing in-memory survives — the only state is the durable row.
  readonly replayBoundary: (reason: string) => Effect.Effect<LoopStateRow, unknown>
  readonly durableRows: Effect.Effect<{
    readonly loopState: LoopStateRow
    readonly outputs: ReadonlyArray<OutputRow>
    readonly toolResults: ReadonlyArray<ToolResultRow>
  }, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: ToolRoundtripRuntime) => void = () => undefined
  const promise = new Promise<ToolRoundtripRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const toolRoundtripRuntime = runtimeLatch.promise

const sessionId = roundtripSessionId

const now = (): string => new Date().toISOString()

const outputKeyFor = (sequence: number) => `${sessionId}/${sequence}`
const toolResultKeyFor = (toolUseId: string) => `${sessionId}/${toolUseId}`

const toolResultBody = (toolUseId: string) => `executed ${toolUseId} -> ok`

const initialLoopState = (): LoopStateRow => ({
  loopStateId: sessionId,
  sessionId,
  lastOutputSequence: 0,
  executedToolUses: [],
  toolExecutionCount: 0,
  toolResultCount: 0,
  turnComplete: false,
  reloadCount: 0,
  outputReadCount: 0,
  outputHitCount: 0,
  consumedOutputSequences: [],
  updatedAt: now(),
})

// Reload loop state from the durable table. Every processing pass reconstructs
// progress from this row — there is no in-memory state threaded across replays.
const reloadLoopState = (
  table: ToolRoundtripTable["Type"],
) =>
  table.loopState.get(sessionId).pipe(
    Effect.map(Option.getOrElse(initialLoopState)),
    Effect.map((state): LoopStateRow => ({
      ...state,
      reloadCount: state.reloadCount + 1,
    })),
    Effect.withSpan("firegrid.tiny_tool_roundtrip.reload", {
      kind: "internal",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

// Execute a tool exactly once. insertOrGet on the toolUseId-keyed result row is
// the idempotency fence: a replay (or a crash-retried pass) finds the existing
// result instead of re-running the tool side effect.
const executeToolIfNeeded = (
  table: ToolRoundtripTable["Type"],
  state: LoopStateRow,
  output: OutputRow,
): Effect.Effect<LoopStateRow, unknown> =>
  Effect.gen(function*() {
    const toolUseId = output.toolUseId
    if (output.kind !== "tool_use" || toolUseId === undefined) return state
    if (state.executedToolUses.includes(toolUseId)) return state
    const result = yield* table.toolResults.insertOrGet({
      toolResultKey: toolResultKeyFor(toolUseId),
      sessionId,
      toolUseId,
      requestedAtSequence: output.sequence,
      result: toolResultBody(toolUseId),
      at: now(),
    })
    const genuinelyExecuted = result._tag === "Inserted"
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_tool_roundtrip.tool_use_id": toolUseId,
      "firegrid.tiny_tool_roundtrip.tool_executed": genuinelyExecuted,
    })
    return {
      ...state,
      executedToolUses: [...state.executedToolUses, toolUseId],
      toolExecutionCount: state.toolExecutionCount + (genuinelyExecuted ? 1 : 0),
      toolResultCount: state.toolResultCount + (genuinelyExecuted ? 1 : 0),
    }
  }).pipe(
    Effect.withSpan("firegrid.tiny_tool_roundtrip.tool_execute", {
      kind: "producer",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.2",
      },
    }),
  )

const applyOutputTransition = (
  table: ToolRoundtripTable["Type"],
  state: LoopStateRow,
  output: OutputRow,
): Effect.Effect<LoopStateRow, unknown> =>
  output.kind === "tool_use"
    ? executeToolIfNeeded(table, state, output)
    : output.kind === "turn_complete"
    ? Effect.succeed({ ...state, turnComplete: true })
    : Effect.succeed(state)

// Skip output cursor: point-read cursor+1, never touch <= cursor.
const nextOutputForSequence = (
  table: ToolRoundtripTable["Type"],
  sequence: number,
) =>
  table.outputs.get(outputKeyFor(sequence)).pipe(Effect.map(Option.getOrUndefined))

const drainOutputs = (
  table: ToolRoundtripTable["Type"],
  state: LoopStateRow,
): Effect.Effect<LoopStateRow, unknown> =>
  Effect.gen(function*() {
    let current = state
    while (true) {
      const sequence = current.lastOutputSequence + 1
      const next = yield* nextOutputForSequence(table, sequence)
      const hit = next !== undefined
      yield* Effect.annotateCurrentSpan({
        "firegrid.tiny_tool_roundtrip.output.read_sequence": sequence,
        "firegrid.tiny_tool_roundtrip.output.read_hit": hit,
      })
      current = { ...current, outputReadCount: current.outputReadCount + 1 }
      if (!hit) break
      const transitioned = yield* applyOutputTransition(table, current, next)
      current = {
        ...transitioned,
        lastOutputSequence: next.sequence,
        outputHitCount: transitioned.outputHitCount + 1,
        consumedOutputSequences: [
          ...transitioned.consumedOutputSequences,
          next.sequence,
        ],
      }
    }
    return current
  }).pipe(
    Effect.withSpan("firegrid.tiny_tool_roundtrip.output.skip_cursor_drain", {
      kind: "internal",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.5",
      },
    }),
  )

// One processing pass: reload, drain outputs with the skip cursor (executing
// tools idempotently), persist. SDD_TARGET "replay reconstructs from table state".
const processPending = (
  table: ToolRoundtripTable["Type"],
): Effect.Effect<LoopStateRow, unknown> =>
  Effect.gen(function*() {
    const reloaded = yield* reloadLoopState(table)
    const drained = yield* drainOutputs(table, reloaded)
    const persisted: LoopStateRow = { ...drained, updatedAt: now() }
    yield* table.loopState.upsert(persisted)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_tool_roundtrip.last_output_sequence": persisted.lastOutputSequence,
      "firegrid.tiny_tool_roundtrip.tool_execution_count": persisted.toolExecutionCount,
      "firegrid.tiny_tool_roundtrip.tool_result_count": persisted.toolResultCount,
      "firegrid.tiny_tool_roundtrip.turn_complete": persisted.turnComplete,
      "firegrid.tiny_tool_roundtrip.reload_count": persisted.reloadCount,
      "firegrid.tiny_tool_roundtrip.output_hit_count": persisted.outputHitCount,
    })
    return persisted
  }).pipe(
    Effect.withSpan("firegrid.tiny_tool_roundtrip.process_pending", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "TinyToolRoundtripWorkflow",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

const appendOutput = (
  table: ToolRoundtripTable["Type"],
  output: Pick<OutputRow, "sequence" | "kind" | "toolUseId" | "body">,
) =>
  table.outputs.insertOrGet({
    outputKey: outputKeyFor(output.sequence),
    sessionId,
    sequence: output.sequence,
    kind: output.kind,
    ...(output.toolUseId === undefined ? {} : { toolUseId: output.toolUseId }),
    body: output.body,
    appendedAt: now(),
  }).pipe(
    Effect.withSpan("firegrid.tiny_tool_roundtrip.output_append", {
      kind: "producer",
      attributes: {
        "firegrid.tiny_tool_roundtrip.output.sequence": output.sequence,
        "firegrid.tiny_tool_roundtrip.output.kind": output.kind,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.1",
      },
    }),
  )

const runtimeFor = (
  table: ToolRoundtripTable["Type"],
): ToolRoundtripRuntime => ({
  emitOutput: output =>
    appendOutput(table, output).pipe(Effect.zipRight(processPending(table))),
  replayBoundary: reason =>
    processPending(table).pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "firegrid.tiny_tool_roundtrip.replay_reason": reason,
        })),
      Effect.withSpan("firegrid.tiny_tool_roundtrip.replay_boundary", {
        kind: "internal",
        attributes: {
          "firegrid-workflow-driven-runtime.ACID":
            "PHASE_0B_OUTPUT_RESULT_RETURN.3",
        },
      }),
    ),
  durableRows: Effect.gen(function*() {
    const loopState = yield* table.loopState.get(sessionId).pipe(
      Effect.map(Option.getOrElse(initialLoopState)),
    )
    const outputs = yield* table.outputs.query(coll =>
      coll.toArray.sort((left, right) => left.sequence - right.sequence),
    )
    const toolResults = yield* table.toolResults.query(coll =>
      coll.toArray.sort((left, right) =>
        left.requestedAtSequence - right.requestedAtSequence),
    )
    return { loopState, outputs, toolResults }
  }),
})

export const toolRoundtripHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const tableLayer = ToolRoundtripTable.layer(toolRoundtripTableOptions(env))
  const workflowLayer = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* ToolRoundtripTable
      runtimeLatch.resolve(runtimeFor(table))
    }),
  )
  return workflowLayer.pipe(
    Layer.provide(tableLayer),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
