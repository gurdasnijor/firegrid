import { DurableTable } from "effect-durable-operators"
import { Schema } from "effect"
import { RowOtelContextSchema } from "../otel/row-otel.ts"

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
  // firegrid-row-otel-propagation.ROW_OTEL.1 — copied through from the
  // originating `RuntimeInputIntentRow` by the host sequencer so reactive_loop
  // input handling can parent back to the client.prompt producer span.
  _otel: Schema.optional(RowOtelContextSchema),
})
export type RuntimeIngressInputRow = Schema.Schema.Type<typeof RuntimeIngressInputRowSchema>

// `RuntimeInputIntentRowSchema` deleted per SDD_FIREGRID_PROTOCOL_
// RESPONSE_UNIFICATION phase 2. Input delivery now flows as signals
// to signal-based subscribers in `@firegrid/runtime/unified/`. The
// channel append receipt collapsed to `EventOffset`.

export const RuntimeIngressDeliveryRowSchema = Schema.Struct({
  key: RuntimeInputDeliveryKey.pipe(DurableTable.primaryKey),
  inputId: Schema.String,
  contextId: Schema.String,
  subscriberId: Schema.String,
  claimedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
})
export type RuntimeIngressDeliveryRow = Schema.Schema.Type<typeof RuntimeIngressDeliveryRowSchema>

export const runtimeIngressInputIdForIdempotencyKey = (
  contextId: string,
  idempotencyKey: string,
): string =>
  `input_${contextId}_${idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_")}`

const nowIso = (): string => new Date().toISOString()

const optionalRuntimeIngressPayloadFields = (
  request: Pick<RuntimeIngressRequest, "idempotencyKey" | "metadata">,
) => ({
  ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
})

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
  ...optionalRuntimeIngressPayloadFields(request),
})

const runtimeIngressPayloadFromRequest = (
  request: RuntimeIngressRequest,
) => ({
  contextId: request.contextId,
  kind: request.kind,
  authoredBy: request.authoredBy,
  payload: request.payload,
  ...optionalRuntimeIngressPayloadFields(request),
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

// `makeRuntimeInputIntentRow` / `runtimeInputIntentToRuntimeIngressRequest`
// deleted with `RuntimeInputIntentRowSchema` (phase 2).
