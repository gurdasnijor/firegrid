import type { Effect, Stream } from "effect"
import {
  makeIngressChannel,
  makeEgressChannel,
  makeChannelTarget,
  type ChannelTarget,
  type HumanChannelKind,
  type HumanChannelPair,
  HumanMessageSchema,
  humanChannelTarget,
  type HumanMessage,
} from "@firegrid/protocol/channels"
import type { Schema } from "effect"

export const humanChannelPair = <S extends Schema.Schema.Any>(
  options: {
    readonly kind: HumanChannelKind
    readonly handle: string
    readonly target?: ChannelTarget | string
    readonly schema: S
    readonly incoming: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
    readonly send: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  },
): HumanChannelPair<S> => {
  const target = options.target === undefined
    ? humanChannelTarget(options.kind, options.handle)
    : typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target
  const ingress = makeIngressChannel({
    target,
    schema: options.schema,
    stream: options.incoming,
  })
  const egress = makeEgressChannel({
    target,
    schema: options.schema,
    append: options.send,
  })
  return {
    kind: options.kind,
    handle: options.handle,
    target,
    ingress,
    egress,
    registrations: [ingress, egress],
  }
}

interface HumanMessageChannelOptions {
  readonly handle: string
  readonly target?: ChannelTarget | string
  readonly incoming: Stream.Stream<HumanMessage, unknown, never>
  readonly send: (payload: HumanMessage) => Effect.Effect<void, unknown, never>
}

const humanMessageChannel = (
  kind: HumanChannelKind,
  options: HumanMessageChannelOptions,
): HumanChannelPair<typeof HumanMessageSchema> =>
  humanChannelPair({
    kind,
    handle: options.handle,
    ...(options.target === undefined ? {} : { target: options.target }),
    schema: HumanMessageSchema,
    incoming: options.incoming,
    send: options.send,
  })

export const dmChannel = (
  options: HumanMessageChannelOptions,
): HumanChannelPair<typeof HumanMessageSchema> =>
  humanMessageChannel("dm", options)

export const notificationChannel = (
  options: HumanMessageChannelOptions,
): HumanChannelPair<typeof HumanMessageSchema> =>
  humanMessageChannel("notification", options)
