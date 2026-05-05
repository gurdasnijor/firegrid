import { describe, expect, it } from "vitest"
import {
  ClaimAttemptRowType,
  CompletionRowType,
  EventStreamRowType,
  RunRowType,
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
