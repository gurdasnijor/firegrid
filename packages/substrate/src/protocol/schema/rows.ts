import { Effect, Either, Schema, type ParseResult } from "effect"

// durable-records-and-projections.RECORDS.6
// Foundational durable authority row families.
export const RunRowType = "durable.run" as const
export const CompletionRowType = "durable.completion" as const
export const ClaimAttemptRowType = "durable.claim.attempt" as const
export const EventStreamRowType = "firegrid.event" as const
export const EventStreamEnvelopeTag = "firegrid/event@1" as const
export const OperationEnvelopeTag = "firegrid/operation@1" as const
// durable-records-and-projections.RECORDS.8
export const TraceRowType = "durable.trace" as const

export const RunState = Schema.Literal(
  "started",
  "blocked",
  "completed",
  "failed",
  "cancelled",
)
export type RunState = Schema.Schema.Type<typeof RunState>

const DurableTerminalFields = {
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  terminalReason: Schema.optional(Schema.Unknown),
}

// awakeables-and-runs.RUN.1 — value shape only; transition enforcement is Slice 2.
// launchable-substrate-host.CLIENT_SURFACE.11
// launchable-substrate-host.CLIENT_SURFACE.12
// `data` is substrate-generic optional run data carried for the run's
// lifetime. Client work declaration places caller-supplied input here so
// no Fireline / Firepixel / ACP / MCP / session / prompt / provider /
// sandbox / transport row family is introduced. The field is optional
// for backwards compatibility with runs that have no caller input.
export const RunValue = Schema.Struct({
  runId: Schema.String,
  state: RunState,
  blockedOnCompletionId: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  ...DurableTerminalFields,
})
export type RunValue = Schema.Schema.Type<typeof RunValue>

// durable-records-and-projections.RECORDS.7
// Completion variants are kinds of the same family, not separate families.
// `scheduled_work` is the substrate-generic scheduled completion kind
// (durable-waits-and-scheduling.SCHEDULE_WORK.1/.2). Higher runtimes
// such as Fireline may map an agent-facing `scheduleMe` onto it.
export const CompletionKind = Schema.Literal(
  "timer",
  "projection_match",
  "child_run",
  "fan_in",
  "externally_resolved_awakeable",
  "scheduled_work",
)
export type CompletionKind = Schema.Schema.Type<typeof CompletionKind>

export const CompletionState = Schema.Literal(
  "pending",
  "resolved",
  "rejected",
  "cancelled",
)
export type CompletionState = Schema.Schema.Type<typeof CompletionState>

// choreography-facade.TRIGGERS.2
// choreography-facade.TRIGGERS.3
// choreography-facade.TRIGGERS.4
export const ProjectionMatchTriggerSchema = Schema.TaggedStruct("ProjectionMatch", {
  label: Schema.String,
  projectionKey: Schema.String,
  matcherId: Schema.String,
})
export type ProjectionMatchTriggerValue = Schema.Schema.Type<
  typeof ProjectionMatchTriggerSchema
>

// durable-subscribers.TIMER_SUBSCRIBER.4
// durable-waits-and-scheduling.WAIT_FOR.6
// durable-waits-and-scheduling.WAIT_FOR.7
// durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4
// Per-kind durable completion data codecs keep resolver data explicit at the
// row-family boundary while preserving `CompletionValue.data` as Unknown for
// durable wire compatibility.
export const TimerCompletionData = Schema.Struct({
  durationMs: Schema.optional(Schema.Number),
  dueAtMs: Schema.Number,
})
export type TimerCompletionData = Schema.Schema.Type<
  typeof TimerCompletionData
>

export const ScheduledWorkCompletionData = Schema.Struct({
  whenMs: Schema.Number,
  input: Schema.optional(Schema.Unknown),
})
export type ScheduledWorkCompletionData = Schema.Schema.Type<
  typeof ScheduledWorkCompletionData
>

export const ProjectionMatchCompletionData = Schema.Struct({
  trigger: ProjectionMatchTriggerSchema,
  timeoutMs: Schema.optional(Schema.Number),
  deadlineAtMs: Schema.optional(Schema.Number),
})
export type ProjectionMatchCompletionData = Schema.Schema.Type<
  typeof ProjectionMatchCompletionData
>

