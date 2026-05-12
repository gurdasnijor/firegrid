/**
 * Local-process sandbox stdin delivery.
 *
 * Reads `firegrid.runtime_ingress.requested` facts for a given
 * `(contextId, subscriberId)` from a durable ingress stream and translates
 * them into encoded stdin chunks for the local-process sandbox. Per-key
 * delivery progress is recorded in a `RuntimeInputDeliveryTable`
 * checkpoint collection (an ordinary `DurableTable` over the checkpoint
 * stream), not in a generic consumer/checkpoint-store service.
 *
 * Semantic guarantee (AtMostOnce):
 *  - the durable claim upsert is awaited (txid + materialized view) BEFORE
 *    the encoded bytes are emitted downstream;
 *  - if the process dies after the claim and before stdin write, the same
 *    row is skipped on restart because the claim row is durable;
 *  - stdin is a non-acknowledged sink, so we do not retry the byte emission
 *    on failure.
 *
 * Implements:
 *  - effect-durable-operators.FIREGRID_PROOF.4 — runtime input stdin delivery
 *    uses DurableStream + DurableTable directly, not a generic consumer.
 *  - firegrid-agent-ingress.DELIVERY.1
 *  - firegrid-agent-ingress.DELIVERY.2
 *  - firegrid-agent-ingress.DELIVERY.3 — claim row is durable.
 *  - firegrid-agent-ingress.DELIVERY.5 — host-owned stream loop.
 */

import type { HttpClient } from "@effect/platform"
import {
  type RuntimeIngressRequestedRow,
  RuntimeIngressRowSchema,
} from "@firegrid/protocol/runtime-ingress"
import { DurableTable } from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import {
  type RuntimeIngressError,
  runtimeIngressError,
} from "../../runtime-ingress/schema.ts"

// ---------------------------------------------------------------------------
// Composite checkpoint key
// ---------------------------------------------------------------------------

/**
 * Composite primary key for runtime input delivery checkpoints. Encoded as a
 * single string for the durable wire format; the schema's decode/encode
 * functions own the separator. The runtime does not concatenate or split
 * key parts directly — this is the only place that touches the separator.
 *
 * effect-durable-operators.TABLE.17 — composite primary keys are
 * Schema.transform schemas, not runtime separator concatenation.
 */
const CHECKPOINT_KEY_SEPARATOR = "\x1f"

export const RuntimeInputDeliveryKey = Schema.transform(
  Schema.String,
  Schema.Struct({
    subscriberId: Schema.String,
    ingressId: Schema.String,
  }),
  {
    strict: false,
    decode: (encoded: string) => {
      const [subscriberId = "", ingressId = ""] = encoded.split(
        CHECKPOINT_KEY_SEPARATOR,
      )
      return { subscriberId, ingressId }
    },
    encode: ({
      subscriberId,
      ingressId,
    }: {
      readonly subscriberId: string
      readonly ingressId: string
    }) => `${subscriberId}${CHECKPOINT_KEY_SEPARATOR}${ingressId}`,
  },
)

/**
 * Durable checkpoint table for runtime input delivery. The composite key
 * carries `(subscriberId, ingressId)`; the row records claim and (optional)
 * completion timestamps. AtMostOnce delivery only writes `claimedAt`.
 */
export class RuntimeInputDeliveryTable extends DurableTable(
  "runtimeInputDelivery",
  {
    checkpoints: Schema.Struct({
      key: RuntimeInputDeliveryKey.pipe(DurableTable.primaryKey),
      claimedAt: Schema.optional(Schema.String),
      completedAt: Schema.optional(Schema.String),
    }),
  },
) {}

export interface RuntimeInputDeliveryLayerOptions {
  readonly checkpointStreamUrl: string
}

export const runtimeInputDeliveryLayer = (
  options: RuntimeInputDeliveryLayerOptions,
) =>
  RuntimeInputDeliveryTable.layer({
    streamOptions: {
      url: options.checkpointStreamUrl,
      contentType: "application/json",
    },
  })

// ---------------------------------------------------------------------------
// Payload encoding (local-process stdin)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

const textFromPayloadValue = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined
}

const providerInputFromIngress = (row: RuntimeIngressRequestedRow): string => {
  if (Array.isArray(row.payload)) {
    const text = row.payload.flatMap((value) => {
      const decoded = textFromPayloadValue(value)
      return decoded === undefined ? [] : [decoded]
    })
    if (text.length > 0) return text.join("\n")
  }
  const text = textFromPayloadValue(row.payload)
  return text ?? JSON.stringify(row.payload)
}

// ---------------------------------------------------------------------------
// Stdin delivery stream
// ---------------------------------------------------------------------------

