/**
 * Host-owned localhost MCP server for the Firegrid agent toolkit, ported
 * onto the #765 unified substrate (tf-r06u.28 slice 3).
 *
 * Composes `@effect/ai`'s `McpServer.layerHttp` + `McpServer.registerToolkit`
 * behind an `@effect/platform-node/NodeHttpServer` bound to loopback. The
 * library owns the MCP protocol (`tools/list`, `tools/call`, JSON-RPC, the
 * `CallToolResult` encoding); this module only wires Firegrid's `Toolkit`
 * into it and adds Firegrid's `/runtime-context/:contextId` route scoping.
 * No hand-rolled server, no manual result/error encoding.
 *
 * tf-x3sv (register-before-serve) is STRUCTURAL here: registering the
 * toolkit as a build-time `Layer` dependency of `HttpRouter.Default.serve()`
 * gives a happens-before edge — registration completes before any request
 * is routed, so the first `tools/list` is always the complete toolset (a
 * no-`list_changed` client like codex-acp that snapshots once still sees
 * every tool).
 *
 * Route-context resolution uses the unified `ContextResolverTag`
 * (`../codec-adapter.ts`); the toolkit + handler layers come from
 * `./toolkit.ts` / `./toolkit-layer.ts`. `ToolDispatch` and
 * `ContextResolverTag` are left on the R-channel for the host composer.
 *
 * MCP_TRANSPORT_COMPAT.1 — re-added on EVIDENCE (tf-rgdt verdict): the slice-4
 * acceptance test (`test/mcp-host/mcp-host-http-acceptance.test.ts`) found the
 * default `RpcSerialization.layerJsonRpc` (which `McpServer.layerHttp` bundles)
 * returns a single non-batch response array-wrapped as `[response]`. Strict
 * single-message clients (codex-acp) break on that. So we inline-replicate
 * `layerHttp` (`McpServer.layer` + `RpcServer.layerProtocolHttp` + a JSON-RPC
 * serializer that unwraps the one-element array). This was NOT pre-emptive —
 * the round-trip actually broke.
 *
 * STILL DEFERRED (tracked tf-rgdt; not exercised here):
 *  - the OAuth-discovery 404 probe routes.
 */

import { IdGenerator, McpServer } from "@effect/ai"
import { HttpRouter } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { HostPermissionRespondChannel } from "@firegrid/protocol/channels"
import {
  ContextNotFound,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Config, Effect, Layer, Logger, Option } from "effect"
// The MCP HTTP server lifetime is Effect-owned via McpServer.layerHttp +
// NodeHttpServer.layer, bound only to loopback; `createServer` is the
// documented listener factory the platform-node `NodeHttpServer.layer`
// example accepts.
// durable-lint-allow-control-plane: @effect/platform-node NodeHttpServer.layer listener factory
import { createServer } from "node:http"
import { ContextResolverTag } from "../codec-adapter.ts"
import type { FiregridMcpDurableStreamsWireOptions } from "./durable-streams-protocol.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridPrimitiveProfileToolkit,
} from "./toolkit.ts"
import {
  FiregridAgentToolkitLayer,
  FiregridPrimitiveProfileToolkitLayer,
} from "./toolkit-layer.ts"
import {
  publishRuntimeContextMcpBase,
  runtimeContextMcpPath,
} from "./runtime-context-mcp-base-url.ts"
import {
  layerProtocolDurableStreamsWithSessionPromptTasks,
  makeRuntimeTaskAndObservationProjectionRuntime,
} from "./task-projection.ts"

const runtimeContextMcpRouterMaxParamLength = 4096

// MCP_TRANSPORT_COMPAT.1 — `RpcServer.layerProtocolHttp` collects non-framed
// HTTP responses into an array before serializing, so the default JSON-RPC
// serializer emits `[response]` even for one non-batch request. Keep normal
// JSON-RPC parsing, but unwrap exactly that one-element array so strict
// single-message clients (codex-acp) receive `{...}`. (tf-rgdt verdict:
// the slice-4 acceptance round-trip confirmed the array-wrapping.)
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

/**
 * Effect Config for the host-owned MCP HTTP server's listener topology.
 * Process/listener knobs only — no runtime identity. Defaults bind to
 * loopback on an OS-chosen port under `/mcp`, OPT-IN via
 * `FIREGRID_MCP_ENABLED` (default false).
 */
