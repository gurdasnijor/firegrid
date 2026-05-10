import {
  appendJson,
  readRetainedJson,
} from "@firegrid/durable-streams/log"
import { Context, Effect, Layer, Schema } from "effect"
import {
  runtimeIngressDeliveredRowId,
  runtimeIngressIdForIdempotencyKey,
  runtimeIngressRequestedRowId,
} from "./ids.ts"
import {
  RuntimeIngressDeliveryRequestSchema,
  RuntimeIngressDeliveredRowSchema,
  RuntimeIngressRequestedRowSchema,
  RuntimeIngressRequestSchema,
  RuntimeIngressRowSchema,
  runtimeIngressError,
  type RuntimeIngressDeliveryRequest,
  type RuntimeIngressDeliveredRow,
  type RuntimeIngressError,
  type RuntimeIngressRequest,
  type RuntimeIngressRequestedRow,
  type RuntimeIngressRow,
} from "./schema.ts"

export interface RuntimeIngressOptions {
  readonly streamUrl: string
}

export interface PendingRuntimeIngressOptions {
  readonly contextId: string
  readonly subscriberId: string
}

interface RuntimeIngressService {
  readonly append: (
    request: RuntimeIngressRequest,
  ) => Effect.Effect<RuntimeIngressRequestedRow, RuntimeIngressError>
  readonly pending: (
    options: PendingRuntimeIngressOptions,
  ) => Effect.Effect<ReadonlyArray<RuntimeIngressRequestedRow>, RuntimeIngressError>
  readonly markDelivered: (
    request: RuntimeIngressDeliveryRequest,
  ) => Effect.Effect<RuntimeIngressDeliveredRow, RuntimeIngressError>
  readonly rows: Effect.Effect<ReadonlyArray<RuntimeIngressRow>, RuntimeIngressError>
}

export class RuntimeIngress extends Context.Tag("firegrid/runtime/RuntimeIngress")<
  RuntimeIngress,
  RuntimeIngressService
>() {}

const nowIso = (): string => new Date().toISOString()

const decodeRow = (
  row: unknown,
): RuntimeIngressRow | undefined =>
  Schema.decodeUnknownOption(RuntimeIngressRowSchema)(row).pipe(
    option => option._tag === "Some" ? option.value : undefined,
  )

const readRuntimeIngressRows = (
  streamUrl: string,
): Effect.Effect<ReadonlyArray<RuntimeIngressRow>, RuntimeIngressError> =>
  readRetainedJson<unknown>({ streamUrl }).pipe(
    Effect.map(rows => rows.flatMap(row => {
      const decoded = decodeRow(row)
      return decoded === undefined ? [] : [decoded]
    })),
    Effect.mapError(cause =>
      runtimeIngressError(
        "read",
        "failed to read runtime ingress durable rows",
        undefined,
        undefined,
        cause,
      )),
  )

const appendRuntimeIngressRow = (
  streamUrl: string,
  row: RuntimeIngressRow,
) =>
  appendJson({ streamUrl, event: row }).pipe(
    Effect.mapError(cause =>
      runtimeIngressError(
        "append",
        "failed to append runtime ingress durable row",
        row.contextId,
        row.ingressId,
        cause,
      )),
  )

const findExistingRequest = (
  rows: ReadonlyArray<RuntimeIngressRow>,
  request: RuntimeIngressRequest & { readonly ingressId: string },
): RuntimeIngressRequestedRow | undefined =>
  rows.find((row): row is RuntimeIngressRequestedRow =>
    row.type === "firegrid.runtime_ingress.requested" &&
    row.contextId === request.contextId &&
    (row.ingressId === request.ingressId ||
      (request.idempotencyKey !== undefined &&
        row.idempotencyKey === request.idempotencyKey)))

const isDelivered = (
  rows: ReadonlyArray<RuntimeIngressRow>,
  request: RuntimeIngressRequestedRow,
  subscriberId: string,
): boolean =>
  rows.some(row =>
    row.type === "firegrid.runtime_ingress.delivered" &&
    row.contextId === request.contextId &&
    row.ingressId === request.ingressId &&
    row.subscriberId === subscriberId)

