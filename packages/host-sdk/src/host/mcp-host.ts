/**
 * Host-owned localhost MCP server for the Firegrid agent toolkit.
 *
 * Composes `@effect/ai/McpServer.layerHttp` and
 * `McpServer.registerToolkit(FiregridAgentToolkit)` directly behind an
 * `@effect/platform-node/NodeHttpServer` bound to a loopback host. The
 * MCP HTTP listener is an Effect Layer in the host process's scope; it
 * starts and stops with `NodeRuntime.runMain`. There is no separate
 * `firegrid:mcp` binary, no stdio shim, no supervisor protocol, no
 * custom MCP router, no wrapper toolkit, no manual `tools/list` or
 * `tools/call` handler.
 *
 * Implements (SDD):
 *  - SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"V1: Host-Owned Localhost MCP Server"
 *
 * Implements (feature spec):
 *  - firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.1..11
 *  - firegrid-workflow-driven-runtime.VALIDATION.5
 *  - firegrid-host-sdk.MCP_AND_TOOLS.4
 *
 * Runtime-context routing scope:
 *  The listener mounts Effect AI's MCP HTTP protocol at
 *  `/mcp/runtime-context/:contextId`. The route parameter is the
 *  request authority; it is not an env var and not a tool argument.
 *  Tool calls resolve that route value through the runtime-owned
 *  `RuntimeLocalContextResolver` capability before any workflow, sandbox,
 *  or host tool service is touched.
 */

import { IdGenerator, McpServer } from "@effect/ai"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { ContextNotFound } from "@firegrid/protocol/launch"
import {
  RuntimeLocalContextResolver,
} from "@firegrid/runtime/control-plane"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { Config, Effect, Layer, Logger, Option } from "effect"
// The MCP HTTP server lifetime is Effect-owned via Layer.scopedDiscard
// + McpServer.layerHttp + NodeHttpServer.layer and bound only to
// loopback; `createServer` is the documented listener factory the
// @effect/platform-node `NodeHttpServer.layer(createServer, ...)`
// example accepts. Not a raw/custom HTTP server.
// durable-lint-allow-control-plane: @effect/platform-node NodeHttpServer.layer listener factory
import { createServer } from "node:http"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
} from "../agent-tools/index.ts"
import {
  enrichRuntimeContextMcpToolsListWithChannelMetadata,
} from "./mcp-channel-metadata.ts"
import {
  publishRuntimeContextMcpBase,
} from "./runtime-context-mcp-base-url.ts"

const runtimeContextMcpRouterMaxParamLength = 4096

/**
 * Effect Config for the host-owned MCP HTTP server's listener
 * topology. Process/listener knobs only — no runtime identity.
 *
 * Defaults bind only to loopback (`127.0.0.1`) on an OS-chosen port
 * (`0`) under `/mcp`, and the server is OPT-IN — `FIREGRID_MCP_ENABLED`
 * defaults to `false` so existing host deployments are unaffected.
 *
 * The runtime `contextId` is durable/session state, not host-process
 * env. MCP clients connect to `/mcp/runtime-context/:contextId`; the
 * route value scopes execution authority without changing the tool
 * catalog.
 *
 * The durable-streams base URL and runtime namespace are reused from
 * `RuntimeHostTopologyFromConfig` at the caller. Durable-tools stream
 * routing is derived from `CurrentHostSession` and protocol authority
 * helpers alongside the runtime/workflow URLs the host already mounts.
 */
export const FiregridMcpServerListenerConfig = Config.all({
  enabled: Config.boolean("FIREGRID_MCP_ENABLED").pipe(
    Config.withDefault(false),
  ),
  host: Config.string("FIREGRID_MCP_HOST").pipe(
    Config.withDefault("127.0.0.1"),
  ),
  port: Config.integer("FIREGRID_MCP_PORT").pipe(Config.withDefault(0)),
  path: Config.string("FIREGRID_MCP_PATH").pipe(Config.withDefault("/mcp")),
})

export type FiregridMcpServerListenerConfig = Config.Config.Success<
  typeof FiregridMcpServerListenerConfig
>

export interface FiregridMcpServerLayerOptions {
  readonly host: string
  readonly port: number
  /**
   * Base MCP path. The runtime context route is always appended as
   * `/runtime-context/:contextId`. Passing `*` means "mount without a
   * configured base prefix"; it is not a catch-all route.
   */
  readonly path: HttpRouter.PathInput
}

