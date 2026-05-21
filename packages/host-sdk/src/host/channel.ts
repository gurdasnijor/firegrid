import { Context, Layer, Option, Schema } from "effect"
import type {
  ChannelRegistration,
  ChannelSourceClass,
  ChannelTarget,
} from "@firegrid/protocol/channels"
export {
  ChannelDirectionSchema,
  ChannelSourceClassSchema,
  ChannelTargetSchema,
  makeBidirectionalChannel,
  makeCallableChannel,
  makeChannelTarget,
  makeEgressChannel,
  makeIngressChannel,
  type AppendTargetBinding,
  type BidirectionalChannel,
  type CallableChannel,
  type CallTargetBinding,
  type ChannelDirection,
  type ChannelRegistration,
  type ChannelSourceClass,
  type ChannelTarget,
  type EgressChannel,
  type IngressChannel,
  type TypedStreamBinding,
} from "@firegrid/protocol/channels"

export const FactoryEventSchema = Schema.Struct({
  eventType: Schema.String,
  payload: Schema.Unknown,
})
export type FactoryEvent = Schema.Schema.Type<typeof FactoryEventSchema>

export class UnknownChannelTarget extends Schema.TaggedError<UnknownChannelTarget>()(
  "UnknownChannelTarget",
  {
    target: Schema.String,
  },
) {}

export interface ChannelInventoryService {
  readonly channels: ReadonlyArray<ChannelRegistration>
}

export class ChannelInventory extends Context.Tag(
  "firegrid/host-sdk/ChannelInventory",
)<ChannelInventory, ChannelInventoryService>() {}

export const makeChannelInventory = (
  channels: Iterable<ChannelRegistration>,
): ChannelInventoryService => ({
  channels: Array.from(channels),
})

export const ChannelInventoryLive = (
  channels: Iterable<ChannelRegistration> = [],
): Layer.Layer<ChannelInventory> =>
  Layer.succeed(ChannelInventory, makeChannelInventory(channels))

export const findChannel = (
  inventory: ChannelInventoryService,
  target: ChannelTarget | string,
): Option.Option<ChannelRegistration> => {
  const normalized = String(target)
  return Option.fromNullable(
    inventory.channels.find(channel => channel.target === normalized),
  )
}

export type ChannelMetadata =
  | {
    readonly target: ChannelTarget
    readonly direction: "ingress"
    readonly schema: Schema.Schema.Any
    readonly sourceClass?: ChannelSourceClass
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "egress"
    readonly schema: Schema.Schema.Any
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "bidirectional"
    readonly directions: readonly ["ingress", "egress"]
    readonly schema: Schema.Schema.Any
    readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "call"
    readonly requestSchema: Schema.Schema.Any
    readonly responseSchema: Schema.Schema.Any
  }

export const channelMetadata = (
  registration: ChannelRegistration,
): ChannelMetadata => {
  switch (registration.direction) {
    case "ingress":
      return {
        target: registration.target,
        direction: registration.direction,
        schema: registration.schema,
        ...(registration.sourceClass === undefined
          ? {}
          : { sourceClass: registration.sourceClass }),
      }
    case "egress":
      return {
        target: registration.target,
        direction: registration.direction,
        schema: registration.schema,
      }
    case "bidirectional":
      return {
        target: registration.target,
        direction: registration.direction,
        directions: registration.directions,
        schema: registration.schema,
        sourceClasses: registration.sourceClasses,
      }
    case "call":
      return {
        target: registration.target,
        direction: registration.direction,
        requestSchema: registration.requestSchema,
        responseSchema: registration.responseSchema,
      }
  }
}
