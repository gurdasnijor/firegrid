import type {
  ChannelRegistration,
  ChannelSourceClass,
  ChannelTarget,
} from "@firegrid/protocol/channels"
import {
  UnknownChannelTarget,
} from "@firegrid/protocol/channels/router"
import {
  RuntimeChannelRouter,
  RuntimeChannelRouterLive,
  makeRuntimeChannelRouter,
  runtimeRoutesFromChannels,
  type RuntimeChannelRouterService,
} from "@firegrid/runtime/channels"
import { Context, Layer, Option, type Schema } from "effect"

export { UnknownChannelTarget }
export {
  RuntimeChannelRouter,
  type RuntimeChannelRouterService,
} from "@firegrid/runtime/channels"

/**
 * @deprecated Use RuntimeChannelRouter / RuntimeChannelRouterService. This
 * catalog survives only as a migration shim for legacy tests and external
 * callers; production host-edge routing is router-backed.
 */
export interface RuntimeContextMcpChannelCatalogService {
  readonly channels: ReadonlyArray<ChannelRegistration>
}

/**
 * @deprecated Use RuntimeChannelRouter. Remaining catalog call sites are
 * compatibility-only and must not grow.
 */
export class RuntimeContextMcpChannelCatalog extends Context.Tag(
  "firegrid/host-sdk/RuntimeContextMcpChannelCatalog",
)<RuntimeContextMcpChannelCatalog, RuntimeContextMcpChannelCatalogService>() {}

/** @deprecated Use makeRuntimeContextChannelRouter. */
export const makeRuntimeContextMcpChannelCatalog = (
  channels: Iterable<ChannelRegistration>,
): RuntimeContextMcpChannelCatalogService => ({
  channels: Array.from(channels),
})

/** @deprecated Use RuntimeContextChannelRouterLive. */
export const RuntimeContextMcpChannelCatalogLive = (
  channels: Iterable<ChannelRegistration> = [],
): Layer.Layer<RuntimeContextMcpChannelCatalog | RuntimeChannelRouter> => {
  const registrations = Array.from(channels)
  return Layer.mergeAll(
    Layer.succeed(
      RuntimeContextMcpChannelCatalog,
      makeRuntimeContextMcpChannelCatalog(registrations),
    ),
    Layer.succeed(
      RuntimeChannelRouter,
      makeRuntimeContextChannelRouter(registrations),
    ),
  )
}

export const makeRuntimeContextChannelRouter = (
  channels: Iterable<ChannelRegistration>,
): RuntimeChannelRouterService =>
  makeRuntimeChannelRouter(runtimeRoutesFromChannels(channels))

export const RuntimeContextChannelRouterLive = (
  channels: Iterable<ChannelRegistration> = [],
): Layer.Layer<RuntimeChannelRouter> =>
  RuntimeChannelRouterLive(runtimeRoutesFromChannels(channels))

/** @deprecated Use RuntimeChannelRouter.route. */
export const findRuntimeContextMcpChannel = (
  catalog: RuntimeContextMcpChannelCatalogService,
  target: ChannelTarget | string,
): Option.Option<ChannelRegistration> => {
  const normalized = String(target)
  return Option.fromNullable(
    catalog.channels.find(channel => channel.target === normalized),
  )
}

/**
 * @deprecated ChannelRouteMetadata from @firegrid/protocol/channels/router is
 * the canonical router metadata shape. This legacy flattened shape remains for
 * tests and old host-sdk callers during the catalog burn-down.
 */
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
