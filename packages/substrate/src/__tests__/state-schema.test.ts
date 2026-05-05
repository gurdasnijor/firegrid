import { Effect, Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ClaimAttemptRowType,
  CompletionRowType,
  ProjectionMatchCompletionData,
  ProjectionMatchTriggerSchema,
  ScheduledWorkCompletionData,
  TimerCompletionData,
  EventStreamRowType,
  RunRowType,
  decodeCompletionData,
  decodeProjectionMatchCompletionData,
  type RunValue,
} from "../schema/rows.ts"
import { substrateState } from "../schema/state.ts"

describe("durable-records-and-projections.SUBSTRATE_SCOPE", () => {
  it("durable-records-and-projections.SUBSTRATE_SCOPE.6 — canonical substrate state schema declares row type and primary key per family", () => {
    expect(substrateState.runs.type).toBe(RunRowType)
    expect(substrateState.runs.primaryKey).toBe("runId")
    expect(substrateState.completions.type).toBe(CompletionRowType)
    expect(substrateState.completions.primaryKey).toBe("completionId")
    expect(substrateState.claimAttempts.type).toBe(ClaimAttemptRowType)
    expect(substrateState.claimAttempts.primaryKey).toBe("claimId")
    expect(substrateState.eventStreams.type).toBe(EventStreamRowType)
    expect(substrateState.eventStreams.primaryKey).toBe("id")
  })

  it("durable-records-and-projections.SUBSTRATE_SCOPE.7 — typed helpers derive change-event key from declared primaryKey", () => {
    const runEvent = substrateState.runs.insert({
      value: { runId: "run-7", state: "started" },
    })
    expect(runEvent.type).toBe(RunRowType)
    expect(runEvent.key).toBe("run-7")
    expect(runEvent.headers).toMatchObject({ operation: "insert" })

    const completionEvent = substrateState.completions.upsert({
      value: { completionId: "c-7", kind: "timer", state: "pending" },
    })
    expect(completionEvent.key).toBe("c-7")

    const claimEvent = substrateState.claimAttempts.insert({
      value: {
        claimId: "claim-7",
        workId: "work-1",
        ownerId: "operator-1",
        observedCursor: "0_0",
        status: "attempted",
      },
    })
    expect(claimEvent.key).toBe("claim-7")
  })
})

describe("effect-native-api.SCHEMA_FIRST", () => {
  it("effect-native-api.SCHEMA_FIRST.4 — typed helpers reject malformed values via the Standard Schema bridge", () => {
    expect(() =>
      substrateState.runs.insert({
        value: { runId: "run-x", state: "not-a-real-state" } as unknown as RunValue,
      }),
    ).toThrow()
  })
})

describe("Q3-SCHEMA-CODEC completion data schemas", () => {
  const trigger = {
    _tag: "ProjectionMatch" as const,
    label: "permission-ready",
    projectionKey: "permission:p-1",
    matcherId: "permission-ready",
  }

  it("durable-waits-and-scheduling.WAIT_FOR.6 + .7 — projection-match completion data decodes trigger and durable deadline fields from the row codec", async () => {
    const decoded = await Effect.runPromise(
      decodeProjectionMatchCompletionData(
        {
          trigger,
          timeoutMs: 250,
          deadlineAtMs: 1_000,
        },
        (cause) => cause,
      ),
    )

    expect(decoded.trigger).toEqual(trigger)
    expect(decoded.timeoutMs).toBe(250)
    expect(decoded.deadlineAtMs).toBe(1_000)
    expect(Either.isRight(Schema.decodeUnknownEither(ProjectionMatchTriggerSchema)(trigger))).toBe(true)
    expect(Either.isLeft(
      Schema.decodeUnknownEither(ProjectionMatchCompletionData)({
        trigger: { ...trigger, matcherId: () => true },
      }),
    )).toBe(true)
  })

  it("durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4 — scheduled-work completion data preserves scheduled time and opaque input through the row codec", async () => {
    const decoded = await Effect.runPromise(
      decodeCompletionData(
        ScheduledWorkCompletionData,
        (cause) => cause,
      )({
        whenMs: 42,
        input: { task: "compact", args: [1, 2] },
      }),
    )

    expect(decoded.whenMs).toBe(42)
    expect(decoded.input).toEqual({ task: "compact", args: [1, 2] })
  })

  it("durable-subscribers.TIMER_SUBSCRIBER.4 — timer completion data requires a durable dueAtMs", () => {
    expect(Either.isRight(
      Schema.decodeUnknownEither(TimerCompletionData)({
        durationMs: 10,
        dueAtMs: 20,
      }),
    )).toBe(true)
    expect(Either.isLeft(
      Schema.decodeUnknownEither(TimerCompletionData)({ durationMs: 10 }),
    )).toBe(true)
  })
})