const pendingRuntimeIngress = (
  rows: ReadonlyArray<RuntimeIngressRow>,
  options: PendingRuntimeIngressOptions,
): ReadonlyArray<RuntimeIngressRequestedRow> =>
  rows
    .filter((row): row is RuntimeIngressRequestedRow =>
      row.type === "firegrid.runtime_ingress.requested" &&
      row.contextId === options.contextId)
    .filter(row => !isDelivered(rows, row, options.subscriberId))

export const RuntimeIngressLive = (
  options: RuntimeIngressOptions,
) =>
  Layer.succeed(
    RuntimeIngress,
    RuntimeIngress.of({
      rows: readRuntimeIngressRows(options.streamUrl),
      append: request =>
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownSync(RuntimeIngressRequestSchema)(request)
          const ingressId = decoded.ingressId ??
            (decoded.idempotencyKey === undefined
              ? `ing_${crypto.randomUUID()}`
              : runtimeIngressIdForIdempotencyKey(decoded.contextId, decoded.idempotencyKey))
          const requestWithId = { ...decoded, ingressId }
          const rows = yield* readRuntimeIngressRows(options.streamUrl)
          const existing = findExistingRequest(rows, requestWithId)
          if (existing !== undefined) return existing

          const createdAt = nowIso()
          const row = Schema.decodeUnknownSync(RuntimeIngressRequestedRowSchema)({
            type: "firegrid.runtime_ingress.requested",
            id: runtimeIngressRequestedRowId(decoded.contextId, ingressId),
            at: createdAt,
            ingressId,
            contextId: decoded.contextId,
            kind: decoded.kind,
            authoredBy: decoded.authoredBy,
            payload: decoded.payload,
            ...(decoded.idempotencyKey === undefined ? {} : { idempotencyKey: decoded.idempotencyKey }),
            createdAt,
            ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }),
          })

          // firegrid-agent-ingress.INGRESS.1
          // firegrid-agent-ingress.INGRESS.3
          // firegrid-agent-ingress.HOST.1
          yield* appendRuntimeIngressRow(options.streamUrl, row)
          return row
        }),
      pending: pendingOptions =>
        readRuntimeIngressRows(options.streamUrl).pipe(
          Effect.map(rows => pendingRuntimeIngress(rows, pendingOptions)),
        ),
      markDelivered: request =>
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownSync(RuntimeIngressDeliveryRequestSchema)(request)
          const rows = yield* readRuntimeIngressRows(options.streamUrl)
          const existing = rows.find((row): row is RuntimeIngressDeliveredRow =>
            row.type === "firegrid.runtime_ingress.delivered" &&
            row.contextId === decoded.contextId &&
            row.ingressId === decoded.ingressId &&
            row.subscriberId === decoded.subscriberId)
          if (existing !== undefined) return existing

          const deliveredAt = decoded.deliveredAt ?? nowIso()
          const row = Schema.decodeUnknownSync(RuntimeIngressDeliveredRowSchema)({
            type: "firegrid.runtime_ingress.delivered",
            id: runtimeIngressDeliveredRowId(decoded.contextId, decoded.subscriberId, decoded.ingressId),
            at: deliveredAt,
            ingressId: decoded.ingressId,
            contextId: decoded.contextId,
            subscriberId: decoded.subscriberId,
            provider: decoded.provider,
            deliveredAt,
          })

          // firegrid-agent-ingress.DELIVERY.3
          // firegrid-agent-ingress.SUBSCRIBERS.2
          yield* appendRuntimeIngressRow(options.streamUrl, row)
          return row
        }),
    }),
  )

export const RuntimeIngressUnavailableLive = Layer.succeed(
  RuntimeIngress,
  RuntimeIngress.of({
    rows: Effect.succeed([]),
    append: request =>
      Effect.fail(runtimeIngressError(
        "append",
        "runtime ingress stream is not configured",
        request.contextId,
        request.ingressId,
      )),
    pending: () => Effect.succeed([]),
    markDelivered: request =>
      Effect.fail(runtimeIngressError(
        "markDelivered",
        "runtime ingress stream is not configured",
        request.contextId,
        request.ingressId,
      )),
  }),
)