export const FiregridMcpServerListenerConfig = Config.all({
  enabled: Config.boolean("FIREGRID_MCP_ENABLED").pipe(Config.withDefault(false)),
  host: Config.string("FIREGRID_MCP_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.integer("FIREGRID_MCP_PORT").pipe(Config.withDefault(0)),
  path: Config.string("FIREGRID_MCP_PATH").pipe(Config.withDefault("/mcp")),
})

export type FiregridMcpServerListenerConfig = Config.Config.Success<
  typeof FiregridMcpServerListenerConfig
>

export interface FiregridMcpHttpServerLayerOptions {
  readonly host: string
  readonly port: number
  /**
   * Base MCP path. The runtime context route is always appended as
   * `/runtime-context/:contextId`. Passing `*` means "mount without a
   * configured base prefix"; it is not a catch-all route.
   */
  readonly path: HttpRouter.PathInput
  readonly toolProfile?: "full" | "primitive"
  readonly durableStreams?: undefined
}

export interface FiregridMcpDurableStreamsServerLayerOptions {
  readonly host: string
  readonly port: number
  /**
   * Kept for option-shape compatibility with the HTTP listener. Durable-streams
   * transport is scoped by `durableStreams.streamId` + `contextId`.
   */
  readonly path: HttpRouter.PathInput
  readonly toolProfile?: "full" | "primitive"
  readonly durableStreams: FiregridMcpDurableStreamsWireOptions & {
    readonly contextId: string
  }
}

export type FiregridMcpServerLayerOptions =
  | FiregridMcpHttpServerLayerOptions
  | FiregridMcpDurableStreamsServerLayerOptions

/**
 * Resolves the `/runtime-context/:contextId` route parameter to a unified
 * `RuntimeContext` at tool-call time. `HttpRouter.params` is read inside
 * `resolve` so the request fiber supplies the current route value per
 * `tools/call` instead of memoizing one context into the shared layer.
 */
const FiregridMcpRouteContextLayer = Layer.effect(
  FiregridAgentToolContext,
  Effect.gen(function*() {
    const resolver = yield* ContextResolverTag
    return {
      // firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1/.3
      // firegrid-host-sdk.MCP_AND_TOOLS.4
      resolve: Effect.gen(function*() {
        const params = yield* HttpRouter.params
        const contextId = yield* Option.match(Option.fromNullable(params.contextId), {
          onNone: () =>
            Effect.fail(new ContextNotFound({ contextId: "<missing-mcp-route-context>" })),
          onSome: Effect.succeed,
        })
        return yield* resolveFiregridAgentToolContext(
          resolver,
          contextId,
        )
      }).pipe(
        Effect.withSpan("firegrid.mcp.runtime_context.resolve", { kind: "server" }),
      ) as FiregridAgentToolContext["Type"]["resolve"],
    }
  }),
)

const FiregridMcpDurableStreamsContextLayer = (
  contextId: string,
) =>
  Layer.effect(
    FiregridAgentToolContext,
    Effect.gen(function*() {
      const resolver = yield* ContextResolverTag
      return {
        resolve: Effect.gen(function*() {
          return yield* resolveFiregridAgentToolContext(
            resolver,
            contextId,
          )
        }).pipe(
          Effect.withSpan("firegrid.mcp.durable_streams_context.resolve", {
            kind: "server",
          }),
        ),
      }
    }),
  )

const resolveFiregridAgentToolContext = (
  resolver: ContextResolverTag["Type"],
  contextId: string,
): Effect.Effect<{
  readonly contextId: string
  readonly runtimeContext?: RuntimeContext
}, unknown> =>
  resolver.resolve(contextId).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new ContextNotFound({ contextId })),
      onSome: runtimeContext =>
        Effect.annotateCurrentSpan({ "firegrid.context.id": contextId }).pipe(
          Effect.as({ contextId, runtimeContext }),
        ),
    })),
  )

const toolNamesForProfile = (toolProfile: "full" | "primitive") =>
  toolProfile === "primitive"
    ? Object.keys(FiregridPrimitiveProfileToolkit.tools).sort()
    : Object.keys(FiregridAgentToolkit.tools).sort()

const makeRegisterToolkitLayer = (
  toolProfile: "full" | "primitive",
  toolNames: ReadonlyArray<string>,
  contextLayer: Layer.Layer<FiregridAgentToolContext, unknown, ContextResolverTag | HttpRouter.RouteContext>,
) =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      if (toolProfile === "primitive") {
        yield* McpServer.registerToolkit(FiregridPrimitiveProfileToolkit)
      } else {
        yield* McpServer.registerToolkit(FiregridAgentToolkit)
      }
    }).pipe(
      Effect.withSpan("firegrid.mcp.register_toolkit", {
        kind: "server",
        attributes: {
          "firegrid.mcp.tool_count": toolNames.length,
          "firegrid.mcp.tool_names": toolNames.join(","),
          "firegrid.mcp.tool_profile": toolProfile,
        },
      }),
    ),
  ).pipe(
    Layer.provide(
      toolProfile === "primitive"
        ? FiregridPrimitiveProfileToolkitLayer
        : FiregridAgentToolkitLayer,
    ),
    Layer.provide(contextLayer),
    Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
  )

