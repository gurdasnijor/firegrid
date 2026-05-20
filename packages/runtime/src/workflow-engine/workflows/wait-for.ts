import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
} from "@effect/workflow"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import {
  evaluateFieldEquals,
  FieldEqualsTriggerSchema,
  type FieldEqualsTrigger,
} from "../../durable-tools/internal/types.ts"
import {
  RuntimeObservationSourceSchema,
  RuntimeObservationStreams,
  type RuntimeObservationSource,
} from "../../streams/index.ts"

export const WaitForWorkflowPayloadSchema = Schema.Struct({
  executionKey: Schema.String,
  source: RuntimeObservationSourceSchema,
  trigger: FieldEqualsTriggerSchema,
  timeoutMs: Schema.optional(Schema.Number),
})

export const WaitForWorkflowMatchOutcomeSchema = Schema.Struct({
  _tag: Schema.Literal("Match"),
  raw: Schema.Unknown,
})

export const WaitForWorkflowTimeoutOutcomeSchema = Schema.Struct({
  _tag: Schema.Literal("Timeout"),
})

export const WaitForWorkflowOutcomeSchema = Schema.Union(
  WaitForWorkflowMatchOutcomeSchema,
  WaitForWorkflowTimeoutOutcomeSchema,
)

export type WaitForWorkflowPayload = Schema.Schema.Type<
  typeof WaitForWorkflowPayloadSchema
>

export type WaitForWorkflowOutcome = Schema.Schema.Type<
  typeof WaitForWorkflowOutcomeSchema
>

export const waitForWorkflowExecutionId = (executionKey: string): string =>
  `wait-for:${executionKey}`

export const WaitForWorkflow = Workflow.make({
  name: "firegrid.agent_tools.wait_for",
  payload: WaitForWorkflowPayloadSchema,
  success: WaitForWorkflowOutcomeSchema,
  error: Schema.Never,
  idempotencyKey: ({ executionKey }) => waitForWorkflowExecutionId(executionKey),
})

const streamForSource = (
  service: RuntimeObservationStreams["Type"],
  source: RuntimeObservationSource,
): Stream.Stream<unknown, unknown> => {
  switch (source._tag) {
    case "AgentOutput":
      return service.agentOutput
    case "AgentOutputAfter":
      return service.agentOutputAfter(source)
    case "RuntimeRun":
      return service.runtimeRun
    case "CallerFact":
      return service.callerFact(source.stream)
  }
}

const matchActivityName = (executionKey: string): string =>
  `wait-for-workflow.match/${executionKey}`

const raceDeferredName = (executionKey: string): string =>
  `wait-for-workflow.race/${executionKey}`

const timeoutClockName = (executionKey: string): string =>
  `wait-for-workflow.timeout/${executionKey}`

const matchActivity = (
  executionKey: string,
  source: RuntimeObservationSource,
  trigger: FieldEqualsTrigger,
) =>
  Activity.make({
    name: matchActivityName(executionKey),
    success: Schema.Unknown,
    execute: Effect.gen(function*() {
      const streams = yield* RuntimeObservationStreams
      const first = yield* Stream.runHead(
        streamForSource(streams, source).pipe(
          Stream.filter(row => evaluateFieldEquals(trigger, row)),
        ),
      )
      if (Option.isNone(first)) return yield* Effect.never
      return first.value
    }).pipe(
      Effect.orDie,
      Effect.withSpan("firegrid.agent_tools.wait_for.workflow.match_activity", {
        kind: "internal",
        attributes: {
          "firegrid.agent_tools.wait_for.execution_key": executionKey,
          "firegrid.wait.source": source._tag,
        },
      }),
    ),
  })

export const WaitForWorkflowLayer = WaitForWorkflow.toLayer(({
  executionKey,
  source,
  trigger,
  timeoutMs,
}) => {
  const match = matchActivity(executionKey, source, trigger).pipe(
    Effect.map((raw): WaitForWorkflowOutcome => ({ _tag: "Match", raw })),
  )

  if (timeoutMs === undefined) {
    return match.pipe(
      Effect.withSpan("firegrid.agent_tools.wait_for.workflow.body", {
        kind: "internal",
        attributes: {
          "firegrid.agent_tools.wait_for.execution_key": executionKey,
          "firegrid.wait.source": source._tag,
          "firegrid.wait.has_timeout": false,
        },
      }),
    )
  }

  return DurableDeferred.raceAll({
    name: raceDeferredName(executionKey),
    success: WaitForWorkflowOutcomeSchema,
    error: Schema.Never,
    effects: [
      match,
      DurableClock.sleep({
        name: timeoutClockName(executionKey),
        duration: Duration.millis(timeoutMs),
        inMemoryThreshold: Duration.zero,
      }).pipe(
        Effect.as<WaitForWorkflowOutcome>({ _tag: "Timeout" }),
      ),
    ],
  }).pipe(
    Effect.withSpan("firegrid.agent_tools.wait_for.workflow.body", {
      kind: "internal",
      attributes: {
        "firegrid.agent_tools.wait_for.execution_key": executionKey,
        "firegrid.wait.source": source._tag,
        "firegrid.wait.has_timeout": true,
        "firegrid.wait.timeout_ms": timeoutMs,
      },
    }),
  )
})
