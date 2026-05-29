/**
 * composeConnector — wires a `ConnectorAdapter` onto the host HTTP router.
 *
 * `composeConnector(adapter)` produces a `Layer` whose requirement channel
 * declares the connector's external dependencies (`ExternalIngressAppender`
 * plus the host `HttpRouter.Default`). On Layer build the appender is
 * acquired once and closed over; each inbound request runs
 * `adapter.source(request) |> Stream.runForEach(adapter.journal)` with
 * the captured appender provided.
 *
 * `composition/host-live.ts` Layer-merges any number of connectors;
 * adding a new external adapter to the host is one wiring line.
 *
 * SDD #761 connectors/ revision, PR-M3.5 spike.
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Layer, Stream } from "effect"
import { ExternalIngressAppender } from "../capabilities/external-ingress-appender.ts"
import type { ConnectorAdapter } from "../events/connector-adapter.ts"

export const composeConnector = <Event, Fact>(
  adapter: ConnectorAdapter<Event, Fact>,
): Layer.Layer<never, never, ExternalIngressAppender | HttpRouter.HttpRouter.DefaultServices> =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      // Acquire the appender once at layer build; close over it for every
      // request. This keeps the per-request handler's R-channel limited to
      // `HttpRouter.Default`'s DefaultServices, which the router accepts.
      const appender = yield* ExternalIngressAppender
      return HttpRouter.Default.use((router) =>
        router.post(
          adapter.route.path,
          Effect.gen(function*() {
            const request = yield* HttpServerRequest.HttpServerRequest
            const sourceResult = yield* Effect.either(adapter.source(request))
            if (sourceResult._tag === "Left") {
              const error = sourceResult.left
              return HttpServerResponse.text(
                `${adapter.id}: ${error.op}: ${error.message}`,
                { status: 400 },
              )
            }
            const stream = sourceResult.right
            const journalResult = yield* Effect.either(
              stream.pipe(
                Stream.runForEach((event) =>
                  adapter.journal(event).pipe(
                    Effect.provideService(ExternalIngressAppender, appender),
                  )),
              ),
            )
            if (journalResult._tag === "Left") {
              const error = journalResult.left
              return HttpServerResponse.text(
                `${adapter.id}: ${error.op}: ${error.message}`,
                { status: 500 },
              )
            }
            return HttpServerResponse.empty({ status: 204 })
          }),
        ),
      )
    }),
  )