const makeFiregridMcpDurableStreamsServerLayer = (
  options: FiregridMcpDurableStreamsServerLayerOptions,
) => {
  const toolProfile = options.toolProfile ?? "full"
  const toolNames = toolNamesForProfile(toolProfile)
  const durableStreams = options.durableStreams
  const registerToolkitLayer = makeRegisterToolkitLayer(
    toolProfile,
    toolNames,
    FiregridMcpDurableStreamsContextLayer(durableStreams.contextId),
  )
  return Layer.unwrapEffect(
    Effect.gen(function*() {
      // eslint-disable-next-line local/sg-runtime-no-table-service-yield-outside-providers -- host composition wires MCP observation resources to protocol-owned control-plane rows.
      const control = yield* RuntimeControlPlaneTable
      // eslint-disable-next-line local/sg-runtime-no-table-service-yield-outside-providers -- host composition wires the projection runtime to protocol-owned RuntimeOutput rows.
      const output = yield* RuntimeOutputTable
      const permissionRespond = yield* HostPermissionRespondChannel
      const projectionRuntime = makeRuntimeTaskAndObservationProjectionRuntime(
        control,
        output,
        permissionRespond,
      )
      const mcpServerLayer = McpServer.layer({
        name: "firegrid.agent-tools",
        version: "0.0.0",
      }).pipe(
        Layer.provide(
          layerProtocolDurableStreamsWithSessionPromptTasks(
            durableStreams,
            projectionRuntime,
          ),
        ),
      )
      return registerToolkitLayer.pipe(
        Layer.provide(mcpServerLayer),
        Layer.provide(Logger.remove(Logger.defaultLogger)),
      )
    }),
  )
}

const makeFiregridMcpHttpServerLayer = (
  options: FiregridMcpHttpServerLayerOptions,
) => {
  const toolProfile = options.toolProfile ?? "full"
  const toolNames = toolNamesForProfile(toolProfile)
  // tf-x3sv: register the complete toolset as a build-time dependency of
  // the serving layer (`Layer.provide` below), so registration fully
  // completes before any request is routed. `McpServer.registerToolkit`
  // pushes tools one at a time; making it happens-before serving means the
  // first `tools/list` is always complete and `notifications/tools/list_changed`
  // is not required for initial correctness.
  const registerToolkitLayer = makeRegisterToolkitLayer(
    toolProfile,
    toolNames,
    FiregridMcpRouteContextLayer,
  )
  return Layer.mergeAll(
    HttpRouter.Default.serve(),
    Layer.scopedDiscard(publishRuntimeContextMcpBase(options.path)),
  ).pipe(
    // tf-x3sv: registration completes before the router serves.
    Layer.provide(registerToolkitLayer),
    // Inline-replicate `McpServer.layerHttp` so we keep `McpServer.layer +
    // RpcServer.layerProtocolHttp` and only swap the non-framed JSON-RPC
    // serializer for the single-response unwrap (MCP_TRANSPORT_COMPAT.1).
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
    // `provideMerge` keeps the bound `HttpServer` service in the output
    // Layer so the host can log its address (or tests can resolve the
    // OS-chosen port when `port: 0`).
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        port: options.port,
        host: options.host,
      }),
    ),
    Layer.provide(HttpRouter.setRouterConfig({
      maxParamLength: runtimeContextMcpRouterMaxParamLength,
    })),
    // Quiet the default logger inside the MCP scope; the host's own log
    // surface remains the canonical operator log.
    Layer.provide(Logger.remove(Logger.defaultLogger)),
  )
}

/**
 * The Firegrid MCP server Layer. Leaves `ToolDispatch` and
 * `ContextResolverTag` on the R-channel for the host composer (e.g.
 * `ToolDispatchLive` over the host `WorkflowEngine`, and a
 * control-plane-backed resolver).
 */
export function FiregridMcpServerLayer(
  options: FiregridMcpHttpServerLayerOptions,
): ReturnType<typeof makeFiregridMcpHttpServerLayer>
export function FiregridMcpServerLayer(
  options: FiregridMcpDurableStreamsServerLayerOptions,
): ReturnType<typeof makeFiregridMcpDurableStreamsServerLayer>
export function FiregridMcpServerLayer(
  options: FiregridMcpServerLayerOptions,
): ReturnType<typeof makeFiregridMcpHttpServerLayer> | ReturnType<typeof makeFiregridMcpDurableStreamsServerLayer> {
  return options.durableStreams === undefined
    ? makeFiregridMcpHttpServerLayer(options)
    : makeFiregridMcpDurableStreamsServerLayer(options)
}
