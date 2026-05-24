/**
 * Runtime-side Tag for the host's bound Firegrid runtime-context MCP
 * server base address. Read by the codec session adapter
 * (`codec-adapter.ts:resolveEffectiveMcpServers`) to honor the URL-less
 * `runtimeContextMcp` marker on a materialized intent at start time.
 *
 * SINGLE-PURPOSE — DO NOT GENERALIZE. This Tag carries ONLY the bound
 * runtime-context MCP base URL (Option-typed). A `None` value with an
 * MCP-marked context is an explicit start failure, never a silent skip.
 * Carrying any other "host late-bound fact" through this Tag widens it
 * into the ambient-host-fact anti-pattern the host boundary doc forbids.
 *
 * Tag + binding mechanics
 * -----------------------
 * The Tag definition + the default `Live` (which constructs the
 * single-owner `Ref<Option.none>`) live here in runtime. Host-sdk
 * provides the binding side: `FiregridMcpServerLayer` calls
 * `publishRuntimeContextMcpBase` (host-sdk-owned, in
 * `packages/host-sdk/src/host/runtime-context-mcp-base-url.ts`) exactly
 * once on bind to write the OS-chosen address into the same Tag.
 *
 * Origin: moved from host-sdk in the tf-z8wq-follow runtime-session move
 * to keep the codec adapter (now under
 * `subscribers/runtime-context-session/`) from depending on a host-sdk
 * import. The HttpServer-coupled publish helper stays in host-sdk
 * because it depends on `@effect/platform` `HttpServer.addressFormatted`.
 */

import { HttpServer } from "@effect/platform"
import type { HttpRouter } from "@effect/platform"
import { Context, Effect, Layer, Option, Ref } from "effect"

const ensurePathInput = (path: HttpRouter.PathInput): string =>
  typeof path === "string" ? path : String(path)

/**
 * Build the route template for the runtime-context MCP server's
 * per-contextId mount point, given the host's configured MCP base path.
 *
 * Pure helper used both by the host-sdk MCP listener (to register the
 * route under that path on its bound `HttpServer`) and by the codec
 * session adapter (to construct the concrete contextId-scoped URL from
 * the host's bound `address` + `basePath`).
 */
export const runtimeContextMcpPath = (
  path: HttpRouter.PathInput,
): HttpRouter.PathInput => {
  if (path === "*") return "/runtime-context/:contextId"
  const basePath = ensurePathInput(path)
  const route = basePath.endsWith("/")
    ? `${basePath.slice(0, -1)}/runtime-context/:contextId`
    : `${basePath}/runtime-context/:contextId`
  return route as HttpRouter.PathInput
}

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
   * Host-internal. Only the host-sdk `FiregridMcpServerLayer` (the
   * single owner of the bound `HttpServer`) calls this, exactly once on
   * bind. Not for general host-fact publication.
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
 * Default construction site (Condition 2 / Condition 5). Defaults to
 * `None` so a host with the MCP listener disabled still composes
 * standalone; an MCP-marked context started on such a host fails
 * explicitly. There is no second construction site — this layer is the
 * sole owner of the one MCP-base `Ref`. The host-sdk-owned
 * `publishRuntimeContextMcpBase` (in
 * `packages/host-sdk/src/host/runtime-context-mcp-base-url.ts`) writes
 * into the same Ref when the host's bound `HttpServer` resolves.
 */
export const FiregridRuntimeContextMcpBaseUrlLive = Layer.effect(
  FiregridRuntimeContextMcpBaseUrl,
  Ref.make(Option.none<FiregridRuntimeContextMcpBase>()).pipe(
    Effect.map(ref => ({
      get: Ref.get(ref),
      publish: (base: FiregridRuntimeContextMcpBase) =>
        Ref.set(ref, Option.some(base)),
    })),
  ),
)

/**
 * Scoped publish step for `FiregridMcpServerLayer`. Reads the bound
 * `HttpServer` address (resolving the OS-chosen port when `port:0`) and
 * publishes it into the same single-purpose Tag consumed by the codec
 * session adapter.
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
