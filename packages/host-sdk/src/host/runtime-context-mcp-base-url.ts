/**
 * TFIND-048 (SDD_MCP_ROUTE_URL_LIFECYCLE Amendment 1 §A1.1):
 * single-purpose host late-bind of the Firegrid runtime-context MCP
 * server's bound base address.
 *
 * SINGLE-PURPOSE — DO NOT GENERALIZE. This service carries ONLY the
 * runtime-context MCP base URL (Option-typed). It is deliberately NOT a
 * generic "host late-bound fact" channel / host-fact bus: a generic
 * Deferred/SubscriptionRef-of-arbitrary-host-fact would turn a
 * single-purpose primitive into an ambient one (the ambient-leak
 * anti-pattern). The value type, the tag name, and `publish`'s single
 * caller (`FiregridMcpServerLayer`, which owns the bound `HttpServer`)
 * keep it structurally hard for any future consumer to reach through
 * this for some other host-owned fact. If another host fact ever needs
 * late-binding, add its OWN single-purpose primitive — do not widen
 * this one.
 *
 * Why this exists: in the only supported host topology the MCP listener
 * (`FiregridMcpServerLayer`, "A") is `Layer.provideMerge`'d with the
 * runtime host ("B") that builds the reconciler / host-scoped RuntimeContext engine.
 * Process co-location is guaranteed, but `A`'s bound `HttpServer`
 * (including the OS-chosen port when `port:0`) is NOT in `B`'s
 * construction scope. This service is the single-owner channel by which
 * the host late-binds its OWN bound MCP address to its OWN start path —
 * never a client prediction. Host-scoped only: this tag must never
 * appear on a client-surface type.
 */

import { HttpServer } from "@effect/platform"
import type { HttpRouter } from "@effect/platform"
import { Context, Effect, Layer, Option, Ref } from "effect"

/**
 * The host's own bound runtime-context MCP listener address. `address`
 * is the formatted origin (e.g. `http://127.0.0.1:54321`, with the
 * OS-chosen port already resolved); `basePath` is the configured MCP
 * base path the route template is appended to.
 */
export interface FiregridRuntimeContextMcpBase {
  readonly address: string
  readonly basePath: HttpRouter.PathInput
}

interface FiregridRuntimeContextMcpBaseUrlService {
  /**
   * The host's bound runtime-context MCP base, or `None` when no MCP
   * listener is mounted in this host. A `None` here with an MCP-marked
   * context is an explicit start failure, never a silent skip.
   */
  readonly get: Effect.Effect<Option.Option<FiregridRuntimeContextMcpBase>>
  /**
   * Host-internal. Only `FiregridMcpServerLayer` (the single owner of
   * the bound `HttpServer`) calls this, exactly once on bind. Not for
   * general host-fact publication.
   */
  readonly publish: (
    base: FiregridRuntimeContextMcpBase,
  ) => Effect.Effect<void>
}

export class FiregridRuntimeContextMcpBaseUrl extends Context.Tag(
  "@firegrid/host/FiregridRuntimeContextMcpBaseUrl",
)<
  FiregridRuntimeContextMcpBaseUrl,
  FiregridRuntimeContextMcpBaseUrlService
>() {}

/**
 * The single construction site of the late-bind primitive
 * (Condition 2 / Condition 5). Defaults to `None` so a host with the
 * MCP listener disabled still composes standalone; an MCP-marked
 * context started on such a host fails explicitly at start. There is no
 * second construction site and no generic primitive — this layer is the
 * sole owner of the one MCP-base `Ref`.
 */
export const FiregridRuntimeContextMcpBaseUrlLive = Layer.effect(
  FiregridRuntimeContextMcpBaseUrl,
  Effect.gen(function* () {
    const ref = yield* Ref.make(
      Option.none<FiregridRuntimeContextMcpBase>(),
    )
    return {
      get: Ref.get(ref),
      publish: (base) => Ref.set(ref, Option.some(base)),
    }
  }),
)

/**
 * Scoped publish step for `FiregridMcpServerLayer`. Reads the bound
 * `HttpServer` address (resolving the OS-chosen port when `port:0`) and
 * the single-owner base service, then publishes once on bind. This is
 * the host writing its OWN bound address into its OWN single-purpose
 * channel.
 */
export const publishRuntimeContextMcpBase = (
  basePath: HttpRouter.PathInput,
): Effect.Effect<
  void,
  never,
  HttpServer.HttpServer | FiregridRuntimeContextMcpBaseUrl
> =>
  Effect.gen(function* () {
    const address = yield* HttpServer.addressFormattedWith((addr) =>
      Effect.succeed(addr),
    )
    const service = yield* FiregridRuntimeContextMcpBaseUrl
    yield* service.publish({ address, basePath }).pipe(
      Effect.withSpan("firegrid.mcp.publish_runtime_context_base", {
        kind: "server",
        attributes: {
          "firegrid.mcp.bound_address": address,
          "firegrid.mcp.path": String(basePath),
        },
      }),
    )
  })
