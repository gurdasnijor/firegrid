#!/usr/bin/env tsx
import {
  EventStream,
  makeEventStreamStateRow,
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  OPERATION_ENVELOPE_TAG,
  OperationEnvelopeSchema,
  ProjectionMatchTriggerSchema,
  RunValue,
  startRun,
} from "@firegrid/substrate/kernel"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "node:url"

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

export const DEFAULT_WAIT_FOR_RUN_ID = "run-wait-for-cli-1"
export const DEFAULT_WAIT_FOR_EVENT_ID = "event-permission-approved-cli-1"
export const DEFAULT_PERMISSION_ID = "permission-cli-1"

export const permissionApprovedTrigger = (permissionId: string) =>
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
  const encodedInput = Schema.encodeSync(WaitForPermissionOperation.input)({
    permissionId,
    trigger,
  })
  const operationEnvelope = Schema.encodeSync(OperationEnvelopeSchema)({
    _envelope: OPERATION_ENVELOPE_TAG,
    operation: WaitForPermissionOperation.name,
    payload: encodedInput,
  })
  const runValue = Schema.encodeSync(RunValue)({
    runId,
    state: "started",
    data: operationEnvelope,
  })
  const encodedEvent = Schema.encodeSync(PermissionEvents.event)({
    permissionId,
    status: "approved",
    actor: "scenario",
  })

  return [
    Effect.runSync(startRun({
      runId: runValue.runId,
      data: runValue.data,
    })),
    makeEventStreamStateRow({
      stream: PermissionEvents.name,
      eventId,
      event: encodedEvent,
    }),
  ] as const
}

export const writeWaitForScenarioRows = (
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk)
  },
) => {
  for (const row of makeWaitForScenarioRows()) {
    write(`${JSON.stringify(row)}\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeWaitForScenarioRows()
}
