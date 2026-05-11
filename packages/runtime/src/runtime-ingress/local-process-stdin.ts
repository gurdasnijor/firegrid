import type { HttpClient } from "@effect/platform"
import {
  type RuntimeIngressAcceptanceRequest,
  type RuntimeIngressAcceptedRow,
  type RuntimeIngressRequestedRow,
  type RuntimeIngressRow,
  RuntimeIngressRowSchema,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Option, Stream } from "effect"
import { DurableStream } from "effect-durable-streams"
import {
  emptyPendingRuntimeIngressState,
  foldRuntimeIngressProgress,
  isRuntimeIngressAcceptedFor,
  isRuntimeIngressRequestFor,
  runtimeIngressSubscriberKey,
  type PendingRuntimeIngressState,
} from "./pending.ts"
import {
  makeRuntimeIngressAcceptedRow,
} from "./rows.ts"
import {
  type RuntimeIngressError,
  runtimeIngressError,
} from "./schema.ts"

interface LocalProcessRuntimeIngressStdinOptions {
  readonly streamUrl: string
  readonly contextId: string
  readonly subscriberId: string
  readonly provider: string
}

const encoder = new TextEncoder()

const textFromPayloadValue = (
  value: unknown,
): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined
}

const providerInputFromIngress = (
  row: RuntimeIngressRequestedRow,
): string => {
  if (Array.isArray(row.payload)) {
    const text = row.payload.flatMap(value => {
      const decoded = textFromPayloadValue(value)
      return decoded === undefined ? [] : [decoded]
    })
    if (text.length > 0) return text.join("\n")
  }
  const text = textFromPayloadValue(row.payload)
  return text ?? JSON.stringify(row.payload)
}

const mapRuntimeIngressStreamError = (
  op: string,
  message: string,
  row?: {
    readonly contextId?: string
    readonly ingressId?: string
  },
) =>
  Effect.mapError((cause: DurableStream.ReadError | DurableStream.WriteError) =>
    runtimeIngressError(op, message, row?.contextId, row?.ingressId, cause))

const appendAccepted = <I>(
  stream: DurableStream.Bound<RuntimeIngressRow, I>,
  request: RuntimeIngressAcceptanceRequest,
): Effect.Effect<RuntimeIngressAcceptedRow, RuntimeIngressError, HttpClient.HttpClient> => {
  const row = makeRuntimeIngressAcceptedRow(request)
  // firegrid-agent-ingress.DELIVERY.3
  // firegrid-agent-ingress.DELIVERY.5
  return stream.append(row).pipe(
    Effect.as(row),
    mapRuntimeIngressStreamError(
      "append",
      "failed to append runtime ingress accepted row",
      row,
    ),
  )
}

const emitPendingInput = <I>(
  stream: DurableStream.Bound<RuntimeIngressRow, I>,
  state: PendingRuntimeIngressState,
  options: LocalProcessRuntimeIngressStdinOptions,
  row: RuntimeIngressRequestedRow,
): Effect.Effect<Uint8Array, RuntimeIngressError, HttpClient.HttpClient> => {
  const key = runtimeIngressSubscriberKey({
    contextId: row.contextId,
    ingressId: row.ingressId,
    subscriberId: options.subscriberId,
  })
  if (state.accepted.has(key)) {
    return Effect.fail(runtimeIngressError(
      "local-process-stdin.duplicate",
      "runtime ingress row was already accepted for local-process stdin dispatch",
      row.contextId,
      row.ingressId,
    ))
  }
  return appendAccepted(stream, {
    contextId: row.contextId,
    ingressId: row.ingressId,
    subscriberId: options.subscriberId,
    provider: options.provider,
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        state.accepted.add(key)
        state.pending.delete(key)
      })),
    Effect.as(encoder.encode(`${providerInputFromIngress(row)}\n`)),
  )
}

const nextLiveInput = <I>(
  stream: DurableStream.Bound<RuntimeIngressRow, I>,
  state: PendingRuntimeIngressState,
  options: LocalProcessRuntimeIngressStdinOptions,
  row: RuntimeIngressRow,
): Effect.Effect<Option.Option<Uint8Array>, RuntimeIngressError, HttpClient.HttpClient> => {
  if (isRuntimeIngressAcceptedFor(row, options)) {
    return Effect.sync(() => {
      const key = runtimeIngressSubscriberKey(row)
      state.accepted.add(key)
      state.pending.delete(key)
      return Option.none()
    })
  }
  if (!isRuntimeIngressRequestFor(row, options.contextId)) {
    return Effect.succeed(Option.none())
  }
  const key = runtimeIngressSubscriberKey({
    contextId: row.contextId,
    ingressId: row.ingressId,
    subscriberId: options.subscriberId,
  })
  if (state.accepted.has(key)) return Effect.succeed(Option.none())
  return emitPendingInput(stream, state, options, row).pipe(
    Effect.map(Option.some),
  )
}

export const localProcessRuntimeIngressStdin = (
  options: LocalProcessRuntimeIngressStdinOptions,
): Stream.Stream<Uint8Array, RuntimeIngressError, HttpClient.HttpClient> => {
  const stream = DurableStream.define({
    endpoint: { url: options.streamUrl },
    schema: RuntimeIngressRowSchema,
  })
  return Stream.unwrap(stream.snapshotThenFollow.pipe(
    mapRuntimeIngressStreamError(
      "snapshot-follow",
      "failed to open runtime ingress durable stream",
      options,
    ),
    Effect.map(({ snapshot, live }) => {
      const state = snapshot.reduce((next, row) => {
        foldRuntimeIngressProgress(next, row, options)
        return next
      }, emptyPendingRuntimeIngressState())
      const retained = Stream.fromIterable(Array.from(state.pending.values())).pipe(
        Stream.mapEffect(row => emitPendingInput(stream, state, options, row)),
      )
      const following = live.pipe(
        Stream.mapError(cause =>
          runtimeIngressError(
            "live",
            "failed to read live runtime ingress rows",
            options.contextId,
            undefined,
            cause,
          )),
        Stream.mapEffect(row => nextLiveInput(stream, state, options, row)),
        Stream.filterMap(option => option),
      )
      // firegrid-agent-ingress.INGRESS.6
      // firegrid-agent-ingress.DELIVERY.5
      return retained.pipe(Stream.concat(following))
    }),
  ))
}
