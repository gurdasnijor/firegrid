// channelRouter() — typed declaration + derived string-keyed dispatch.
//
// Mirrors `SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md` §"Dispatch Contract":
//
//   type ChannelRouter<Routes> = {
//     routes: Routes
//     dispatch: {
//       waitFor(target, input): Effect<unknown, ChannelRouteError | ParseError>
//       send(target, payload):  Effect<unknown, ChannelRouteError | ParseError>
//       call(target, request):  Effect<unknown, ChannelRouteError | ParseError>
//     }
//   }
//
// The SDD §"Dispatch Observability" rule lives here too: every dispatch
// wraps the route in
//   firegrid.channel.dispatch { target, direction, verb }
// span. Edge adapters can add protocol-specific child spans on top.

import { Effect, type ParseResult, Schema, Stream } from "effect"
import {
  ChannelRouteNotFound,
  ChannelRouteVerbNotSupported,
  type ChannelContract,
  type ChannelRoute,
} from "./protocol.ts"

export interface ChannelRouter<
  Routes extends Record<string, ChannelRoute>,
> {
  readonly routes: Routes
  readonly dispatch: ChannelRouterDispatch
}

export interface ChannelRouterDispatch {
  readonly waitFor: (
    target: string,
    input: unknown,
  ) => Stream.Stream<unknown, unknown, never>
  readonly send: (
    target: string,
    payload: unknown,
  ) => Effect.Effect<unknown, unknown, never>
  readonly call: (
    target: string,
    request: unknown,
  ) => Effect.Effect<unknown, unknown, never>
}

export const channelRouter = <Routes extends Record<string, ChannelRoute>>(
  routes: Routes,
): ChannelRouter<Routes> => {
  const byTarget: ReadonlyMap<string, ChannelRoute> = new Map(
    Object.values(routes).map((route) => [
      route.contract.target as unknown as string,
      route,
    ]),
  )

  const lookup = (target: string): Effect.Effect<ChannelContract, ChannelRouteNotFound> => {
    const route = byTarget.get(target)
    if (route === undefined) {
      return Effect.fail(new ChannelRouteNotFound({ target }))
    }
    return Effect.succeed(route.contract)
  }

  const verbError = (target: string, direction: string, verb: string) =>
    Effect.fail(new ChannelRouteVerbNotSupported({ target, direction, verb }))

  return {
    routes,
    dispatch: {
      // wait_for is only legal for ingress (this sim does not model bidirectional).
      waitFor: (target, input) =>
        Stream.unwrap(
          Effect.gen(function*() {
            const contract = yield* lookup(target)
            if (contract.direction !== "ingress") {
              return Stream.fromEffect(
                verbError(target, contract.direction, "wait_for"),
              )
            }
            if (contract.binding._tag !== "TypedStream") {
              return Stream.fromEffect(
                verbError(target, contract.direction, "wait_for"),
              )
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- `Schema.Schema.AnyNoContext` resolves `Type` to `any`; the decode→binding handoff is the SDD's typed dispatch boundary (decoded value is the contract's declared input).
            const decoded = yield* Schema.decodeUnknown(contract.inputSchema)(input).pipe(
              Effect.mapError((cause: ParseResult.ParseError) => cause),
            )
            return contract.binding.stream(decoded).pipe(
              Stream.withSpan("firegrid.channel.dispatch", {
                attributes: {
                  "firegrid.channel.target": target,
                  "firegrid.channel.direction": contract.direction,
                  "firegrid.channel.verb": "wait_for",
                },
              }),
            )
          }),
        ),

      // send is legal for egress (this sim does not model bidirectional).
      send: (target, payload) =>
        Effect.gen(function*() {
          const contract = yield* lookup(target)
          if (contract.direction !== "egress") {
            return yield* verbError(target, contract.direction, "send")
          }
          if (contract.binding._tag !== "AppendTarget") {
            return yield* verbError(target, contract.direction, "send")
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- see waitFor decode comment.
          const decoded = yield* Schema.decodeUnknown(contract.inputSchema)(payload)
          return yield* contract.binding.append(decoded)
        }).pipe(
          Effect.withSpan("firegrid.channel.dispatch", {
            attributes: {
              "firegrid.channel.target": target,
              "firegrid.channel.verb": "send",
            },
          }),
        ),

      // call is only legal for call routes.
      call: (target, request) =>
        Effect.gen(function*() {
          const contract = yield* lookup(target)
          if (contract.direction !== "call") {
            return yield* verbError(target, contract.direction, "call")
          }
          if (contract.binding._tag !== "CallTarget") {
            return yield* verbError(target, contract.direction, "call")
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- see waitFor decode comment.
          const decoded = yield* Schema.decodeUnknown(contract.inputSchema)(request)
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- the call binding returns its declared Response.Type, but Schema.Schema.AnyNoContext resolves that to `any` at the dispatch boundary.
          return yield* contract.binding.call(decoded)
        }).pipe(
          Effect.withSpan("firegrid.channel.dispatch", {
            attributes: {
              "firegrid.channel.target": target,
              "firegrid.channel.direction": "call",
              "firegrid.channel.verb": "call",
            },
          }),
        ),
    },
  }
}
