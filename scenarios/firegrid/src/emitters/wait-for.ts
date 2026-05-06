import { defineEmitScenario } from "../definition.ts"
import {
  EventStream,
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  ProjectionMatchTriggerSchema,
} from "@firegrid/substrate/kernel"
import { Schema } from "effect"
import {
  defineScenarioRows,
  makeEventStreamScenarioRow,
  makeOperationStartedRunRow,
  scenarioRowsFromIterable,
} from "../scenario.ts"

export const PermissionEvents = EventStream.define({
  name: "PermissionEvents",
  event: Schema.Struct({
    permissionId: Schema.String,
    status: Schema.Literal("requested", "approved", "denied"),
    actor: Schema.String,
  }),
})

export const WaitForPermissionOperation = Operation.define({
  name: "WaitForPermission",
  input: Schema.Struct({
    permissionId: Schema.String,
    trigger: ProjectionMatchTriggerSchema,
  }),
  output: Schema.Struct({
    permissionId: Schema.String,
    status: Schema.Literal("approved"),
  }),
})

const DEFAULT_WAIT_FOR_RUN_ID = "run-wait-for-cli-1"
const DEFAULT_WAIT_FOR_EVENT_ID = "event-permission-approved-cli-1"
const DEFAULT_PERMISSION_ID = "permission-cli-1"

const permissionApprovedTrigger = (permissionId: string) =>
  Schema.encodeSync(ProjectionMatchTriggerSchema)({
    _tag: "ProjectionMatch",
    label: `permission-approved:${permissionId}`,
    projectionKey: `${PermissionEvents.name}:permission:${permissionId}`,
    matcherId: "scenario.permission.approved",
  })

export const makeWaitForScenarioRows = (input: {
  readonly runId?: string
  readonly eventId?: string
  readonly permissionId?: string
} = {}) => {
  const runId = input.runId ?? DEFAULT_WAIT_FOR_RUN_ID
  const eventId = input.eventId ?? DEFAULT_WAIT_FOR_EVENT_ID
  const permissionId = input.permissionId ?? DEFAULT_PERMISSION_ID
  const trigger = permissionApprovedTrigger(permissionId)

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.3
  // firegrid-operation-messaging.OPERATIONS.1
  // firegrid-operation-messaging.OPERATIONS.2
  // firegrid-operation-messaging.OPERATIONS.4
  // firegrid-event-streams.EVENT_STREAM_DEFINITION.2
  // firegrid-event-streams.EVENT_STREAM_DEFINITION.3
  // firegrid-event-streams.CLIENT_API.5
  // firegrid-event-streams.SCHEMA_OWNERSHIP.3
  return [
    makeOperationStartedRunRow({
      runId,
      operation: WaitForPermissionOperation,
      input: {
        permissionId,
        trigger,
      },
    }),
    makeEventStreamScenarioRow({
      stream: PermissionEvents,
      eventId,
      event: {
        permissionId,
        status: "approved",
        actor: "scenario",
      },
    }),
  ] as const
}

const waitForScenarioRows = defineScenarioRows({
  name: "wait-for",
  rows: () => scenarioRowsFromIterable(makeWaitForScenarioRows()),
})

export const waitForScenario = defineEmitScenario({
  kind: "emit",
  name: "wait-for",
  rows: waitForScenarioRows,
})
