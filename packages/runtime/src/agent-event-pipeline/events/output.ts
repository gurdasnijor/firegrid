// firegrid-schema-projection-contract.SCHEMA_CATALOG.6
// firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.1
//
// Compatibility shim: normalized agent-output envelopes and public
// observation projections are protocol-owned. Keep the runtime import path
// stable while downstream callers migrate to `@firegrid/protocol/session-facade`.
// TODO(tf-wzrr): remove this shim after binding callers import protocol directly.
export {
  RuntimeAgentOutputEnvelopeSchema,
  RuntimeAgentOutputObservationSchema,
  decodeRuntimeAgentOutputEnvelope,
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
  type RuntimeAgentOutputEnvelope,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
