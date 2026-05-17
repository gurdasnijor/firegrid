import { DurableTable, type DurableTableService } from "effect-durable-operators"
import { Schema } from "effect"

export const RuntimeIngressKindSchema = Schema.Literal(
  "message",
  "control",
  "tool_result",
  "required_action_result",
)
export type RuntimeIngressKind = Schema.Schema.Type<typeof RuntimeIngressKindSchema>

export const RuntimeIngressAuthorSchema = Schema.Literal(
  "client",
  "workflow",
  "tool",
  "system",
)
export type RuntimeIngressAuthor = Schema.Schema.Type<typeof RuntimeIngressAuthorSchema>

export const RuntimeIngressStatusSchema = Schema.Literal(
  "pending",
  "sequenced",
  "cancelled",
)
export type RuntimeIngressStatus = Schema.Schema.Type<typeof RuntimeIngressStatusSchema>

const RuntimeIngressMetadataSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
})

const runtimeIngressPayloadFields = {
  contextId: Schema.String,
  kind: RuntimeIngressKindSchema,
  authoredBy: RuntimeIngressAuthorSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  metadata: Schema.optional(RuntimeIngressMetadataSchema),
} as const

export const PublicPromptRequestSchema = Schema.Struct({
  contextId: Schema.String,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  metadata: Schema.optional(RuntimeIngressMetadataSchema),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type PublicPromptRequest = Schema.Schema.Type<typeof PublicPromptRequestSchema>

export const RuntimeIngressRequestSchema = Schema.Struct({
  inputId: Schema.optional(Schema.String),
  ...runtimeIngressPayloadFields,
})
export type RuntimeIngressRequest = Schema.Schema.Type<typeof RuntimeIngressRequestSchema>

const DELIVERY_KEY_SEPARATOR = "\x1f"

export const RuntimeInputDeliveryKey = Schema.transform(
  Schema.String,
  Schema.Struct({
    subscriberId: Schema.String,
    inputId: Schema.String,
  }),
  {
    strict: false,
    decode: (encoded: string) => {
      const [subscriberId = "", inputId = ""] = encoded.split(DELIVERY_KEY_SEPARATOR)
      return { subscriberId, inputId }
    },
    encode: ({
      subscriberId,
      inputId,
    }: {
      readonly subscriberId: string
      readonly inputId: string
    }) => `${subscriberId}${DELIVERY_KEY_SEPARATOR}${inputId}`,
  },
)
export type RuntimeInputDeliveryKey = Schema.Schema.Type<typeof RuntimeInputDeliveryKey>

export const RuntimeIngressInputRowSchema = Schema.Struct({
  inputId: Schema.String.pipe(DurableTable.primaryKey),
  sequence: Schema.optional(Schema.Number),
  status: RuntimeIngressStatusSchema,
  ...runtimeIngressPayloadFields,
  createdAt: Schema.String,
  sequencedAt: Schema.optional(Schema.String),
})
export type RuntimeIngressInputRow = Schema.Schema.Type<typeof RuntimeIngressInputRowSchema>

export const RuntimeInputIntentRowSchema = Schema.Struct({
  intentId: Schema.String.pipe(DurableTable.primaryKey),
  ...runtimeIngressPayloadFields,
  createdAt: Schema.String,
})
export type RuntimeInputIntentRow = Schema.Schema.Type<typeof RuntimeInputIntentRowSchema>

export const RuntimeIngressDeliveryRowSchema = Schema.Struct({
  key: RuntimeInputDeliveryKey.pipe(DurableTable.primaryKey),
  inputId: Schema.String,
  contextId: Schema.String,
  subscriberId: Schema.String,
  claimedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
})
export type RuntimeIngressDeliveryRow = Schema.Schema.Type<typeof RuntimeIngressDeliveryRowSchema>

const runtimeIngressSchemas = {
  inputs: RuntimeIngressInputRowSchema,
  deliveries: RuntimeIngressDeliveryRowSchema,
} as const

export class RuntimeIngressTable extends DurableTable(
  "firegrid.runtimeIngress",
  runtimeIngressSchemas,
) {}

export type RuntimeIngressTableService = DurableTableService<typeof runtimeIngressSchemas>

export const runtimeIngressInputIdForIdempotencyKey = (
  contextId: string,
  idempotencyKey: string,
): string =>
  `input_${contextId}_${idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_")}`

const nowIso = (): string => new Date().toISOString()

export const inputIdForRuntimeIngressRequest = (
  request: RuntimeIngressRequest,
): string =>
  request.inputId ??
  (request.idempotencyKey === undefined
    ? `input_${crypto.randomUUID()}`
    : runtimeIngressInputIdForIdempotencyKey(request.contextId, request.idempotencyKey))

export const promptToRuntimeIngressRequest = (
  request: PublicPromptRequest,
): RuntimeIngressRequest => ({
  contextId: request.contextId,
  kind: "message",
  authoredBy: "client",
  payload: request.payload,
  ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
})

const runtimeIngressPayloadFromRequest = (
  request: RuntimeIngressRequest,
) => ({
  contextId: request.contextId,
  kind: request.kind,
  authoredBy: request.authoredBy,
  payload: request.payload,
  ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
})

export const makeRuntimeIngressInputRow = (
  request: RuntimeIngressRequest,
  options?: {
    readonly inputId?: string
    readonly createdAt?: string
  },
): RuntimeIngressInputRow => {
  const inputId = options?.inputId ?? inputIdForRuntimeIngressRequest(request)
  const createdAt = options?.createdAt ?? nowIso()
  return {
    inputId,
    status: "pending",
    ...runtimeIngressPayloadFromRequest(request),
    createdAt,
  }
}

export const makeRuntimeInputIntentRow = (
  request: RuntimeIngressRequest,
  options?: {
    readonly intentId?: string
    readonly createdAt?: string
  },
): RuntimeInputIntentRow => {
  const intentId = options?.intentId ?? inputIdForRuntimeIngressRequest(request)
  const createdAt = options?.createdAt ?? nowIso()
  return {
    intentId,
    ...runtimeIngressPayloadFromRequest(request),
    createdAt,
  }
}

export const runtimeInputIntentToRuntimeIngressRequest = (
  intent: RuntimeInputIntentRow,
): RuntimeIngressRequest => ({
  inputId: intent.intentId,
  contextId: intent.contextId,
  kind: intent.kind,
  authoredBy: intent.authoredBy,
  payload: intent.payload,
  ...(intent.idempotencyKey === undefined ? {} : { idempotencyKey: intent.idempotencyKey }),
  ...(intent.metadata === undefined ? {} : { metadata: intent.metadata }),
})

/**
 * Legacy query for the next ingress sequence number on a context. New
 * host-owned runtime input routing records sequence through workflow
 * input deferred evidence instead of client-side table writes.
 *
 * firegrid-agent-ingress.INGRESS.9
 */
export const nextRuntimeIngressSequence = (
  table: RuntimeIngressTableService,
  contextId: string,
) =>
  table.inputs.query((coll) =>
    coll.toArray
      .filter(candidate => candidate.contextId === contextId)
      .reduce(
        (max, candidate) =>
          candidate.sequence === undefined ? max : Math.max(max, candidate.sequence + 1),
        0,
      ))
