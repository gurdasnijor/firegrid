import { Option, Schema } from "effect"
import { acknowledgementCompletion } from "./core.ts"
import type {
  ChannelDirection,
  ChannelRegistration,
  ChannelRouteCompletion,
  ChannelSourceClass,
  ChannelTarget,
} from "./core.ts"

export const ChannelRouteVerbSchema = Schema.Literal(
  "send",
  "wait_for",
  "call",
)
export type ChannelRouteVerb = Schema.Schema.Type<
  typeof ChannelRouteVerbSchema
>

export const channelRouteVerbsForDirection = (
  direction: ChannelDirection,
): ReadonlyArray<ChannelRouteVerb> => {
  switch (direction) {
    case "ingress":
      return ["wait_for"]
    case "egress":
      return ["send"]
    case "call":
      return ["call"]
    case "bidirectional":
      return ["send", "wait_for"]
  }
}


/**
 * Wire-safe projection of registration schema metadata. It carries the schema
 * contract but none of the runtime bindings that implement the route.
 */
export type ChannelRouteSchemaMetadata =
  | {
    readonly direction: "ingress"
    readonly schema: Schema.Schema.Any
    readonly sourceClass?: ChannelSourceClass
  }
  | {
    readonly direction: "egress"
    readonly schema: Schema.Schema.Any
  }
  | {
    readonly direction: "bidirectional"
    readonly directions: readonly ["ingress", "egress"]
    readonly schema: Schema.Schema.Any
    readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
  }
  | {
    readonly direction: "call"
    readonly requestSchema: Schema.Schema.Any
    readonly responseSchema: Schema.Schema.Any
  }

export interface ChannelRouteMetadata {
  readonly target: ChannelTarget
  readonly direction: ChannelDirection
  readonly verbs: ReadonlyArray<ChannelRouteVerb>
  readonly schema: ChannelRouteSchemaMetadata
  readonly completion: ChannelRouteCompletion
  readonly description?: string
  readonly title?: string
}

export interface ChannelRouteDescriptor {
  readonly target: ChannelTarget
  readonly direction: ChannelDirection
  readonly verbs: ReadonlyArray<ChannelRouteVerb>
  readonly inputSchema: Schema.Schema.Any
  readonly responseSchema?: Schema.Schema.Any
  readonly metadata: ChannelRouteMetadata
}

export interface ChannelRouterDescriptor<
  Routes extends ReadonlyArray<ChannelRouteDescriptor> =
    ReadonlyArray<ChannelRouteDescriptor>,
> {
  readonly routes: Routes
  readonly metadata: ReadonlyArray<ChannelRouteMetadata>
}

export interface ChannelDispatchRequest {
  readonly target: ChannelTarget | string
  readonly verb: ChannelRouteVerb
  readonly payload?: unknown
}

export class UnknownChannelTarget extends Schema.TaggedError<UnknownChannelTarget>()(
  "UnknownChannelTarget",
  {
    target: Schema.String,
  },
) {}

export class ChannelRouteVerbNotSupported
  extends Schema.TaggedError<ChannelRouteVerbNotSupported>()(
    "ChannelRouteVerbNotSupported",
    {
      target: Schema.String,
      verb: ChannelRouteVerbSchema,
      direction: Schema.String,
      supportedVerbs: Schema.Array(ChannelRouteVerbSchema),
    },
  )
{}

export const channelRouteSchemaMetadata = (
  registration: ChannelRegistration,
): ChannelRouteSchemaMetadata => {
  switch (registration.direction) {
    case "ingress":
      return {
        direction: registration.direction,
        schema: registration.schema,
        ...(registration.sourceClass === undefined
          ? {}
          : { sourceClass: registration.sourceClass }),
      }
    case "egress":
      return {
        direction: registration.direction,
        schema: registration.schema,
      }
    case "bidirectional":
      return {
        direction: registration.direction,
        directions: registration.directions,
        schema: registration.schema,
        sourceClasses: registration.sourceClasses,
      }
    case "call":
      return {
        direction: registration.direction,
        requestSchema: registration.requestSchema,
        responseSchema: registration.responseSchema,
      }
  }
}

export const channelRouteMetadata = (
  registration: ChannelRegistration,
): ChannelRouteMetadata => ({
  target: registration.target,
  direction: registration.direction,
  verbs: channelRouteVerbsForDirection(registration.direction),
  schema: channelRouteSchemaMetadata(registration),
  // Completion defaults to `acknowledgement`: a route's dispatch result is an
  // append/identity receipt unless it declares terminal completion evidence.
  // Terminal opt-in (e.g. ACP prompt completion) binds with the workflow-owned
  // durable output/result row — see tf-r6br STOP/report (gated on tf-aseo).
  completion: registration.completion ?? acknowledgementCompletion,
})

export const channelRouteDescriptor = (
  registration: ChannelRegistration,
): ChannelRouteDescriptor => ({
  target: registration.target,
  direction: registration.direction,
  verbs: channelRouteVerbsForDirection(registration.direction),
  inputSchema: registration.direction === "call"
    ? registration.requestSchema
    : registration.schema,
  ...(registration.direction === "call"
    ? { responseSchema: registration.responseSchema }
    : {}),
  metadata: channelRouteMetadata(registration),
})

export const makeChannelRouterDescriptor = <
  const Routes extends ReadonlyArray<ChannelRouteDescriptor>,
>(
  routes: Routes,
): ChannelRouterDescriptor<Routes> => ({
  routes,
  metadata: routes.map(route => route.metadata),
})

export const findChannelRoute = (
  descriptor: ChannelRouterDescriptor,
  target: ChannelTarget | string,
): Option.Option<ChannelRouteDescriptor> => {
  const normalized = String(target)
  return Option.fromNullable(
    descriptor.routes.find(route => route.target === normalized),
  )
}
