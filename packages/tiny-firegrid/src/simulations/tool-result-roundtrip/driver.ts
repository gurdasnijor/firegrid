import { Effect } from "effect"
import {
  toolRoundtripRuntime,
} from "./workflow.ts"

interface ToolRoundtripVerdict {
  readonly verdict: "GREEN"
  readonly distinctOutputs: number
  readonly outputHitCount: number
  readonly outputReadCount: number
  readonly reloadCount: number
  readonly toolExecutionCount: number
  readonly toolResultCount: number
  readonly amplification: number
}

const isStrictlyIncreasingFrom1 = (
  sequences: ReadonlyArray<number>,
): boolean => sequences.every((sequence, index) => sequence === index + 1)

export const toolRoundtripDriver: Effect.Effect<ToolRoundtripVerdict, unknown> =
  Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => toolRoundtripRuntime)

    // Agent turn: text, then two parallel tool calls.
    yield* runtime.emitOutput({ sequence: 1, kind: "text", body: "thinking..." })
    yield* runtime.emitOutput({
      sequence: 2,
      kind: "tool_use",
      toolUseId: "tool-1",
      body: "sleep durationMs=0",
    })
    yield* runtime.emitOutput({
      sequence: 3,
      kind: "tool_use",
      toolUseId: "tool-2",
      body: "echo hello",
    })

    // Replay AFTER both tools executed but BEFORE the turn completes. The skip
    // cursor must resume at lastOutputSequence=3 and the durable executedToolUses
    // set must prevent re-running either tool side effect.
    yield* runtime.replayBoundary("mid-turn-after-tools")

    // The agent only continues once it has the tool results back (the roundtrip
    // feedback): confirm both results are durably appended before TurnComplete.
    const afterTools = yield* runtime.durableRows
    const toolResultsReady = afterTools.toolResults.length === 2

    yield* runtime.emitOutput({
      sequence: 4,
      kind: "text",
      body: `received: ${afterTools.toolResults.map(r => r.result).join("; ")}`,
    })
    yield* runtime.emitOutput({
      sequence: 5,
      kind: "turn_complete",
      body: "done",
    })

    // Idempotent re-reload after completion: no re-execution, no double-append.
    yield* runtime.replayBoundary("post-turn-complete")

    const durableRows = yield* runtime.durableRows
    const state = durableRows.loopState
    const distinctOutputs = durableRows.outputs.length
    const toolUseOutputs = durableRows.outputs.filter(o => o.kind === "tool_use")
    const amplification = distinctOutputs === 0
      ? 0
      : state.outputHitCount / distinctOutputs

    const resultsByToolUse = new Map(
      durableRows.toolResults.map(r => [r.toolUseId, r.result] as const),
    )

    const noReWalk =
      isStrictlyIncreasingFrom1(state.consumedOutputSequences) &&
      state.consumedOutputSequences.length === distinctOutputs

    const observationBounded =
      state.outputHitCount === distinctOutputs && amplification === 1

    // The crux: every tool executed exactly once across all reloads, and one
    // result per ToolUse output round-tripped back.
    const exactlyOnceTools =
      state.toolExecutionCount === toolUseOutputs.length &&
      state.toolResultCount === toolUseOutputs.length &&
      durableRows.toolResults.length === toolUseOutputs.length &&
      toolUseOutputs.every(o =>
        o.toolUseId !== undefined &&
        resultsByToolUse.get(o.toolUseId) === `executed ${o.toolUseId} -> ok`)

    if (
      distinctOutputs !== 5 ||
      toolUseOutputs.length !== 2 ||
      !toolResultsReady ||
      !observationBounded ||
      !noReWalk ||
      !exactlyOnceTools ||
      !state.turnComplete ||
      state.reloadCount < 3
    ) {
      return yield* Effect.fail(new Error(
        `tool-result-roundtrip prototype failed: ${JSON.stringify({
          distinctOutputs,
          toolUseOutputs: toolUseOutputs.length,
          toolResultsReady,
          outputHitCount: state.outputHitCount,
          outputReadCount: state.outputReadCount,
          reloadCount: state.reloadCount,
          consumedOutputSequences: state.consumedOutputSequences,
          toolExecutionCount: state.toolExecutionCount,
          toolResultCount: state.toolResultCount,
          toolResults: durableRows.toolResults.length,
          turnComplete: state.turnComplete,
          observationBounded,
          noReWalk,
          exactlyOnceTools,
        })}`,
      ))
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_tool_roundtrip.distinct_outputs": distinctOutputs,
      "firegrid.tiny_tool_roundtrip.output_hit_count": state.outputHitCount,
      "firegrid.tiny_tool_roundtrip.output_read_count": state.outputReadCount,
      "firegrid.tiny_tool_roundtrip.reload_count": state.reloadCount,
      "firegrid.tiny_tool_roundtrip.amplification": amplification,
      "firegrid.tiny_tool_roundtrip.tool_execution_count": state.toolExecutionCount,
      "firegrid.tiny_tool_roundtrip.tool_result_count": state.toolResultCount,
      "firegrid.tiny_tool_roundtrip.no_rewalk": noReWalk,
      "firegrid.tiny_tool_roundtrip.exactly_once_tools": exactlyOnceTools,
      "firegrid.tiny_tool_roundtrip.turn_complete": state.turnComplete,
      "firegrid-workflow-driven-runtime.ACID":
        "PHASE_0B_OUTPUT_RESULT_RETURN.2,PHASE_0B_OUTPUT_RESULT_RETURN.5",
    })

    return {
      verdict: "GREEN",
      distinctOutputs,
      outputHitCount: state.outputHitCount,
      outputReadCount: state.outputReadCount,
      reloadCount: state.reloadCount,
      toolExecutionCount: state.toolExecutionCount,
      toolResultCount: state.toolResultCount,
      amplification,
    } satisfies ToolRoundtripVerdict
  }).pipe(
    Effect.withSpan("firegrid.tiny_tool_roundtrip.verdict", {
      kind: "internal",
      attributes: {
        "firegrid.tiny_tool_roundtrip.scope":
          "tool-result-roundtrip-durable-skip-cursor-exactly-once",
      },
    }),
  )
