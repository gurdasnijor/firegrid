import { Context, Schema } from "effect"
import {
  makeChannelTarget,
  type CallableChannel,
  type ChannelTarget,
} from "./core.ts"

const NonEmptyStringSchema = Schema.String.pipe(Schema.minLength(1))

export const ExternalEffectCallChannelTarget: ChannelTarget =
  makeChannelTarget("external.effect.call")

export const ExternalEffectCallRequestSchema = Schema.Struct({
  effectId: NonEmptyStringSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(NonEmptyStringSchema),
  correlationId: Schema.optional(NonEmptyStringSchema),
}).annotations({
  identifier: "firegrid.channel.externalEffect.call.request",
  title: "External effect call request",
})
export type ExternalEffectCallRequest = Schema.Schema.Type<
  typeof ExternalEffectCallRequestSchema
>

export const ExternalEffectCallResponseSchema = Schema.Struct({
  effectId: NonEmptyStringSchema,
  status: Schema.Literal("completed"),
  output: Schema.Unknown,
  completedAt: NonEmptyStringSchema,
}).annotations({
  identifier: "firegrid.channel.externalEffect.call.response",
  title: "External effect call response",
})
export type ExternalEffectCallResponse = Schema.Schema.Type<
  typeof ExternalEffectCallResponseSchema
>

export type ExternalEffectCallChannelService = CallableChannel<
  typeof ExternalEffectCallRequestSchema,
  typeof ExternalEffectCallResponseSchema
>

export class ExternalEffectCallChannel extends Context.Tag(
  "firegrid/protocol/channels/external.effect.call",
)<ExternalEffectCallChannel, ExternalEffectCallChannelService>() {}
