import { Schema } from "effect"

// durable-records-and-projections.RECORDS.6
// Foundational durable authority row families.
export const RunRowType = "durable.run" as const
export const CompletionRowType = "durable.completion" as const
export const ClaimAttemptRowType = "durable.claim.attempt" as const
export const EventStreamRowType = "firegrid.event" as const
export const EventStreamEnvelopeTag = "firegrid/event@1" as const
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
