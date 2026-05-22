import {
  ChannelRouteVerbNotSupported,
  ChannelRouteVerbSchema,
  UnknownChannelTarget,
  channelRouteDescriptor,
  findChannelRoute,
  makeChannelRouterDescriptor,
  type ChannelDispatchRequest,
  type ChannelRouteDescriptor,
  type ChannelRouteMetadata,
  type ChannelRouteVerb,
  type ChannelRouterDescriptor,
} from "@firegrid/protocol/channels/router"
import { acknowledgementCompletion } from "@firegrid/protocol/channels"
import type {
  BidirectionalChannel,
  CallableChannel,
  ChannelRegistration,
  ChannelTarget,
  EgressChannel,
  IngressChannel,
} from "@firegrid/protocol/channels"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { ParseResult } from "effect"

type RuntimeRouteSchema = Schema.Schema<unknown, unknown, never>

export class ChannelRouteInvocationFailed
  extends Schema.TaggedError<ChannelRouteInvocationFailed>()(
    "ChannelRouteInvocationFailed",
    {
      target: Schema.String,
      verb: ChannelRouteVerbSchema,
      cause: Schema.Unknown,
    },
  )
{}

export type RuntimeChannelDispatchError =
  | UnknownChannelTarget
  | ChannelRouteVerbNotSupported
  | ParseResult.ParseError
  | ChannelRouteInvocationFailed

export interface RuntimeChannelRoute<Success = unknown, Error = unknown> {
  readonly descriptor: ChannelRouteDescriptor
  readonly stream?: Stream.Stream<unknown, Error, never>
  readonly invoke: (
    payload: unknown,
    verb: ChannelRouteVerb,
  ) => Effect.Effect<Success, Error>
}

export interface RuntimeStreamBackedChannelRoute<
  Success = unknown,
  Error = unknown,
> extends RuntimeChannelRoute<Success, Error> {
  readonly stream: Stream.Stream<unknown, Error, never>
}

export interface RuntimeChannelRouterService<
  Routes extends ReadonlyArray<RuntimeChannelRoute> =
    ReadonlyArray<RuntimeChannelRoute>,
> {
  readonly descriptor: ChannelRouterDescriptor
  readonly metadata: ReadonlyArray<ChannelRouteMetadata>
  readonly route: (
    target: string,
  ) => Effect.Effect<Routes[number], UnknownChannelTarget>
  readonly dispatch: (
    request: ChannelDispatchRequest,
  ) => Effect.Effect<unknown, RuntimeChannelDispatchError>
}

/**
 * Generic runtime-context router used by host edges that expose agent tools.
 * It is the replacement surface for catalog-style channel registries.
 */
export class RuntimeChannelRouter extends Context.Tag(
  "firegrid/runtime/RuntimeChannelRouter",
)<RuntimeChannelRouter, RuntimeChannelRouterService>() {}

/**
 * Host-plane router for runtime-owned host-control routes. Host-sdk composes
 * this service at the edge; runtime owns the durable route implementations.
 */
export class HostPlaneChannelRouter extends Context.Tag(
  "firegrid/runtime/HostPlaneChannelRouter",
)<HostPlaneChannelRouter, RuntimeChannelRouterService>() {}

const supportsVerb = (
  descriptor: ChannelRouteDescriptor,
  verb: ChannelRouteVerb,
): boolean => descriptor.verbs.includes(verb)

const unsupportedVerb = (
  descriptor: ChannelRouteDescriptor,
  verb: ChannelRouteVerb,
) =>
  new ChannelRouteVerbNotSupported({
    target: String(descriptor.target),
    verb,
    direction: descriptor.direction,
    supportedVerbs: [...descriptor.verbs],
  })

const decodeRoutePayload = (
  route: RuntimeChannelRoute,
  payload: unknown,
) =>
  Schema.decodeUnknown(
    route.descriptor.inputSchema as RuntimeRouteSchema,
  )(payload)

