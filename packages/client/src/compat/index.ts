// firegrid-remediation-hardening.PUBLIC_SURFACES.2
//
// Legacy compatibility subpath for the pre-Firegrid SubstrateClient surface.
// The app-facing client root exports only Firegrid vocabulary.

export {
  SubstrateClient,
  SubstrateClientLive,
  type SubstrateClientConfig,
  type SubstrateClientService,
} from "../client/service.ts"

export type {
  DeclareWorkInput,
  DeclareWorkResult,
  SubstrateClientWork,
  SubstrateWorkHandle,
  WorkObservation,
} from "../client/work.ts"
