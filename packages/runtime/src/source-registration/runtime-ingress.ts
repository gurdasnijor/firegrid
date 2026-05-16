import { Effect, Layer } from "effect"
import { RuntimeIngressInputStream } from "../agent-event-pipeline/authorities/runtime-ingress-appender.ts"
import { RuntimeIngressDeliveries } from "../agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts"
import { RuntimeAuthoritySourceNames } from "../authorities/source-names.ts"
import {
  SourceCollections,
  sourceCollectionStreamHandle,
} from "../waits/source-registration.ts"

export const RuntimeIngressSourceRegistrationsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registrations = yield* SourceCollections
    const runtimeIngressInputs = yield* RuntimeIngressInputStream
    const runtimeIngressDeliveries = yield* RuntimeIngressDeliveries

    yield* registrations.register(sourceCollectionStreamHandle(
      RuntimeAuthoritySourceNames.runtimeIngressInputs,
      runtimeIngressInputs,
    ))
    yield* registrations.register(sourceCollectionStreamHandle(
      RuntimeAuthoritySourceNames.runtimeIngressDeliveries,
      runtimeIngressDeliveries,
    ))
  }),
)
