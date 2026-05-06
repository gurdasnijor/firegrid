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

export const FirelineApprovalEvents = EventStream.define({
  name: "FirelineApprovalEvents",
  event: Schema.Struct({
    requestId: Schema.String,
    status: Schema.Literal("approved", "rejected"),
    reviewer: Schema.String,
  }),
})

export const FirelineShapedOperation = Operation.define({
  name: "FirelineShapedHappyPath",
  input: Schema.Struct({
    requestId: Schema.String,
    prompt: Schema.String,
    trigger: ProjectionMatchTrigger,
  }),
  output: Schema.Struct({
    requestId: Schema.String,
    approved: Schema.Boolean,
  }),
})

const DEFAULT_FIRELINE_SHAPED_RUN_ID =
  "run-fireline-shaped-happy-path-cli-1"
const DEFAULT_FIRELINE_SHAPED_EVENT_ID =
  "event-fireline-shaped-approved-cli-1"
const DEFAULT_FIRELINE_SHAPED_REQUEST_ID =
  "request-fireline-shaped-cli-1"

const firelineApprovalTrigger = (requestId: string) =>
  Schema.encodeSync(ProjectionMatchTrigger)({
    _tag: "ProjectionMatch",
    label: `fireline-approval:${requestId}`,
    projectionKey: `${FirelineApprovalEvents.name}:approval:${requestId}`,
    matcherId: "scenario.fireline.approved",
  })

export const makeFirelineShapedScenarioRows = (input: {
  readonly runId?: string
  readonly eventId?: string
  readonly requestId?: string
  readonly prompt?: string
  readonly reviewer?: string
} = {}) => {
  const runId = input.runId ?? DEFAULT_FIRELINE_SHAPED_RUN_ID
  const eventId = input.eventId ?? DEFAULT_FIRELINE_SHAPED_EVENT_ID
  const requestId = input.requestId ?? DEFAULT_FIRELINE_SHAPED_REQUEST_ID
  const prompt = input.prompt ?? "approve the happy path"
  const reviewer = input.reviewer ?? "scenario-reviewer"

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.10
  // firegrid-runtime-process.SCENARIOS.13
  // client-event-plane-registration.BOUNDARY.5
  return [
    makeOperationStartedRunRow({
      runId,
      operation: FirelineShapedOperation,
      input: {
        requestId,
        prompt,
        trigger: firelineApprovalTrigger(requestId),
      },
    }),
    makeEventStreamScenarioRow({
      stream: FirelineApprovalEvents,
      eventId,
      event: {
        requestId,
        status: "approved",
        reviewer,
      },
    }),
  ] as const
}

const firelineShapedRows = defineScenarioRows({
  name: "fireline-shaped",
  rows: () => scenarioRowsFromIterable(makeFirelineShapedScenarioRows()),
})

export const firelineShapedScenario = defineEmitScenario({
  kind: "emit",
  name: "fireline-shaped",
  rows: firelineShapedRows,
})
