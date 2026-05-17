/**
 * Local-process sandbox stdin delivery.
 *
 * Subscribes to sequenced runtime ingress input rows for a given `contextId`
 * and translates them into encoded stdin chunks for the local-process sandbox.
 * Per-command delivery progress is recorded through the sandbox supervisor
 * command claim surface.
 *
 * Semantic guarantee (AtMostOnce):
 *  - the durable claim upsert is awaited (txid + materialized view) BEFORE
 *    the encoded bytes are emitted downstream;
 *  - if the process dies after the claim and before stdin write, the same
 *    command is skipped on restart because the claim row is durable;
 *  - stdin is a non-acknowledged sink, so we do not retry the byte emission
 *    on failure.
 *
 * Implements:
 *  - effect-durable-operators.FIREGRID_PROOF.4 — runtime input stdin delivery
 *    observes runtime ingress rows through a durable capability tag.
 *  - firegrid-agent-ingress.DELIVERY.1
 *  - firegrid-agent-ingress.DELIVERY.2
 *  - firegrid-agent-ingress.DELIVERY.3 — claim row is durable.
 *  - firegrid-agent-ingress.DELIVERY.5 — provider-owned table subscription.
 */

import {
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Option, Schema, Stream } from "effect"
import { RuntimeIngressInputStream } from "../../../durable-tools/internal/runtime-ingress-input-stream.ts"
import { sequencedRuntimeIngressRowsForContext } from "../../transforms/ingress-to-agent-input.ts"
import {
  SandboxStdinEmissionClaim,
  stdinEmissionCommandId,
} from "./supervisor-commands.ts"

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
 * local-process sandbox. The returned Stream requires durable ingress
 * capability tags, not RuntimeIngressTable facades.
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
        "supervisor-claim",
        "sandbox stdin supervisor claim failure",
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
  source: Stream.Stream<RuntimeIngressInputRow, unknown>,
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow, LocalProcessStdinDeliveryError> =>
  sequencedRuntimeIngressRowsForContext(
    source,
    contextId,
  ).pipe(
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
  RuntimeIngressInputStream | SandboxStdinEmissionClaim
> => {
  const stream = Stream.unwrap(
    Effect.gen(function* () {
      const source = yield* RuntimeIngressInputStream
      const stdinClaim = yield* SandboxStdinEmissionClaim
      return sequencedInputRows(
        source,
        options.contextId,
      ).pipe(
        Stream.mapEffect(row =>
          Effect.gen(function* () {
            const bytes = encoder.encode(`${providerInputFromIngress(row)}\n`)
            const commandId = yield* stdinEmissionCommandId({
              contextId: row.contextId,
              inputId: row.inputId,
              bytes,
            })
            const claimed = yield* stdinClaim.claim({
              commandId,
              contextId: row.contextId,
              inputId: row.inputId,
              byteLength: bytes.byteLength,
            })
            if (!claimed) {
              return Option.none<Uint8Array>()
            }

            if (options.onClaimedBeforeEmit !== undefined) {
              yield* options.onClaimedBeforeEmit(row)
            }

            return Option.some(bytes)
          }).pipe(
            Effect.mapError(mapDeliveryError(options)),
          )),
        Stream.filterMap(value => value),
      )
    }),
  )
  return stream
}
