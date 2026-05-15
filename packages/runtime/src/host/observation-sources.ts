/**
 * Runtime-host SourceCollection registrations for agent `wait_for`.
 *
 * The handles below are read/observation views over committed DurableTable
 * rows. They do not introduce a permission table or a callback marker;
 * `wait_for` observes the same runtime/session evidence the host already
 * writes.
 *
 * Implements:
 *  - firegrid-durable-tools.SOURCE_COLLECTIONS.1
 *  - firegrid-factory-aligned-agent-tools.WAIT_FOR.4
 *  - firegrid-factory-aligned-agent-tools.WAIT_FOR.5
 *  - firegrid-factory-aligned-agent-tools.OBSERVATION.3
 */

import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
} from "@firegrid/protocol/launch"
import { RuntimeIngressTable } from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer } from "effect"
import { SourceCollections } from "../waits/index.ts"
import {
  RuntimeAuthoritySourceNames as RuntimeObservationSourceNames,
  type RuntimeAuthoritySourceName as RuntimeObservationSourceName,
} from "../authorities/source-names.ts"
import {
  RuntimeControlPlaneRecorder,
  RuntimeIngressAppender,
  RuntimeIngressDeliveryTracker,
  RuntimeOutputJournal,
  type RuntimeAgentOutputObservation,
} from "../authorities/index.ts"

export {
  RuntimeObservationSourceNames,
  type RuntimeAgentOutputObservation,
  type RuntimeObservationSourceName,
}

export const RuntimeObservationSourcesLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const sources = yield* SourceCollections
    const controlPlane = yield* RuntimeControlPlaneTable
    const output = yield* RuntimeOutputTable
    const ingress = yield* RuntimeIngressTable
    const controlPlaneReadSources = RuntimeControlPlaneRecorder.sources(controlPlane)
    const runtimeOutputReadSources = RuntimeOutputJournal.sources(output)
    const ingressInputReadSources = RuntimeIngressAppender.sources(ingress)
    const ingressDeliveryReadSources = RuntimeIngressDeliveryTracker.sources(ingress)

    yield* sources.register(controlPlaneReadSources.runs)
    yield* sources.register(runtimeOutputReadSources.events)
    yield* sources.register(runtimeOutputReadSources.logs)
    yield* sources.register(ingressInputReadSources.inputs)
    yield* sources.register(ingressDeliveryReadSources.deliveries)
    yield* sources.register(runtimeOutputReadSources.agentOutputEvents)
  }),
)
