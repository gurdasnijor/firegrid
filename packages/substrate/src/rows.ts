import { Schema } from "effect"

// durable-records-and-projections.RECORDS.6
// Foundational durable authority row families.
export const RunRowType = "durable.run" as const
export const CompletionRowType = "durable.completion" as const
export const ClaimAttemptRowType = "durable.claim.attempt" as const
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

// awakeables-and-runs.RUN.1 — value shape only; transition enforcement is Slice 2.
export const RunValue = Schema.Struct({
  runId: Schema.String,
  state: RunState,
  blockedOnCompletionId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  terminalReason: Schema.optional(Schema.Unknown),
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
export const CompletionValue = Schema.Struct({
  completionId: Schema.String,
  workId: Schema.optional(Schema.String),
  kind: CompletionKind,
  state: CompletionState,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  terminalReason: Schema.optional(Schema.Unknown),
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

// durable-records-and-projections.RECORDS.8 — observability only.
export const TraceValue = Schema.Struct({
  traceId: Schema.String,
  kind: Schema.String,
  data: Schema.optional(Schema.Unknown),
})
export type TraceValue = Schema.Schema.Type<typeof TraceValue>
