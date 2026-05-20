import { Schema } from "effect"
import type { Effect, Stream } from "effect"
import {
  makeAfferentChannel,
  makeChannelTarget,
  makeEfferentChannel,
  type AfferentChannel,
  type ChannelRegistration,
  type ChannelTarget,
  type EfferentChannel,
} from "./channel-registry.ts"

const HumanHandleSchema = Schema.String.pipe(Schema.minLength(1))

export const HumanMessageSchema = Schema.Struct({
  handle: HumanHandleSchema,
  body: Schema.String,
  payload: Schema.optional(Schema.Unknown),
}).annotations({
  identifier: "firegrid.host.humanChannel.message",
  title: "Human channel message",
})
export type HumanMessage = Schema.Schema.Type<typeof HumanMessageSchema>

export type HumanChannelKind = "dm" | "notification"

export interface HumanChannelPair<S extends Schema.Schema.Any> {
  readonly kind: HumanChannelKind
  readonly handle: string
  readonly target: ChannelTarget
  readonly afferent: AfferentChannel<S>
  readonly efferent: EfferentChannel<S>
  readonly registrations: readonly [
    AfferentChannel<S>,
    EfferentChannel<S>,
  ]
}

export const humanChannelTarget = (
  kind: HumanChannelKind,
  handle: string,
): ChannelTarget =>
  makeChannelTarget(`${kind}.${Schema.decodeUnknownSync(HumanHandleSchema)(handle)}`)

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
  const afferent = makeAfferentChannel({
    target,
    schema: options.schema,
    stream: options.incoming,
  })
  const efferent = makeEfferentChannel({
    target,
    schema: options.schema,
    append: options.send,
  })
  return {
    kind: options.kind,
    handle: options.handle,
    target,
    afferent,
    efferent,
    registrations: [afferent, efferent],
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

export const humanChannelRegistrations = (
  channels: Iterable<HumanChannelPair<Schema.Schema.Any>>,
): ReadonlyArray<ChannelRegistration> =>
  Array.from(channels).flatMap(channel => channel.registrations)