export const runtimeContextMcpPath = (
  path: HttpRouter.PathInput,
): HttpRouter.PathInput => {
  if (path === "*") return "/runtime-context/:contextId"
  const normalized = ensurePathInput(path).replace(/\/+$/, "")
  return `${normalized}/runtime-context/:contextId` as HttpRouter.PathInput
}

const FiregridMcpRouteContextLayer = Layer.effect(
  FiregridAgentToolContext,
  Effect.gen(function* () {
    // Capture only the runtime-owned local-context resolver here.
    // `HttpRouter.params` is
    // intentionally read inside `resolve`, so Effect AI's request
    // fiber supplies the current `/runtime-context/:contextId` route
    // parameter for each tools/call instead of memoizing one context
    // into the shared MCP server layer.
    const localContextResolver = yield* RuntimeLocalContextResolver
    return {
      // firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1
      // firegrid-host-context-authority.MCP_CONTEXT_ROUTING.3
      // firegrid-host-sdk.MCP_AND_TOOLS.4
      resolve: Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const contextId = yield* Option.match(Option.fromNullable(params.contextId), {
          onNone: () =>
            Effect.fail(new ContextNotFound({ contextId: "<missing-mcp-route-context>" })),
          onSome: Effect.succeed,
        })
        const runtimeContext = yield* localContextResolver.requireLocalContext(contextId)
        yield* Effect.annotateCurrentSpan({
          "firegrid.context.id": contextId,
          "firegrid.runtime.agent": runtimeContext.runtime.config.agent ?? "",
          "firegrid.runtime.agent_protocol": runtimeContext.runtime.config.agentProtocol ?? "",
        })
        return { contextId, runtimeContext }
      }).pipe(
        Effect.withSpan("firegrid.mcp.runtime_context.resolve", {
          kind: "server",
        }),
      ) as FiregridAgentToolContext["Type"]["resolve"],
    }
  }),
)

/**
 * The Firegrid MCP server Layer. Composes:
 *
 *   - `Layer.scopedDiscard(McpServer.registerToolkit(FiregridAgentToolkit))`
 *     — the protocol projection (Effect AI owns `tools/list` and
 *     `tools/call`)
 *   - `HttpRouter.Default.serve()` — exposes the router as the
 *     server's `HttpApp`
 *   - `FiregridAgentToolkitLayer` — toolkit handlers
 *   - route-scoped tool-call workflows on each context's active engine
 *   - `FiregridAgentToolContext` — resolves route context at tool-call time
 *   - `IdGenerator.defaultIdGenerator`
 *   - host-provided AgentToolHost, durable wait_for, and runtime observation
 *     services
 *   - `McpServer.layer` + `RpcServer.layerProtocolHttp({ path })`
 *     — Effect AI MCP handlers over JSON-RPC HTTP serialization
 *   - `NodeHttpServer.layer(createServer, { port, host })` — loopback
 *     binder
 *
 * Caller must provide the host runtime layer that owns RuntimeContext executions.
 * firegrid-host-sdk.MCP_AND_TOOLS.4
 */
// firegrid-effect-ai-native-agents.MCP_TRANSPORT_COMPAT.1
//
// `RpcServer.layerProtocolHttp` collects non-framed HTTP responses into an
// array before calling the serializer. Effect's default JSON-RPC serializer
// therefore emits `[response]` even for one non-batch request. Keep normal
// JSON-RPC request parsing, but unwrap exactly that one-response array so
// strict single-message clients receive `{...}`.
const firegridMcpJsonRpcSerialization = RpcSerialization.RpcSerialization.of({
  contentType: "application/json",
  includesFraming: false,
  unsafeMake: () => {
    const parser = RpcSerialization.jsonRpc().unsafeMake()
    return {
      decode: parser.decode,
      encode: (response) =>
        parser.encode(Array.isArray(response) && response.length === 1
          ? response[0]
          : response),
    }
  },
})

const firegridMcpRpcSerializationLayer = Layer.succeed(
  RpcSerialization.RpcSerialization,
  firegridMcpJsonRpcSerialization,
)

const runtimeContextMcpSpanName = (url: string, method: string): string => {
  const path = url.split("?")[0] ?? url
  if (path.includes("/runtime-context/")) {
    return `firegrid.mcp.http ${method} /runtime-context/:contextId`
  }
  return `firegrid.mcp.http ${method}`
}

const oauthAuthorizationServerDiscoveryPath = "/.well-known/oauth-authorization-server"
const oauthDiscoveryProbeNotConfigured = Effect.succeed(
  HttpServerResponse.empty({ status: 404 }),
)

