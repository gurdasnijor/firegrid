import { describe, expect, it } from "vitest"
import { selfTestScheduledWorkReceiver } from "./scheduled-work-receiver.ts"
import { Effect } from "effect"

describe("F3C scheduled-work receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.8, durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1, durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4, firegrid-runtime-process.READY_WORK_OPERATOR.1 — app-owned run resolves scheduled work after due time and terminalizes ready work", async () => {
    const result = await Effect.runPromise(selfTestScheduledWorkReceiver())

    expect(result.beforeDue.completions).toContainEqual(
      expect.objectContaining({
        kind: "scheduled_work",
        state: "pending",
      }),
    )
    expect(result.beforeDue.runs).toContainEqual(
      expect.objectContaining({
        operation: "ScheduledReminder",
        state: "blocked",
      }),
    )
    expect(result.completed.completions).toContainEqual(
      expect.objectContaining({
        kind: "scheduled_work",
        state: "resolved",
        result: expect.objectContaining({
          input: {
            reminderId: "reminder-cli-1",
            message: "follow up from scheduled work",
          },
        }),
      }),
    )
    expect(result.completed.runs).toContainEqual(
      expect.objectContaining({
        operation: "ScheduledReminder",
        state: "completed",
        result: {
          reminderId: "reminder-cli-1",
          message: "follow up from scheduled work",
          delivered: true,
        },
      }),
    )
  })
})
