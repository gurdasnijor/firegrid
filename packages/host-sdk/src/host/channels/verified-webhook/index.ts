import {
  VerifiedWebhookFactChannel,
  VerifiedWebhookFactChannelTarget,
  makeIngressChannel,
  type ChannelTarget,
  type IngressChannel,
} from "@firegrid/protocol/channels"
import {
  VerifiedWebhookFactSchema,
} from "@firegrid/protocol/verified-webhook"
import {
  CallerOwnedFactStreams,
} from "@firegrid/runtime/streams"
import {
  VerifiedWebhookFactTable,
  type VerifiedWebhookFactTableService,
} from "@firegrid/runtime/verified-webhook-ingest"
import { Effect, Layer, Schema, Stream } from "effect"

export const verifiedWebhookFactRows = <S extends Schema.Schema.AnyNoContext>(
  table: VerifiedWebhookFactTableService,
  schema: S,
): Stream.Stream<Schema.Schema.Type<S>, unknown, never> =>
  (table.verifiedWebhookFacts.rows() as Stream.Stream<unknown, unknown, never>)
    .pipe(
      Stream.filterMap(Schema.decodeUnknownOption(schema)),
    ) as Stream.Stream<Schema.Schema.Type<S>, unknown, never>

export const verifiedWebhookFactChannel = <S extends Schema.Schema.AnyNoContext>(
  table: VerifiedWebhookFactTableService,
  options: {
    readonly schema: S
    readonly target?: ChannelTarget | string
  },
): IngressChannel<S> =>
  makeIngressChannel({
    target: options.target ?? VerifiedWebhookFactChannelTarget,
    schema: options.schema,
    sourceClass: "static-source",
    stream: verifiedWebhookFactRows(table, options.schema).pipe(
      Stream.withSpan("firegrid.host.channel.verified_webhook", {
        kind: "internal",
      }),
    ),
  })

export const VerifiedWebhookFactChannelLive = Layer.effect(
  VerifiedWebhookFactChannel,
  Effect.gen(function*() {
    const table = yield* VerifiedWebhookFactTable
    return verifiedWebhookFactChannel(table, {
      schema: VerifiedWebhookFactSchema,
    })
  }),
)

export const VerifiedWebhookFactCallerOwnedFactStreamsLive: Layer.Layer<
  CallerOwnedFactStreams,
  never,
  VerifiedWebhookFactChannel
> =
  Layer.effect(
    CallerOwnedFactStreams,
    Effect.gen(function*() {
      const channel = yield* VerifiedWebhookFactChannel
      return CallerOwnedFactStreams.of({
        streamFor: stream =>
          stream === String(channel.target)
            ? channel.binding.stream
            : Stream.empty,
      })
    }),
  )