export interface LocalProcessStdinDeliveryOptions {
  readonly streamUrl: string
  readonly contextId: string
  readonly subscriberId: string
  /**
   * Test seam: invoked AFTER the durable claim upsert has completed and
   * BEFORE the encoded bytes are emitted. Production code does not supply
   * this; tests inject a failure here to verify AtMostOnce semantics.
   *
   * If this effect fails, the bytes are not emitted; the claim row remains
   * durable so a subsequent run skips the same ingress row.
   */
  readonly onClaimedBeforeEmit?: (
    row: RuntimeIngressRequestedRow,
  ) => Effect.Effect<void, RuntimeIngressError>
}

/**
 * Build a stdin source `Stream<Uint8Array, RuntimeIngressError>` for the
 * local-process sandbox. The returned Stream requires the
 * `RuntimeInputDeliveryTable` service plus an HTTP client (the checkpoint
 * table layer is wired by the caller; see `runtimeInputDeliveryLayer`).
 *
 * AtMostOnce semantic: the generated DurableTable `upsert` action attaches a
 * txid header and awaits `awaitTxId` before completing, so the claim is
 * durable and locally visible before the encoded bytes are exposed
 * downstream. The `awaitTxId` step is intentional — do not remove it as
 * redundant.
 */
export const localProcessStdinDelivery = (
  options: LocalProcessStdinDeliveryOptions,
): Stream.Stream<
  Uint8Array,
  RuntimeIngressError,
  HttpClient.HttpClient | RuntimeInputDeliveryTable
> => {
  const factStream = DurableStream.define({
    endpoint: { url: options.streamUrl },
    schema: RuntimeIngressRowSchema,
  }).read({ live: true }).pipe(
    // Wrap source DurableStream errors into the RuntimeIngressError shape
    // up front so the rest of the pipeline has a uniform error channel.
    Stream.mapError((cause) =>
      runtimeIngressError(
        "source-read",
        "runtime ingress read failure",
        options.contextId,
        undefined,
        cause,
      ),
    ),
  )

  return factStream.pipe(
    Stream.filter(
      (row): row is RuntimeIngressRequestedRow =>
        row.type === "firegrid.runtime_ingress.requested" &&
        row.contextId === options.contextId,
    ),
    Stream.mapEffect((row): Effect.Effect<
      Option.Option<Uint8Array>,
      RuntimeIngressError,
      RuntimeInputDeliveryTable
    > =>
      Effect.gen(function* () {
        const table = yield* RuntimeInputDeliveryTable
        const key = {
          subscriberId: options.subscriberId,
          ingressId: row.ingressId,
        }
        const existing = yield* table.checkpoints.get(key)
        if (
          Option.isSome(existing) &&
          existing.value.claimedAt !== undefined
        ) {
          return Option.none<Uint8Array>()
        }

        // The generated DurableTable upsert action appends a State Protocol
        // change event with a txid header AND awaits `db.utils.awaitTxId`
        // before this Effect resolves. That makes the claim row durable
        // and locally visible BEFORE we expose the encoded bytes to the
        // sandbox. The txid wait is intentional for AtMostOnce semantics;
        // do not remove it as redundant.
        yield* table.checkpoints.upsert({
          key,
          claimedAt: new Date().toISOString(),
        })

        if (options.onClaimedBeforeEmit !== undefined) {
          yield* options.onClaimedBeforeEmit(row)
        }

        return Option.some(
          encoder.encode(`${providerInputFromIngress(row)}\n`),
        )
      }).pipe(
        Effect.mapError((cause): RuntimeIngressError => {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause
          ) {
            const tag = (cause as { _tag: string })._tag
            if (tag === "RuntimeIngressError") return cause as RuntimeIngressError
            if (tag === "DurableTableError") {
              return runtimeIngressError(
                "checkpoint-write",
                "runtime input delivery checkpoint failure",
                options.contextId,
                row.ingressId,
                cause,
              )
            }
          }
          return runtimeIngressError(
            "delivery",
            "runtime input stdin delivery failure",
            options.contextId,
            row.ingressId,
            cause,
          )
        }),
      ),
    ),
    Stream.filterMap((value) => value),
  )
}

/**
 * Combined helper layer for callers that want one Layer to provide both the
 * checkpoint table and an HttpClient. Keep `HttpClient.HttpClient` as a
 * separately-wired requirement at the application edge; this helper only
 * fronts the checkpoint table layer.
 */
export const RuntimeInputDeliveryLayer = (
  options: RuntimeInputDeliveryLayerOptions,
): Layer.Layer<RuntimeInputDeliveryTable, never> =>
  runtimeInputDeliveryLayer(options) as unknown as Layer.Layer<
    RuntimeInputDeliveryTable,
    never
  >
