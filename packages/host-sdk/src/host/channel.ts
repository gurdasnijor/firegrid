import type {
  ChannelRegistration,
  ChannelSourceClass,
  ChannelTarget,
} from "@firegrid/protocol/channels"
import { Context, Layer, Option, Schema } from "effect"

export class UnknownChannelTarget extends Schema.TaggedError<UnknownChannelTarget>()(
  "UnknownChannelTarget",
  {
    target: Schema.String,
  },
) {}

export interface RuntimeContextMcpChannelCatalogService {
  readonly channels: ReadonlyArray<ChannelRegistration>
}

export class RuntimeContextMcpChannelCatalog extends Context.Tag(
  "firegrid/host-sdk/RuntimeContextMcpChannelCatalog",
)<RuntimeContextMcpChannelCatalog, RuntimeContextMcpChannelCatalogService>() {}

export const makeRuntimeContextMcpChannelCatalog = (
  channels: Iterable<ChannelRegistration>,
): RuntimeContextMcpChannelCatalogService => ({
  channels: Array.from(channels),
})

export const RuntimeContextMcpChannelCatalogLive = (
  channels: Iterable<ChannelRegistration> = [],
): Layer.Layer<RuntimeContextMcpChannelCatalog> =>
  Layer.succeed(
    RuntimeContextMcpChannelCatalog,
    makeRuntimeContextMcpChannelCatalog(channels),
  )

export const findRuntimeContextMcpChannel = (
  catalog: RuntimeContextMcpChannelCatalogService,
  target: ChannelTarget | string,
): Option.Option<ChannelRegistration> => {
  const normalized = String(target)
  return Option.fromNullable(
    catalog.channels.find(channel => channel.target === normalized),
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
