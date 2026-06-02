/**
 * Single-purpose host-owned URL channel for the runtime-context MCP server.
 *
 * The public launch config carries only `runtimeContextMcp: { enabled: true }`.
 * The concrete listener URL is host-owned and late-bound here after the MCP
 * server binds its OS-chosen port.
 */

import { HttpServer, type HttpRouter } from "@effect/platform"
import { Context, Effect, Layer, Option, Ref } from "effect"

export const ensurePathInput = (path: string): HttpRouter.PathInput => {
  if (path === "*") return path
  if (path.startsWith("/")) return path as HttpRouter.PathInput
  return `/${path}`
}

export const runtimeContextMcpPath = (
  path: HttpRouter.PathInput,
): HttpRouter.PathInput => {
  if (path === "*") return "/runtime-context/:contextId"
  const normalized = ensurePathInput(String(path)).replace(/\/+$/, "")
  return `${normalized}/runtime-context/:contextId` as HttpRouter.PathInput
}

export interface FiregridRuntimeContextMcpBase {
  readonly address: string
  readonly basePath: HttpRouter.PathInput
}

export interface FiregridRuntimeContextMcpBaseUrlService {
  readonly get: Effect.Effect<Option.Option<FiregridRuntimeContextMcpBase>>
  readonly publish: (base: FiregridRuntimeContextMcpBase) => Effect.Effect<void>
}

export class FiregridRuntimeContextMcpBaseUrl extends Context.Tag(
  "@firegrid/runtime/unified/FiregridRuntimeContextMcpBaseUrl",
)<FiregridRuntimeContextMcpBaseUrl, FiregridRuntimeContextMcpBaseUrlService>() {}

export const FiregridRuntimeContextMcpBaseUrlLive = Layer.effect(
  FiregridRuntimeContextMcpBaseUrl,
  Ref.make(Option.none<FiregridRuntimeContextMcpBase>()).pipe(
    Effect.map((ref) => ({
      get: Ref.get(ref),
      publish: (base: FiregridRuntimeContextMcpBase) =>
        Ref.set(ref, Option.some(base)),
    })),
  ),
)

export const runtimeContextMcpUrlForContext = (
  base: FiregridRuntimeContextMcpBase,
  contextId: string,
): string => {
  const route = String(runtimeContextMcpPath(base.basePath)).replace(
    ":contextId",
    encodeURIComponent(contextId),
  )
  return new URL(route, base.address).toString()
}

export const publishRuntimeContextMcpBase = (
  basePath: HttpRouter.PathInput,
): Effect.Effect<
  void,
  never,
  FiregridRuntimeContextMcpBaseUrl | HttpServer.HttpServer
> =>
  Effect.gen(function*() {
    const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
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
