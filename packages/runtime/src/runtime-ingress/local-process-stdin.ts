/**
 * Local-process runtime ingress → stdin.
 *
 * Streams `firegrid.runtime_ingress.requested` rows for a given
 * `(contextId, subscriberId)` as encoded stdin chunks for the local-process
 * sandbox provider. Delivery progress is owned by the generic
 * `effect-durable-operators.DurableConsumer` + `ConsumerCheckpointStore`
 * stack — there is no Firegrid-specific checkpoint adapter, and no
 * `firegrid.runtime_ingress.accepted` row is written.
 *
 * Implements:
 *  - effect-durable-operators.FIREGRID_PROOF.1 — runtime input fold lives
 *    in the generic operator package
 *  - effect-durable-operators.FIREGRID_PROOF.3 — Firegrid-side wiring uses
 *    only the generic `ConsumerCheckpointStoreLive` Layer; no
 *    Firegrid-specific checkpoint Layer
 *  - firegrid-agent-ingress.INGRESS.6
 *  - firegrid-agent-ingress.DELIVERY.1
 *  - firegrid-agent-ingress.DELIVERY.2
 *  - firegrid-agent-ingress.DELIVERY.5
 */

import type { HttpClient } from "@effect/platform"
import {
  type RuntimeIngressRequestedRow,
  RuntimeIngressRowSchema,
} from "@firegrid/protocol/runtime-ingress"
import {
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import { Effect, Layer, Option, Stream } from "effect"
import {
  type RuntimeIngressError,
  runtimeIngressError,
} from "./schema.ts"

interface LocalProcessRuntimeIngressStdinOptions {
  readonly streamUrl: string
  /**
   * Separate durable stream URL for the consumer's checkpoint records.
   * Each `(subscriberId, ingressId)` claim/completion is appended here
   * by `ConsumerCheckpointStoreLive`. The stream MUST exist; the host
   * pre-creates it.
   */
  readonly checkpointStreamUrl: string
  readonly contextId: string
  readonly subscriberId: string
}

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

export const localProcessRuntimeIngressStdin = (
  options: LocalProcessRuntimeIngressStdinOptions,
): Stream.Stream<Uint8Array, RuntimeIngressError, HttpClient.HttpClient> => {
  // The consumer treats a `requested` row matching this `contextId` as a
  // logical input. Per-key delivery progress is recorded in the separate
  // checkpoint stream by the generic `ConsumerCheckpointStoreLive` Layer.
  const consumer = DurableConsumer.define({
    name: "runtime-context:local-process:stdin",
    select: (row: RuntimeIngressRequestedRow) =>
      row.contextId === options.contextId ? Option.some(row) : Option.none(),
    key: (row) => row.ingressId,
  })

  const checkpointLayer = ConsumerCheckpointStoreLive({
    streamOptions: {
      endpoint: { url: options.checkpointStreamUrl },
      producerId: `runtime-input-checkpoints:${options.contextId}`,
    },
  })

  // firegrid-agent-ingress.DELIVERY.3
  // firegrid-agent-ingress.DELIVERY.5
  // AtMostOnce: the durable checkpoint claim is written BEFORE the chunk
  // reaches the provider. If the chunk is lost downstream, it is NOT
  // retried — matching the existing local-process semantic where stdin
  // is a non-acknowledged sink.
  return Stream.unwrapScoped(
    Effect.map(Layer.build(checkpointLayer), (context) =>
      DurableConsumer.stream({
        source: ConsumerSource.fromDurableStream(DurableStream.define({
          endpoint: { url: options.streamUrl },
          schema: RuntimeIngressRowSchema,
        })),
        checkpoint: { subscriberId: options.subscriberId },
        definition: consumer,
        policy: ClaimPolicy.AtMostOnce(),
        process: (row) =>
          Effect.succeed(encoder.encode(`${providerInputFromIngress(row)}\n`)),
      }).pipe(
        Stream.provideSomeContext(context),
        Stream.mapError((cause) =>
          runtimeIngressError(
            "consumer",
            cause._tag === "DurableConsumerError"
              ? "durable consumer failure"
              : "runtime ingress read failure",
            options.contextId,
            undefined,
            cause,
          ),
        ),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        runtimeIngressError(
          "checkpoint-layer",
          "runtime ingress checkpoint layer failed to initialize",
          options.contextId,
          undefined,
          cause,
        ),
      ),
    ),
  )
}
