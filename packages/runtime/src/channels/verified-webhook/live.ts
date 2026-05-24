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
} from "../observation-streams/index.ts"
import {
  VerifiedWebhookFactTable,
  type VerifiedWebhookFactTableService,
} from "../../verified-webhook-ingest/index.ts"
import { Effect, Layer, Schema, Stream } from "effect"

// Relocated from the deleted host-sdk path
// `host-sdk/src/host/channels/verified-webhook/index.ts` (Class D
// channel-Lives relocation). Note: `CallerOwnedFactStreams` still lives
// at `channels/observation-streams/`; its retirement is the Wave-D-D
// `verified-webhook router-route` lane (PR #716 PARK) and is out of
// scope for this relocation.

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