const oauthAuthorizationServerDiscoveryProbePaths = (
  basePath: HttpRouter.PathInput,
): ReadonlyArray<HttpRouter.PathInput> => {
  const runtimeRoute = runtimeContextMcpPath(basePath)
  return [
    oauthAuthorizationServerDiscoveryPath,
    `${oauthAuthorizationServerDiscoveryPath}${runtimeRoute}`,
    `${runtimeRoute}${oauthAuthorizationServerDiscoveryPath}` as HttpRouter.PathInput,
  ]
}

const registerExpectedOAuthDiscoveryProbeRoutes = (
  basePath: HttpRouter.PathInput,
) =>
  HttpRouter.Default.use(router =>
    Effect.all(
      oauthAuthorizationServerDiscoveryProbePaths(basePath).map(path =>
        router.get(path, oauthDiscoveryProbeNotConfigured),
      ),
      { discard: true },
    ))

export const FiregridMcpServerLayer = (
  options: FiregridMcpServerLayerOptions,
) =>
  Layer.mergeAll(
    // firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.11
    registerExpectedOAuthDiscoveryProbeRoutes(options.path),
    Layer.scopedDiscard(
      Effect.gen(function* () {
        yield* McpServer.registerToolkit(FiregridAgentToolkit)
        yield* enrichRuntimeContextMcpToolsListWithChannelMetadata
      }).pipe(
        Effect.withSpan("firegrid.mcp.register_toolkit", {
          kind: "server",
          attributes: {
            "firegrid.mcp.tool_count": Object.keys(FiregridAgentToolkit.tools).length,
            "firegrid.mcp.tool_names": Object.keys(FiregridAgentToolkit.tools).sort().join(","),
          },
        }),
      ),
    ),
    HttpRouter.Default.serve(),
    // TFIND-048: on bind, the host late-binds its OWN bound MCP listener
    // address into the single-purpose `FiregridRuntimeContextMcpBaseUrl`
    // channel so the host start path can resolve the concrete
    // `contextId`-scoped URL post-materialization. `HttpServer` is in
    // scope here via the `provideMerge`'d `NodeHttpServer.layer` below;
    // `FiregridRuntimeContextMcpBaseUrl` is provided by the runtime host
    // (B) this layer is `provideMerge`'d with.
    Layer.scopedDiscard(
      publishRuntimeContextMcpBase(options.path).pipe(
        Effect.withSpan("firegrid.mcp.publish_runtime_context_base", {
          kind: "server",
          attributes: {
            "firegrid.mcp.path": String(options.path),
          },
        }),
      ),
    ),
  ).pipe(
    Layer.provide(FiregridAgentToolkitLayer),
    Layer.provide(FiregridMcpRouteContextLayer),
    Layer.provide(
      Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator),
    ),
    // firegrid-effect-ai-native-agents.MCP_TRANSPORT_COMPAT.1
    //
    // Inline-replicate `McpServer.layerHttp` here so we can keep
    // `McpServer.layer + RpcServer.layerProtocolHttp` and only swap the
    // non-framed JSON-RPC serializer for strict single-response clients.
    Layer.provide(
      McpServer.layer({
        name: "firegrid.agent-tools",
        version: "0.0.0",
      }).pipe(
        Layer.provide(RpcServer.layerProtocolHttp({
          path: runtimeContextMcpPath(options.path),
        })),
        Layer.provide(firegridMcpRpcSerializationLayer),
      ),
    ),
    // `provideMerge` keeps the bound `HttpServer` service in the
    // output Layer so the host can log its address (or tests can
    // resolve the OS-chosen port when `port: 0`).
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        port: options.port,
        host: options.host,
      }),
    ),
    Layer.provide(HttpRouter.setRouterConfig({
      // firegrid-local-mcp-run.MCP_ROUTE.1-1
      maxParamLength: runtimeContextMcpRouterMaxParamLength,
    })),
    // Quiet the default logger inside the MCP scope; the host's own
    // log surface remains the canonical operator log.
    Layer.provide(Logger.remove(Logger.defaultLogger)),
    HttpMiddleware.withSpanNameGenerator(request =>
      runtimeContextMcpSpanName(request.url, request.method)),
  )

export const ensurePathInput = (path: string): HttpRouter.PathInput => {
  if (path === "*") return path
  if (path.startsWith("/")) return path as HttpRouter.PathInput
  return `/${path}`
}

// `FiregridMcpServerFromConfig` is intentionally not exported. The
// host binary composes this layer with `FiregridMcpServerListenerConfig`
// and `RuntimeHostTopologyFromConfig`; runtime identity still comes
// only from `/mcp/runtime-context/:contextId`.
