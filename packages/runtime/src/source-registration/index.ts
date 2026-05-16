import { Layer } from "effect"
import { RuntimeControlPlaneSourceRegistrationsLive } from "./runtime-control-plane.ts"
import { RuntimeIngressSourceRegistrationsLive } from "./runtime-ingress.ts"
import { RuntimeOutputSourceRegistrationsLive } from "./runtime-output.ts"

export {
  RuntimeAuthoritySourceNames as RuntimeObservationSourceNames,
  type RuntimeAuthoritySourceName as RuntimeObservationSourceName,
} from "../authorities/source-names.ts"
export type { RuntimeAgentOutputObservation } from "../agent-event-pipeline/authorities/runtime-output-journal.ts"

// firegrid-runtime-boundary-reconciliation.SOURCE_REGISTRATION.1
// firegrid-runtime-boundary-reconciliation.SOURCE_REGISTRATION.2
// firegrid-runtime-boundary-reconciliation.SOURCE_COLLECTIONS.1
// firegrid-runtime-boundary-reconciliation.SOURCE_COLLECTIONS.2
// firegrid-runtime-boundary-reconciliation.SOURCE_COLLECTIONS.3
// firegrid-runtime-boundary-reconciliation.SOURCE_COLLECTIONS.4
export const RuntimeSourceRegistrationsLive = Layer.mergeAll(
  RuntimeControlPlaneSourceRegistrationsLive,
  RuntimeIngressSourceRegistrationsLive,
  RuntimeOutputSourceRegistrationsLive,
)
