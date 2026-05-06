import { defineEmitScenario } from "../definition.ts"
import {
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  ScheduledWorkCompletionData,
} from "@firegrid/substrate/kernel"
import { Schema } from "effect"
import {
  defineScenarioRows,
  makePendingCompletionScenarioRow,
  scenarioRowsFromIterable,
} from "../scenario.ts"

const ScheduledReminderInput = Schema.Struct({
  reminderId: Schema.String,
  message: Schema.String,
})

export const ScheduledReminderOperation = Operation.define({
  name: "ScheduledReminder",
  input: ScheduledReminderInput,
  output: Schema.Struct({
    reminderId: Schema.String,
    message: Schema.String,
    delivered: Schema.Boolean,
  }),
})

const DEFAULT_COMPLETION_ID = "completion-scheduled-work-cli-1"
const DEFAULT_WORK_ID = "run-scheduled-work-cli-1"
const DEFAULT_REMINDER_ID = "reminder-cli-1"
const DEFAULT_MESSAGE = "follow up from scheduled work"
const DEFAULT_WHEN_MS = 1_893_456_000_000

export const makeScheduledWorkScenarioRows = (input: {
  readonly completionId?: string
  readonly workId?: string
  readonly reminderId?: string
  readonly message?: string
  readonly whenMs?: number
} = {}) => {
  const completionId = input.completionId ?? DEFAULT_COMPLETION_ID
  const workId = input.workId ?? DEFAULT_WORK_ID
  const reminderId = input.reminderId ?? DEFAULT_REMINDER_ID
  const message = input.message ?? DEFAULT_MESSAGE
  const whenMs = input.whenMs ?? DEFAULT_WHEN_MS

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.4
  // durable-waits-and-scheduling.SCHEDULE_WORK.1
  // durable-waits-and-scheduling.SCHEDULE_WORK.6
  // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1
  // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4
  // launchable-substrate-host.SCENARIOS.2
  const scheduledInput = Schema.encodeSync(ScheduledReminderInput)({
    reminderId,
    message,
  })
  const data = Schema.encodeSync(ScheduledWorkCompletionData)({
    whenMs,
    input: scheduledInput,
  })

  return [
    makePendingCompletionScenarioRow({
      completionId,
      workId,
      kind: "scheduled_work",
      data,
    }),
  ] as const
}

const scheduledWorkScenarioRows = defineScenarioRows({
  name: "scheduled-work",
  rows: () => scenarioRowsFromIterable(makeScheduledWorkScenarioRows()),
})

export const scheduledWorkScenario = defineEmitScenario({
  kind: "emit",
  name: "scheduled-work",
  rows: scheduledWorkScenarioRows,
})