const invocationFailed = (
  descriptor: ChannelRouteDescriptor,
  verb: ChannelRouteVerb,
  cause: unknown,
) =>
  new ChannelRouteInvocationFailed({
    target: String(descriptor.target),
    verb,
    cause,
  })

export const makeRuntimeChannelRouter = <
  const Routes extends ReadonlyArray<RuntimeChannelRoute>,
>(
  routes: Routes,
): RuntimeChannelRouterService<Routes> => {
  const descriptor = makeChannelRouterDescriptor(
    routes.map(route => route.descriptor),
  )
  const routeByTarget = new Map(
    routes.map(route => [route.descriptor.target, route] as const),
  )

  const route = (
    target: string,
  ): Effect.Effect<Routes[number], UnknownChannelTarget> =>
    Option.match(
      findChannelRoute(descriptor, target).pipe(
        Option.flatMap(routeDescriptor =>
          Option.fromNullable(routeByTarget.get(routeDescriptor.target))),
      ),
      {
        onNone: () =>
          Effect.fail(new UnknownChannelTarget({ target })),
        onSome: route => Effect.succeed(route),
      },
    )

  const dispatch = (
    request: ChannelDispatchRequest,
  ): Effect.Effect<unknown, RuntimeChannelDispatchError> =>
    route(String(request.target)).pipe(
      Effect.flatMap((matched): Effect.Effect<
        unknown,
        | ChannelRouteVerbNotSupported
        | ParseResult.ParseError
        | ChannelRouteInvocationFailed
      > => {
        if (!supportsVerb(matched.descriptor, request.verb)) {
          return Effect.fail(unsupportedVerb(matched.descriptor, request.verb))
        }
        return Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            "firegrid.channel.direction": matched.descriptor.direction,
          })
          const payload = yield* decodeRoutePayload(matched, request.payload)
          return yield* matched.invoke(payload, request.verb).pipe(
            Effect.mapError(cause =>
              invocationFailed(matched.descriptor, request.verb, cause)),
          )
        })
      }),
      Effect.withSpan("firegrid.channel.dispatch", {
        kind: "internal",
        attributes: {
          "firegrid.channel.target": String(request.target),
          "firegrid.channel.verb": request.verb,
        },
      }),
    )
  return {
    descriptor,
    metadata: descriptor.metadata,
    route,
    dispatch,
  }
}

export const RuntimeChannelRouterLive = (
  routes: ReadonlyArray<RuntimeChannelRoute> = [],
): Layer.Layer<RuntimeChannelRouter> =>
  Layer.succeed(RuntimeChannelRouter, makeRuntimeChannelRouter(routes))

export const HostPlaneChannelRouterLive = (
  routes: ReadonlyArray<RuntimeChannelRoute> = [],
): Layer.Layer<HostPlaneChannelRouter> =>
  Layer.succeed(HostPlaneChannelRouter, makeRuntimeChannelRouter(routes))

const appendEgressPayload = <S extends Schema.Schema.Any>(
  channel: EgressChannel<S> | BidirectionalChannel<S>,
  payload: Schema.Schema.Type<S>,
) => channel.binding.append(payload)

const runHeadOrNever = <A>(
  stream: Stream.Stream<A, unknown, never>,
): Effect.Effect<A, unknown, never> =>
  stream.pipe(
    Stream.runHead,
    Effect.flatMap(Option.match({
      onNone: () => Effect.never,
      onSome: row => Effect.succeed(row),
    })),
  )

const waitForIngressRow = <S extends Schema.Schema.Any>(
  channel: IngressChannel<S> | BidirectionalChannel<S>,
): Effect.Effect<Schema.Schema.Type<S>, unknown, never> =>
  runHeadOrNever(channel.binding.stream)

