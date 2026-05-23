import {
  Activity,
  Workflow,
} from "@effect/workflow"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import {
  evaluateFieldEquals,
  FieldEqualsTriggerSchema,
} from "../../transforms/field-equals.ts"
import {
  RuntimeObservationSourceSchema,
  RuntimeObservationStreams,
  type RuntimeObservationSource,
} from "../../streams/index.ts"

// tf-0xe4: one (source, trigger) pair the workflow races. wait_for is one pair;
// wait_for_any is the primary `source`/`trigger` plus `additionalSources`.
const WaitForWorkflowSourceSchema = Schema.Struct({
  source: RuntimeObservationSourceSchema,
  trigger: FieldEqualsTriggerSchema,
})

type WaitForWorkflowSource = Schema.Schema.Type<
  typeof WaitForWorkflowSourceSchema
>

export const WaitForWorkflowPayloadSchema = Schema.Struct({
  executionKey: Schema.String,
  source: RuntimeObservationSourceSchema,
  trigger: FieldEqualsTriggerSchema,
  // tf-0xe4: extra sources for a durable wait_for_any race. The workflow races
  // the primary source plus these inside one journaled Activity, so the race
  // survives host restart instead of being lost with an in-memory raceAll.
  additionalSources: Schema.optional(Schema.Array(WaitForWorkflowSourceSchema)),
  timeoutMs: Schema.optional(Schema.Number),
})

export const WaitForWorkflowMatchOutcomeSchema = Schema.TaggedStruct("Match", {
  raw: Schema.Unknown,
  // tf-0xe4: index of the winning source in [source, ...additionalSources].
  // 0 for single wait_for; the racing position for wait_for_any.
  winnerIndex: Schema.optional(Schema.Number),
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
  sources: ReadonlyArray<WaitForWorkflowSource>,
  timeoutMs: number | undefined,
) =>
  Activity.make({
    name: matchActivityName(executionKey),
    success: WaitForWorkflowOutcomeSchema,
    execute: Effect.gen(function*() {
      const streams = yield* RuntimeObservationStreams
      // tf-0xe4: race all sources inside the Activity. Because each source is a
      // durable, replay-safe RuntimeObservationStream, re-running this Activity
      // on workflow resume re-subscribes and re-finds the winner — so the race
      // survives host restart (the in-memory raceAll did not).
      const matches = sources.map((entry, winnerIndex) =>
        Stream.runHead(
          streamForSource(streams, entry.source).pipe(
            Stream.filter(row => evaluateFieldEquals(entry.trigger, row)),
          ),
        ).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.never,
            // Single-source wait_for omits winnerIndex (outcome unchanged); only
            // a multi-source wait_for_any race reports the winning index.
            onSome: (raw): Effect.Effect<WaitForWorkflowOutcome> =>
              Effect.succeed(
                sources.length > 1
                  ? { _tag: "Match", raw, winnerIndex }
                  : { _tag: "Match", raw },
              ),
          })),
        ))
      const match = Effect.raceAll(matches)

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
          "firegrid.wait.source": sources[0]!.source._tag,
          "firegrid.wait.source_count": sources.length,
          "firegrid.wait.has_timeout": timeoutMs !== undefined,
        },
      }),
    ),
  })

export const WaitForWorkflowLayer = WaitForWorkflow.toLayer(({
  executionKey,
  source,
  trigger,
  additionalSources,
  timeoutMs,
}) => {
  const sources: ReadonlyArray<WaitForWorkflowSource> = [
    { source, trigger },
    ...(additionalSources ?? []),
  ]
  const activity = matchOrTimeoutActivity(executionKey, sources, timeoutMs)

  return activity.pipe(
    Effect.withSpan("firegrid.agent_tools.wait_for.workflow.body", {
      kind: "internal",
      attributes: {
        "firegrid.agent_tools.wait_for.execution_key": executionKey,
        "firegrid.wait.source": source._tag,
        "firegrid.wait.source_count": sources.length,
        "firegrid.wait.has_timeout": timeoutMs !== undefined,
        ...(timeoutMs === undefined ? {} : { "firegrid.wait.timeout_ms": timeoutMs }),
      },
    }),
  )
})
