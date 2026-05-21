import {
  Effect,
  Schema,
} from "effect"
import {
  sendWorkflowInput,
  waitForWorkflowOutput,
  WorkflowOutputObservationSchema,
  type WorkflowOutputObservation,
} from "./protocol.ts"
import {
  verboseTextChunkCount,
} from "./resources.ts"
import {
  targetArchitectureReferenceRuntime,
} from "./workflow.ts"

interface TargetArchitectureReferenceVerdict {
  readonly verdict: "GREEN"
  readonly outputCount: number
  readonly observationAttempts: number
  readonly replayCount: number
  readonly textChunkCount: number
  readonly toolResultReturned: boolean
  readonly turnComplete: boolean
}

const sessionId = "phase0b-session"
const observerId = "phase0b-driver-observer"
const toolCallId = "phase0b-sleep-tool-call"

const waitForNextOutput = (
  runtime: Awaited<typeof targetArchitectureReferenceRuntime>,
) =>
  Effect.gen(function*() {
    const unknown = yield* runtime.dispatch(
      waitForWorkflowOutput({ sessionId, observerId }),
    )
    return yield* Schema.decodeUnknown(WorkflowOutputObservationSchema)(unknown)
  })

const countObservedTextChunks = (
  observations: ReadonlyArray<WorkflowOutputObservation>,
) =>
  observations.filter(observation =>
    observation.output.kind === "TextChunk").length

export const targetArchitectureReferenceDriver:
  Effect.Effect<TargetArchitectureReferenceVerdict, unknown> = Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => targetArchitectureReferenceRuntime)

    yield* runtime.dispatch(sendWorkflowInput({
      sessionId,
      inputId: "prompt-1",
      sequence: 1,
      kind: "prompt",
      body: "stream verbosely, call sleep, then return the result",
    }))
    yield* runtime.dispatch(sendWorkflowInput({
      sessionId,
      inputId: "prompt-1",
      sequence: 1,
      kind: "prompt",
      body: "duplicate prompt must converge",
    }))
    yield* runtime.replayBoundary("after-duplicate-prompt")

    const observations: Array<WorkflowOutputObservation> = []
    let sawToolUse = false
    while (!sawToolUse) {
      const observation = yield* waitForNextOutput(runtime)
      observations.push(observation)
      sawToolUse = observation.output.kind === "ToolUse"
    }

    yield* runtime.dispatch(sendWorkflowInput({
      sessionId,
      inputId: "tool-result-1",
      sequence: 2,
      kind: "tool_result",
      body: "sleep completed",
      toolCallId,
    }))
    yield* runtime.dispatch(sendWorkflowInput({
      sessionId,
      inputId: "tool-result-1",
      sequence: 2,
      kind: "tool_result",
      body: "duplicate tool result must converge",
      toolCallId,
    }))
    yield* runtime.replayBoundary("after-duplicate-tool-result")

    let turnComplete = false
    while (!turnComplete) {
      const observation = yield* waitForNextOutput(runtime)
      observations.push(observation)
      turnComplete = observation.output.kind === "TurnComplete"
    }

    yield* runtime.replayBoundary("post-turn-complete")

    const durableRows = yield* runtime.durableRows
    const observer = durableRows.outputObservers[0]
    const cursor = durableRows.workflowCursors[0]
    const outputCount = durableRows.outputs.length
    const observationAttempts = observer?.observationAttempts ?? 0
    const replayCount = cursor?.replayCount ?? 0
    const observedOutputKeys = new Set(observations.map(observation =>
      observation.output.outputKey))
    const textChunkCount = countObservedTextChunks(observations)
    const toolResultReturned = observations.some(observation =>
      observation.output.kind === "ToolResult" &&
      observation.output.body === "sleep completed")
    const amplificationBounded =
      observationAttempts === observedOutputKeys.size &&
      observationAttempts === outputCount

    if (
      outputCount !== verboseTextChunkCount + 4 ||
      observationAttempts !== outputCount ||
      observedOutputKeys.size !== outputCount ||
      textChunkCount !== verboseTextChunkCount + 1 ||
      !toolResultReturned ||
      !turnComplete ||
      replayCount < 3
    ) {
      return yield* Effect.fail(new Error(
        `phase0b output/result-return oracle failed: ${JSON.stringify({
          outputCount,
          observationAttempts,
          observedOutputKeys: observedOutputKeys.size,
          textChunkCount,
          toolResultReturned,
          turnComplete,
          replayCount,
          durableRows,
        })}`,
      ))
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.output.count": outputCount,
      "firegrid.tiny_reference.output.observation_attempts":
        observationAttempts,
      "firegrid.tiny_reference.output.distinct_observed":
        observedOutputKeys.size,
      "firegrid.tiny_reference.output.text_chunks": textChunkCount,
      "firegrid.tiny_reference.workflow.replay_count": replayCount,
      "firegrid.tiny_reference.durable.sessions": durableRows.sessions.length,
      "firegrid.tiny_reference.durable.inputs": durableRows.inputs.length,
      "firegrid.tiny_reference.durable.outputs": durableRows.outputs.length,
      "firegrid.tiny_reference.durable.workflow_cursors":
        durableRows.workflowCursors.length,
      "firegrid.tiny_reference.durable.output_observers":
        durableRows.outputObservers.length,
      "firegrid.tiny_reference.result.tool_result_returned":
        toolResultReturned,
      "firegrid.tiny_reference.result.turn_complete": turnComplete,
      "firegrid.tiny_reference.invariant.observation_attempts_bounded":
        amplificationBounded,
      "firegrid-workflow-driven-runtime.ACID":
        "PHASE_0B_OUTPUT_RESULT_RETURN.4,PHASE_0B_OUTPUT_RESULT_RETURN.5",
    })
    return {
      verdict: "GREEN",
      outputCount,
      observationAttempts,
      replayCount,
      textChunkCount,
      toolResultReturned,
      turnComplete,
    } satisfies TargetArchitectureReferenceVerdict
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.phase0b.verdict", {
      kind: "internal",
      attributes: {
        "firegrid.tiny_reference.verdict": "GREEN",
        "firegrid.tiny_reference.scope":
          "output-result-return-replay-safe-oracle",
      },
    }),
  )