const LegacyProjectionMatchCompletionData = Schema.Struct({
  trigger: Schema.Struct({
    kind: Schema.Literal("projection_match"),
    description: ProjectionMatchTriggerSchema,
  }),
  timeoutMs: Schema.optional(Schema.Number),
  deadlineAtMs: Schema.optional(Schema.Number),
})

export const decodeCompletionData =
  <S extends Schema.Schema.AnyNoContext, E>(
    schema: S,
    mapError: (cause: ParseResult.ParseError) => E,
  ) => {
    const decode = Schema.decodeUnknown(schema)
    return (value: unknown): Effect.Effect<Schema.Schema.Type<S>, E> =>
      Effect.mapError(
        decode(value),
        mapError,
      ) as Effect.Effect<Schema.Schema.Type<S>, E>
  }

export const decodeProjectionMatchCompletionData = <E>(
  value: unknown,
  mapError: (cause: ParseResult.ParseError) => E,
): Effect.Effect<ProjectionMatchCompletionData, E> => {
  const decoded = Schema.decodeUnknownEither(ProjectionMatchCompletionData)(
    value,
  )
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right)
  return Schema.decodeUnknown(LegacyProjectionMatchCompletionData)(value).pipe(
    Effect.map((legacy) => ({
      trigger: legacy.trigger.description,
      ...(legacy.timeoutMs !== undefined ? { timeoutMs: legacy.timeoutMs } : {}),
      ...(legacy.deadlineAtMs !== undefined
        ? { deadlineAtMs: legacy.deadlineAtMs }
        : {}),
    })),
    Effect.mapError(mapError),
  )
}

// firegrid-operation-messaging.OPERATIONS.4
// firegrid-operation-messaging.RUNTIME_HANDLERS.1
export const OperationEnvelopeSchema = Schema.Struct({
  _envelope: Schema.Literal(OperationEnvelopeTag),
  operation: Schema.String,
  payload: Schema.Unknown,
})
export type OperationEnvelopeValue = Schema.Schema.Type<
  typeof OperationEnvelopeSchema
>

// awakeables-and-runs.AWAKEABLE.1 — value shape only; transitions are Slice 2.
// durable-records-and-projections.RECORDS.9 — pending completions may carry
// optional `data` needed by their resolver or higher-level runtime
// (e.g. timer durationMs/dueAtMs, projection-match trigger payload,
// scheduled-work whenMs/input).
export const CompletionValue = Schema.Struct({
  completionId: Schema.String,
  workId: Schema.optional(Schema.String),
  kind: CompletionKind,
  state: CompletionState,
  data: Schema.optional(Schema.Unknown),
  ...DurableTerminalFields,
})
export type CompletionValue = Schema.Schema.Type<typeof CompletionValue>

// claim-and-operator-authority.CLAIM_ATTEMPT.2 — claimId, workId, ownerId, observedCursor, status.
// claim-and-operator-authority.CLAIM_ATTEMPT.3 — status is `attempted` in the first profile.
export const ClaimAttemptStatus = Schema.Literal("attempted")
export type ClaimAttemptStatus = Schema.Schema.Type<typeof ClaimAttemptStatus>

export const ClaimAttemptValue = Schema.Struct({
  claimId: Schema.String,
  workId: Schema.String,
  ownerId: Schema.String,
  observedCursor: Schema.String,
  status: ClaimAttemptStatus,
})
export type ClaimAttemptValue = Schema.Schema.Type<typeof ClaimAttemptValue>

// firegrid-event-streams.SCHEMA_OWNERSHIP.2
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
//
// State Protocol row value for Firegrid EventStream records. The
// caller-owned event payload remains `Unknown`; this schema owns only
// the shared envelope needed for Durable Streams State compatibility.
export const EventStreamValue = Schema.Struct({
  _envelope: Schema.Literal(EventStreamEnvelopeTag),
  stream: Schema.String,
  event: Schema.Unknown,
})
export type EventStreamValue = Schema.Schema.Type<typeof EventStreamValue>

// durable-records-and-projections.RECORDS.8 — observability only.
export const TraceValue = Schema.Struct({
  traceId: Schema.String,
  kind: Schema.String,
  data: Schema.optional(Schema.Unknown),
})
export type TraceValue = Schema.Schema.Type<typeof TraceValue>
