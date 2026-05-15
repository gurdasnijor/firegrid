/**
 * Runtime-host source collection registrations for agent `wait_for`.
 *
 * The sources below are projections over existing DurableTable rows. They do
 * not introduce a permission table or a callback marker; `wait_for` observes
 * the same runtime/session evidence the host already writes.
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
import { Effect, Layer, Stream } from "effect"
import {
  SourceCollections,
  type SourceCollectionHandle,
  sourceCollectionHandle,
} from "../durable-tools/index.ts"
import {
  runtimeAgentOutputObservationFromRow,
  type RuntimeAgentOutputObservation,
} from "../events/output.ts"

export const RuntimeObservationSourceNames = {
  runtimeRuns: "firegrid.runtime.runs",
  runtimeOutputEvents: "firegrid.runtime.output.events",
  runtimeOutputLogs: "firegrid.runtime.output.logs",
  runtimeIngressInputs: "firegrid.runtime.ingress.inputs",
  runtimeIngressDeliveries: "firegrid.runtime.ingress.deliveries",
  agentOutputEvents: "firegrid.runtime.agent-output-events",
} as const

export type RuntimeObservationSourceName =
  typeof RuntimeObservationSourceNames[keyof typeof RuntimeObservationSourceNames]

export type { RuntimeAgentOutputObservation }

const runtimeAgentOutputCollection = (
  table: RuntimeOutputTable["Type"],
): SourceCollectionHandle => ({
  name: RuntimeObservationSourceNames.agentOutputEvents,
  subscribe: () =>
    table.events.rows().pipe(
      Stream.map(runtimeAgentOutputObservationFromRow),
      Stream.filterMap(value => value),
    ),
})

export const RuntimeObservationSourcesLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const sources = yield* SourceCollections
    const controlPlane = yield* RuntimeControlPlaneTable
    const output = yield* RuntimeOutputTable
    const ingress = yield* RuntimeIngressTable

    yield* sources.register(sourceCollectionHandle(
      RuntimeObservationSourceNames.runtimeRuns,
      controlPlane.runs,
    ))
    yield* sources.register(sourceCollectionHandle(
      RuntimeObservationSourceNames.runtimeOutputEvents,
      output.events,
    ))
    yield* sources.register(sourceCollectionHandle(
      RuntimeObservationSourceNames.runtimeOutputLogs,
      output.logs,
    ))
    yield* sources.register(sourceCollectionHandle(
      RuntimeObservationSourceNames.runtimeIngressInputs,
      ingress.inputs,
    ))
    yield* sources.register(sourceCollectionHandle(
      RuntimeObservationSourceNames.runtimeIngressDeliveries,
      ingress.deliveries,
    ))
    yield* sources.register(runtimeAgentOutputCollection(output))
  }),
)
