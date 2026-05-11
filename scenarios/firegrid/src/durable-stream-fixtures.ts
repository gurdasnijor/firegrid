import { FetchHttpClient } from "@effect/platform"
import {
  RuntimeJournalEventSchema,
  type RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import { Effect, Schema } from "effect"
import { DurableStream } from "effect-durable-streams"

export const appendRuntimeJournalEvent = (
  streamUrl: string,
  event: RuntimeJournalEvent,
) =>
  // effect-native-production-cutover.CLIENT_APP.3
  // effect-native-production-cutover.MATERIALIZATION.3
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: RuntimeJournalEventSchema,
  }).append(event).pipe(
    Effect.asVoid,
    Effect.provide(FetchHttpClient.layer),
  )

export const appendUnknownDurableEvent = (
  streamUrl: string,
  event: unknown,
) =>
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: Schema.Unknown,
  }).append(event).pipe(
    Effect.asVoid,
    Effect.provide(FetchHttpClient.layer),
  )

export const readRuntimeJournalEvents = (
  streamUrl: string,
) =>
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: RuntimeJournalEventSchema,
  }).collect.pipe(
    Effect.provide(FetchHttpClient.layer),
  )

export const readUnknownDurableEvents = (
  streamUrl: string,
) =>
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: Schema.Unknown,
  }).collect.pipe(
    Effect.provide(FetchHttpClient.layer),
  )
