import {
  EventStream,
  Operation,
  ProjectionMatchTrigger,
} from "@firegrid/substrate"
import { Schema } from "effect"
import { defineEmitScenario } from "../definition.ts"
import {
  defineScenarioRows,
  makeEventStreamScenarioRow,
  makeOperationStartedRunRow,
  scenarioRowsFromIterable,
} from "../scenario.ts"

export const FirelineDecisionEvents = EventStream.define({
  name: "FirelineDecisionEvents",
  event: Schema.Struct({
    requestId: Schema.String,
    status: Schema.Literal("approved", "rejected"),
    reason: Schema.String,
    reviewer: Schema.String,
  }),
})

export const FirelineRejectionResult = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Literal("rejected"),
  reason: Schema.String,
  reviewer: Schema.String,
})

export const FirelineRejectionOperation = Operation.define({
  name: "FirelineShapedRejection",
  input: Schema.Struct({
    requestId: Schema.String,
    prompt: Schema.String,
    trigger: ProjectionMatchTrigger,
  }),
  output: Schema.Struct({
    requestId: Schema.String,
    approved: Schema.Boolean,
  }),
  error: Schema.Struct({
    _tag: Schema.Literal("FirelineRequestRejected"),
    requestId: Schema.String,
    reason: Schema.String,
    reviewer: Schema.String,
  }),
})

const DEFAULT_FIRELINE_REJECTION_RUN_ID =
  "run-fireline-rejection-cli-1"
const DEFAULT_FIRELINE_REJECTION_EVENT_ID =
  "event-fireline-rejected-cli-1"
const DEFAULT_FIRELINE_REJECTION_REQUEST_ID =
  "request-fireline-rejection-cli-1"
const DEFAULT_FIRELINE_REJECTION_REASON = "scenario rejection"
const DEFAULT_FIRELINE_REJECTION_REVIEWER = "scenario-reviewer"

const firelineRejectionTrigger = (requestId: string) =>
  Schema.encodeSync(ProjectionMatchTrigger)({
    _tag: "ProjectionMatch",
    label: `fireline-rejection:${requestId}`,
    projectionKey: `${FirelineDecisionEvents.name}:decision:${requestId}`,
    matcherId: "scenario.fireline.rejected",
  })

export const makeFirelineRejectionScenarioRows = (input: {
  readonly runId?: string
  readonly eventId?: string
  readonly requestId?: string
  readonly prompt?: string
  readonly reason?: string
  readonly reviewer?: string
} = {}) => {
  const runId = input.runId ?? DEFAULT_FIRELINE_REJECTION_RUN_ID
  const eventId = input.eventId ?? DEFAULT_FIRELINE_REJECTION_EVENT_ID
  const requestId = input.requestId ?? DEFAULT_FIRELINE_REJECTION_REQUEST_ID
  const prompt = input.prompt ?? "reject the product request"
  const reason = input.reason ?? DEFAULT_FIRELINE_REJECTION_REASON
  const reviewer = input.reviewer ?? DEFAULT_FIRELINE_REJECTION_REVIEWER

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.10
  // firegrid-runtime-process.SCENARIOS.14
  // client-event-plane-registration.BOUNDARY.5
  return [
    makeOperationStartedRunRow({
      runId,
      operation: FirelineRejectionOperation,
      input: {
        requestId,
        prompt,
        trigger: firelineRejectionTrigger(requestId),
      },
    }),
    makeEventStreamScenarioRow({
      stream: FirelineDecisionEvents,
      eventId,
      event: {
        requestId,
        status: "rejected",
        reason,
        reviewer,
      },
    }),
  ] as const
}

const firelineRejectionRows = defineScenarioRows({
  name: "fireline-rejection",
  rows: () => scenarioRowsFromIterable(makeFirelineRejectionScenarioRows()),
})

export const firelineRejectionScenario = defineEmitScenario({
  kind: "emit",
  name: "fireline-rejection",
  rows: firelineRejectionRows,
})
