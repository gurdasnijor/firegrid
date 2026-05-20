import {
  Activity,
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

export const WaitForWorkflowMatchOutcomeSchema = Schema.TaggedStruct("Match", {
  raw: Schema.Unknown,
})

export const WaitForWorkflowTimeoutOutcomeSchema = Schema.TaggedStruct("Timeout", {})

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

const matchOrTimeoutActivity = (
  executionKey: string,
  source: RuntimeObservationSource,
  trigger: FieldEqualsTrigger,
  timeoutMs: number | undefined,
) =>
  Activity.make({
    name: matchActivityName(executionKey),
    success: WaitForWorkflowOutcomeSchema,
    execute: Effect.gen(function*() {
      const streams = yield* RuntimeObservationStreams
      const match = Stream.runHead(
        streamForSource(streams, source).pipe(
          Stream.filter(row => evaluateFieldEquals(trigger, row)),
        ),
      ).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.never,
          onSome: (raw): Effect.Effect<WaitForWorkflowOutcome> =>
            Effect.succeed({ _tag: "Match", raw }),
        })),
      )

      if (timeoutMs === undefined) return yield* match

      return yield* Effect.race(
        match,
        Effect.sleep(Duration.millis(timeoutMs)).pipe(
          Effect.as<WaitForWorkflowOutcome>({ _tag: "Timeout" }),
        ),
      )
    }).pipe(
      Effect.orDie,
      Effect.withSpan("firegrid.agent_tools.wait_for.workflow.match_activity", {
        kind: "internal",
        attributes: {
          "firegrid.agent_tools.wait_for.execution_key": executionKey,
          "firegrid.wait.source": source._tag,
          "firegrid.wait.has_timeout": timeoutMs !== undefined,
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
  const activity = matchOrTimeoutActivity(
    executionKey,
    source,
    trigger,
    timeoutMs,
  )

  return activity.pipe(
    Effect.withSpan("firegrid.agent_tools.wait_for.workflow.body", {
      kind: "internal",
      attributes: {
        "firegrid.agent_tools.wait_for.execution_key": executionKey,
        "firegrid.wait.source": source._tag,
        "firegrid.wait.has_timeout": timeoutMs !== undefined,
        ...(timeoutMs === undefined ? {} : { "firegrid.wait.timeout_ms": timeoutMs }),
      },
    }),
  )
})
