/**
 * Tracer 023 — caller-owned ACP observation table.
 *
 * This is *adapter-owned* durable evidence (an EventPlane-shaped table per
 * `client-event-plane-registration.ACP_AGENT_PROFILE.1`), NOT a Firegrid-native
 * row family. It lives in `scenarios/firegrid` so the substrate boundary stays
 * intact: Firegrid packages do not learn the words "session", "prompt",
 * "tool_call", or "permission" (per `firegrid-platform-invariants.BOUNDARY.1`).
 *
 * The adapter writes one row per ACP message (both directions) so the scenario
 * can assert correlation with `runtimeContextId` and verify that protocol
 * updates land as durable facts rather than ambient process state.
 */

import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"
import { Schema } from "effect"

const AcpDirectionSchema = Schema.Literal("client_to_agent", "agent_to_client")
export type AcpDirection = Schema.Schema.Type<typeof AcpDirectionSchema>

const AcpObservationKindSchema = Schema.Literal("request", "response", "notification")
export type AcpObservationKind = Schema.Schema.Type<typeof AcpObservationKindSchema>

const AcpObservationRowSchema = Schema.Struct({
  observationId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  sequence: Schema.Number,
  direction: AcpDirectionSchema,
  kind: AcpObservationKindSchema,
  method: Schema.String,
  sessionId: Schema.optional(Schema.String),
  payloadJson: Schema.String,
  observedAt: Schema.String,
})
type AcpObservationRow = Schema.Schema.Type<typeof AcpObservationRowSchema>

const acpObservationSchemas = {
  observations: AcpObservationRowSchema,
} as const

export class AcpObservationTable extends DurableTable(
  "tracer023.acpObservation",
  acpObservationSchemas,
) {}

type AcpObservationTableService = DurableTableService<typeof acpObservationSchemas>

export const acpObservationTableLayerOptions = (options: {
  readonly streamUrl: string
  readonly headers?: DurableTableHeaders
}): DurableTableLayerOptions => {
  const contentType = "application/json"
  const streamOptions = options.headers === undefined
    ? { url: options.streamUrl, contentType }
    : { url: options.streamUrl, contentType, headers: options.headers }
  return { streamOptions }
}