export const runtimeRouteFromChannel = (
  channel: ChannelRegistration,
): RuntimeChannelRoute<unknown, unknown> => {
  const stream = channel.direction === "ingress" ||
      channel.direction === "bidirectional"
    ? channel.binding.stream as Stream.Stream<unknown, unknown, never>
    : undefined
  return {
    descriptor: channelRouteDescriptor(channel),
    ...(stream === undefined ? {} : { stream }),
    invoke: (payload, verb) => {
      switch (channel.direction) {
        case "egress":
          return appendEgressPayload(channel, payload)
        case "bidirectional":
          return verb === "send"
            ? appendEgressPayload(channel, payload)
            : waitForIngressRow(channel)
        case "call":
          return (channel as CallableChannel<RuntimeRouteSchema, RuntimeRouteSchema>)
            .binding.call(payload)
        case "ingress":
          return waitForIngressRow(channel as IngressChannel<RuntimeRouteSchema>)
      }
    },
  }
}

export const runtimeRouteFromFactoryChannel = <
  Field extends string,
  FactoryInput extends Record<Field, unknown>,
  S extends Schema.Schema.Any,
  Success,
>(options: {
  readonly target: ChannelTarget
  readonly field: Field
  readonly inputSchema: Schema.Schema<FactoryInput, FactoryInput, never>
  readonly channel: (
    value: FactoryInput[Field],
  ) => EgressChannel<S, Success>
  readonly payload: (input: FactoryInput) => Schema.Schema.Type<S>
}): RuntimeChannelRoute<Success, unknown> => ({
  descriptor: {
    target: options.target,
    direction: "egress",
    verbs: ["send"],
    inputSchema: options.inputSchema,
    metadata: {
      target: options.target,
      direction: "egress",
      verbs: ["send"],
      schema: {
        direction: "egress",
        schema: options.inputSchema,
      },
      completion: acknowledgementCompletion,
    },
  },
  invoke: input => {
    const request = input as FactoryInput
    return options.channel(request[options.field]).binding.append(
      options.payload(request),
    )
  },
})

/**
 * Ingress analogue of {@link runtimeRouteFromFactoryChannel}: a factory-keyed
 * READ route. The route input carries the key field (e.g. `sessionId`) plus a
 * cursor; `channel(key)` resolves the per-key ingress channel and the optional
 * `seek` predicate seeds the stream past the cursor before taking the next row.
 *
 * Used to express per-session observation (e.g. delegated child-output) over an
 * existing per-session `IngressChannel` instead of a parallel read protocol.
 * Parent→child authority belongs at this route boundary: the `channel` resolver
 * is where an authorization check (e.g. a durable parent-child link) is applied
 * before a key is observable.
 */
export const runtimeRouteFromFactoryIngressChannel = <
  Field extends string,
  FactoryInput extends Record<Field, unknown>,
  S extends Schema.Schema.Any,
>(options: {
  readonly target: ChannelTarget
  readonly field: Field
  readonly inputSchema: Schema.Schema<FactoryInput, FactoryInput, never>
  readonly channel: (value: FactoryInput[Field]) => IngressChannel<S>
  readonly seek?: (
    input: FactoryInput,
  ) => (row: Schema.Schema.Type<S>) => boolean
}): RuntimeChannelRoute<Schema.Schema.Type<S>, unknown> => ({
  descriptor: {
    target: options.target,
    direction: "ingress",
    verbs: ["wait_for"],
    inputSchema: options.inputSchema,
    metadata: {
      target: options.target,
      direction: "ingress",
      verbs: ["wait_for"],
      schema: {
        direction: "ingress",
        schema: options.inputSchema,
      },
      completion: acknowledgementCompletion,
    },
  },
  invoke: input => {
    const request = input as FactoryInput
    const channel = options.channel(request[options.field])
    const predicate = options.seek?.(request)
    const source = predicate === undefined
      ? channel.binding.stream
      : channel.binding.stream.pipe(Stream.filter(predicate))
    return runHeadOrNever(source)
  },
})

export const runtimeRoutesFromChannels = (
  channels: Iterable<ChannelRegistration>,
): ReadonlyArray<RuntimeChannelRoute> =>
  Array.from(channels, runtimeRouteFromChannel)
