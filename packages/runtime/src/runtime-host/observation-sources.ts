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
  type RuntimeEventRow,
} from "@firegrid/protocol/launch"
import { RuntimeIngressTable } from "@firegrid/protocol/runtime-ingress"
import { Effect, Either, Layer, Option, Schema, Stream } from "effect"
import { AgentOutputEventSchema, type AgentOutputEvent } from "../agent-io/index.ts"
import {
  SourceCollections,
  type SourceCollectionHandle,
  sourceCollectionHandle,
} from "../durable-tools/index.ts"

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

export interface RuntimeAgentOutputObservation {
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly _tag: AgentOutputEvent["_tag"]
  readonly event: AgentOutputEvent
  readonly permissionRequestId?: string
  readonly toolUseId?: string
  readonly toolName?: string
}

const decodeAgentOutputWrapper = (
  raw: string,
): Option.Option<AgentOutputEvent> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return Option.none()
  }
  if (typeof parsed !== "object" || parsed === null) return Option.none()
  const record = parsed as { readonly type?: unknown; readonly event?: unknown }
  if (record.type !== "firegrid.agent-output") return Option.none()
  const decoded = Schema.decodeUnknownEither(AgentOutputEventSchema)(record.event)
  return Either.isRight(decoded) ? Option.some(decoded.right) : Option.none()
}

const runtimeAgentOutputObservationFromRow = (
  row: RuntimeEventRow,
): Option.Option<RuntimeAgentOutputObservation> =>
  Option.map(decodeAgentOutputWrapper(row.raw), (event) => {
    const base = {
      contextId: row.contextId,
      activityAttempt: row.activityAttempt,
      sequence: row.sequence,
      _tag: event._tag,
      event,
    } satisfies Omit<
      RuntimeAgentOutputObservation,
      "permissionRequestId" | "toolUseId" | "toolName"
    >
    if (event._tag === "PermissionRequest") {
      return {
        ...base,
        permissionRequestId: event.permissionRequestId,
        toolUseId: event.toolUseId,
      }
    }
    if (event._tag === "ToolUse") {
      return {
        ...base,
        toolUseId: event.part.id,
        toolName: event.part.name,
      }
    }
    return base
  })

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
