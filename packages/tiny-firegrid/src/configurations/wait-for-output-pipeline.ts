import { Response } from "@effect/ai"
import {
  evaluateFieldEquals,
  type RuntimeWaitSource,
  type WaitForOptions,
  type WaitForOutcome,
} from "@firegrid/runtime/durable-tools"
import type {
  AgentOutputEvent,
  RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import { Effect, Option, Stream } from "effect"
import type { DurableTableCollectionFacade } from "effect-durable-operators"
import { makeMemoryDurableCollectionFacade } from "../effect-durable-operators/DurableTable.ts"
import {
  observationFromAgentOutput,
  outputObservationKey,
  persistAgentOutputObservation,
} from "../runtime/agent-event-pipeline/authorities/runtime-output.ts"

type AgentOutputAfterSource = Extract<
  RuntimeWaitSource,
  { readonly _tag: "AgentOutputAfter" }
>

interface PerContextOutputTarget {
  readonly _tag: "PerContextOutput"
  readonly contextId: string
  readonly activityAttempt: number
  readonly afterSequence?: number
}

type TinyRuntimeOutputEvents =
  DurableTableCollectionFacade<RuntimeAgentOutputObservation, string>

const textChunk = (id: string, delta: string): AgentOutputEvent => ({
  _tag: "TextChunk",
  part: Response.textDeltaPart({ id, delta }),
})

const outputTargetForSource = (
  source: RuntimeWaitSource,
  currentContextId: string,
): Effect.Effect<PerContextOutputTarget, string> => {
  switch (source._tag) {
    case "AgentOutput":
      return Effect.succeed({
        _tag: "PerContextOutput",
        contextId: currentContextId,
        activityAttempt: 0,
      })
    case "AgentOutputAfter":
      return Effect.succeed({
        _tag: "PerContextOutput",
        contextId: source.contextId,
        activityAttempt: source.activityAttempt,
        afterSequence: source.afterSequence,
      })
    case "RuntimeRun":
      return Effect.fail("tiny-firegrid wait_for output pipeline only models AgentOutput sources")
  }
}

const matchesTarget = (
  target: PerContextOutputTarget,
  row: RuntimeAgentOutputObservation,
): boolean =>
  row.contextId === target.contextId &&
  row.activityAttempt === target.activityAttempt &&
  (target.afterSequence === undefined || row.sequence > target.afterSequence)

const waitForOutput = (
  input: {
    readonly outputEvents: TinyRuntimeOutputEvents
    readonly currentContextId: string
    readonly options: WaitForOptions<RuntimeAgentOutputObservation>
  },
) =>
  Effect.gen(function*() {
    const target = yield* outputTargetForSource(
      input.options.source,
      input.currentContextId,
    )
    const matched = yield* input.outputEvents.rows().pipe(
      Stream.filter(row => matchesTarget(target, row)),
      Stream.filter(row => evaluateFieldEquals(input.options.trigger, row)),
      Stream.runHead,
    )

    return {
      outcome: Option.match(matched, {
        onNone: (): WaitForOutcome<RuntimeAgentOutputObservation> => ({ _tag: "Timeout" }),
        onSome: (row): WaitForOutcome<RuntimeAgentOutputObservation> => ({
          _tag: "Match",
          row,
        }),
      }),
      target,
    }
  })

export const tinyWaitForOutputPipeline = Effect.gen(function*() {
  const outputEvents = yield* makeMemoryDurableCollectionFacade(outputObservationKey)
  const rows = [
    observationFromAgentOutput({
      contextId: "ctx-a",
      activityAttempt: 0,
      sequence: 0,
      event: textChunk("ctx-a-0", "ignore"),
    }),
    observationFromAgentOutput({
      contextId: "ctx-a",
      activityAttempt: 0,
      sequence: 1,
      event: textChunk("ctx-a-1", "match-after"),
    }),
    observationFromAgentOutput({
      contextId: "ctx-b",
      activityAttempt: 0,
      sequence: 0,
      event: textChunk("ctx-b-0", "other-context"),
    }),
  ]

  yield* Effect.forEach(
    rows,
    row => persistAgentOutputObservation(outputEvents, row),
    { discard: true },
  )

  const agentOutputAfterSource = {
    _tag: "AgentOutputAfter",
    contextId: "ctx-a",
    activityAttempt: 0,
    afterSequence: 0,
  } satisfies AgentOutputAfterSource

  const agentOutputAfter = yield* waitForOutput({
    outputEvents,
    currentContextId: "ctx-b",
    options: {
      name: "agent-output-after",
      source: agentOutputAfterSource,
      trigger: [{ path: ["event", "part", "delta"], equals: "match-after" }],
    },
  })
  const agentOutputInCurrentContext = yield* waitForOutput({
    outputEvents,
    currentContextId: "ctx-a",
    options: {
      name: "agent-output-current-context",
      source: { _tag: "AgentOutput" },
      trigger: [{ path: ["contextId"], equals: "ctx-a" }],
    },
  })

  return {
    agentOutputAfter,
    agentOutputInCurrentContext,
  }
})
