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

import { Effect, Layer } from "effect"
import { SourceCollections } from "../waits/index.ts"
import { sourceCollectionStreamHandle } from "../waits/internal/source-collections.ts"
import {
  RuntimeAuthoritySourceNames as RuntimeObservationSourceNames,
  type RuntimeAuthoritySourceName as RuntimeObservationSourceName,
} from "../authorities/source-names.ts"
import {
  RuntimeAgentOutputEvents,
  type RuntimeAgentOutputObservation,
  RuntimeIngressDeliveries,
  RuntimeIngressInputStream,
  RuntimeOutputEvents,
  RuntimeOutputLogs,
  RuntimeRuns,
} from "../authorities/index.ts"

export {
  RuntimeObservationSourceNames,
  type RuntimeAgentOutputObservation,
  type RuntimeObservationSourceName,
}

export const RuntimeObservationSourcesLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const sources = yield* SourceCollections
    const runtimeRuns = yield* RuntimeRuns
    const runtimeOutputEvents = yield* RuntimeOutputEvents
    const runtimeOutputLogs = yield* RuntimeOutputLogs
    const ingressInputs = yield* RuntimeIngressInputStream
    const ingressDeliveries = yield* RuntimeIngressDeliveries
    const agentOutputEvents = yield* RuntimeAgentOutputEvents

    yield* sources.register(sourceCollectionStreamHandle(
      RuntimeObservationSourceNames.runtimeRuns,
      runtimeRuns,
    ))
    yield* sources.register(sourceCollectionStreamHandle(
      RuntimeObservationSourceNames.runtimeOutputEvents,
      runtimeOutputEvents,
    ))
    yield* sources.register(sourceCollectionStreamHandle(
      RuntimeObservationSourceNames.runtimeOutputLogs,
      runtimeOutputLogs,
    ))
    yield* sources.register(sourceCollectionStreamHandle(
      RuntimeObservationSourceNames.runtimeIngressInputs,
      ingressInputs,
    ))
    yield* sources.register(sourceCollectionStreamHandle(
      RuntimeObservationSourceNames.runtimeIngressDeliveries,
      ingressDeliveries,
    ))
    yield* sources.register(sourceCollectionStreamHandle(
      RuntimeObservationSourceNames.agentOutputEvents,
      agentOutputEvents,
    ))
  }),
)
