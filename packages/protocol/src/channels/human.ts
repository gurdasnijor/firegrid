import { Schema } from "effect"
import type {
  ChannelRegistration,
  ChannelTarget,
  EgressChannel,
  IngressChannel,
} from "./core.ts"
import { makeChannelTarget } from "./core.ts"

export const HumanHandleSchema = Schema.String.pipe(Schema.minLength(1))

export const HumanMessageSchema = Schema.Struct({
  handle: HumanHandleSchema,
  body: Schema.String,
  payload: Schema.optional(Schema.Unknown),
}).annotations({
  identifier: "firegrid.channel.human.message",
  title: "Human channel message",
})
export type HumanMessage = Schema.Schema.Type<typeof HumanMessageSchema>

export type HumanChannelKind = "dm" | "notification"

export interface HumanChannelPair<S extends Schema.Schema.Any> {
  readonly kind: HumanChannelKind
  readonly handle: string
  readonly target: ChannelTarget
  readonly ingress: IngressChannel<S>
  readonly egress: EgressChannel<S>
  readonly registrations: readonly [
    IngressChannel<S>,
    EgressChannel<S>,
  ]
}

export const humanChannelTarget = (
  kind: HumanChannelKind,
  handle: string,
): ChannelTarget =>
  makeChannelTarget(`${kind}.${Schema.decodeUnknownSync(HumanHandleSchema)(handle)}`)

export const humanChannelRegistrations = (
  channels: Iterable<HumanChannelPair<Schema.Schema.Any>>,
): ReadonlyArray<ChannelRegistration> =>
  Array.from(channels).flatMap(channel => channel.registrations)
