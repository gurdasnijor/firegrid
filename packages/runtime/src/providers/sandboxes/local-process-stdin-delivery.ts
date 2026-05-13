/**
 * Local-process sandbox stdin delivery.
 *
 * Subscribes to sequenced RuntimeIngressTable input rows for a given
 * `(contextId, subscriberId)` and translates them into encoded stdin chunks
 * for the local-process sandbox. Per-key delivery progress is recorded in the
 * same RuntimeIngressTable deliveries collection.
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
 *    uses RuntimeIngressTable directly, not a generic consumer.
 *  - firegrid-agent-ingress.DELIVERY.1
 *  - firegrid-agent-ingress.DELIVERY.2
 *  - firegrid-agent-ingress.DELIVERY.3 — claim row is durable.
 *  - firegrid-agent-ingress.DELIVERY.5 — provider-owned table subscription.
 */

import {
  RuntimeIngressTable,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Option, Schema, Stream } from "effect"
export class LocalProcessStdinDeliveryError extends Schema.TaggedError<LocalProcessStdinDeliveryError>()(
  "LocalProcessStdinDeliveryError",
  {
    op: Schema.String,
    contextId: Schema.String,
    inputId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const localProcessStdinDeliveryError = (
  op: string,
  message: string,
  contextId: string,
  inputId?: string,
  cause?: unknown,
): LocalProcessStdinDeliveryError =>
  new LocalProcessStdinDeliveryError({
    op,
    message,
    contextId,
    ...(inputId === undefined ? {} : { inputId }),
    ...(cause === undefined ? {} : { cause }),
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

const providerInputFromIngress = (row: RuntimeIngressInputRow): string => {
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

interface LocalProcessStdinDeliveryOptions {
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
    row: RuntimeIngressInputRow,
  ) => Effect.Effect<void, LocalProcessStdinDeliveryError>
}

/**
 * Build a stdin source `Stream<Uint8Array, LocalProcessStdinDeliveryError>` for the
 * local-process sandbox. The returned Stream requires the RuntimeIngressTable
 * service.
 *
 * AtMostOnce semantic: the generated DurableTable `upsert` action attaches a
 * txid header and awaits `awaitTxId` before completing, so the claim is
 * durable and locally visible before the encoded bytes are exposed
 * downstream. The `awaitTxId` step is intentional — do not remove it as
 * redundant.
 */
const mapDeliveryError = (
  options: LocalProcessStdinDeliveryOptions,
) => (cause: unknown): LocalProcessStdinDeliveryError => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause
  ) {
    const tag = (cause as { _tag: string })._tag
    if (tag === "LocalProcessStdinDeliveryError") {
      return cause as LocalProcessStdinDeliveryError
    }
    if (tag === "DurableTableError") {
      return localProcessStdinDeliveryError(
        "delivery-write",
        "runtime input delivery table failure",
        options.contextId,
        undefined,
        cause,
      )
    }
  }
  return localProcessStdinDeliveryError(
    "delivery",
    "runtime input stdin delivery failure",
    options.contextId,
    undefined,
    cause,
  )
}

const sequencedInputRows = (
  table: RuntimeIngressTable["Type"],
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow, LocalProcessStdinDeliveryError> =>
  table.inputs.subscribe<RuntimeIngressInputRow>((coll, emit) => {
    const sub = coll.subscribeChanges(
      (changes) => {
        const rows = changes
          .flatMap(change => change.value === undefined || change.value === null ? [] : [change.value])
          .filter(row =>
            row.contextId === contextId &&
            row.status === "sequenced" &&
            row.sequence !== undefined,
          )
          .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
        for (const row of rows) {
          emit(row)
        }
      },
      { includeInitialState: true },
    )
    return () => sub.unsubscribe()
  }).pipe(
    Stream.mapError(cause =>
      localProcessStdinDeliveryError(
        "delivery-subscribe",
        "runtime input delivery subscription failure",
        contextId,
        undefined,
        cause,
      )),
  )

export const localProcessStdinDelivery = (
  options: LocalProcessStdinDeliveryOptions,
): Stream.Stream<
  Uint8Array,
  LocalProcessStdinDeliveryError,
  RuntimeIngressTable
> => {
  const stream = Stream.unwrap(
    Effect.map(RuntimeIngressTable, table =>
      sequencedInputRows(table, options.contextId).pipe(
        Stream.mapEffect(row =>
          Effect.gen(function* () {
            const key = {
              subscriberId: options.subscriberId,
              inputId: row.inputId,
            }
            const existing = yield* table.deliveries.get(key)
            if (
              Option.isSome(existing) &&
              existing.value.claimedAt !== undefined
            ) {
              return Option.none<Uint8Array>()
            }

            yield* table.deliveries.upsert({
              key,
              inputId: row.inputId,
              contextId: row.contextId,
              subscriberId: options.subscriberId,
              claimedAt: new Date().toISOString(),
            })

            if (options.onClaimedBeforeEmit !== undefined) {
              yield* options.onClaimedBeforeEmit(row)
            }

            return Option.some(
              encoder.encode(`${providerInputFromIngress(row)}\n`),
            )
          }).pipe(
            Effect.mapError(mapDeliveryError(options)),
          )),
        Stream.filterMap(value => value),
      ),
    ),
  )
  return stream as Stream.Stream<
    Uint8Array,
    LocalProcessStdinDeliveryError,
    RuntimeIngressTable
  >
}
