// @firegrid/client — Firegrid app-facing public root.
//
// firegrid-remediation-hardening.PUBLIC_SURFACES.1
// firegrid-remediation-hardening.PUBLIC_SURFACES.2
// firegrid-remediation-hardening.PUBLIC_SURFACES.3
// firegrid-remediation-hardening.PUBLIC_SURFACES.4
// firegrid-remediation-hardening.TEST_GUARDRAILS.1
// firegrid-architecture-boundary.SURFACE_AREA.1
// firegrid-architecture-boundary.SURFACE_AREA.3
// firegrid-operation-messaging.APP_BOUNDARY.1
// firegrid-operation-messaging.APP_BOUNDARY.2

export {
  EventStream,
  EventStreamAppendError,
  EventStreamDecodeError,
  EventStreamEncodeError,
  EventStreamReadError,
  FiregridClient,
  FiregridClientLive,
  Operation,
  OperationCancelled,
  OperationDecodeError,
  OperationEncodeError,
  OperationHandle,
  OperationNotFound,
  type EmitError,
  type EventsError,
  type FiregridClientConfig,
  type FiregridClientService,
  type ObserveError,
  type OperationState,
  type ResultError,
  type SendError,
} from "./firegrid/operation-client.ts"
