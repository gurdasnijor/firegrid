// @durable-agent-substrate/client — public root surface.
//
// launchable-substrate-host.CLIENT_SURFACE.1
// launchable-substrate-host.CLIENT_SURFACE.2
// launchable-substrate-host.CLIENT_SURFACE.7
// launchable-substrate-host.PACKAGING.3
// launchable-substrate-host.PACKAGING.7
//
// Effect-native client tag, live layer factory, work intent surface,
// and curated read handle types. Operator/testing/diagnostic escape
// hatches will live under explicit subpaths in later slices
// (CLIENT_SURFACE.8); the v1 root surface is intentionally narrow.
export {
  SubstrateClient,
  SubstrateClientLive,
  type SubstrateClientConfig,
  type SubstrateClientService,
} from "./client/service.ts"

export type {
  DeclareWorkInput,
  DeclareWorkResult,
  SubstrateClientWork,
  SubstrateWorkHandle,
  WorkObservation,
} from "./client/work.ts"

// firegrid-operation-messaging.* — typed operation messaging surface.
// firegrid-event-streams.EVENT_STREAM_DEFINITION.* — descriptor surface.
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
// Re-export shared-kernel descriptor envelope so client consumers
// can import the wire constant without reaching into substrate.
export {
  EVENT_STREAM_ENVELOPE_TAG,
  isEventStreamEnvelope,
  isOperationEnvelope,
  OPERATION_ENVELOPE_TAG,
  type EventStreamEnvelope,
  type OperationEnvelope,
} from "@durable-agent-substrate/substrate"
