/**
 * Host-owned localhost MCP server for the Firegrid agent toolkit.
 *
 * Composes `@effect/ai/McpServer.layerHttp` and
 * `McpServer.registerToolkit(FiregridAgentToolkit)` directly behind an
 * `@effect/platform-node/NodeHttpServer` bound to a loopback host. The
 * MCP HTTP listener is an Effect Layer in the host process's scope; it
 * starts and stops with `NodeRuntime.runMain`. There is no separate
 * `firegrid:mcp` binary, no stdio shim, no supervisor protocol, no
 * custom JSON-RPC stack, no wrapper toolkit, no manual `tools/list` or
 * `tools/call` handler.
 *
 * Implements (SDD):
 *  - SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"V1: Host-Owned Localhost MCP Server"
 *
 * Implements (feature spec):
 *  - firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.1..7
 *  - firegrid-workflow-driven-runtime.VALIDATION.5
 *
 * V1 routing scope:
 *  Effect AI's `McpServer.layerHttp` mounts the MCP endpoint at a
 *  single `HttpRouter.PathInput`; per-path service injection of a
 *  request-scoped `FiregridAgentToolContext` is not a first-class
 *  primitive on that layer today. Per the SDD's documented fallback,
 *  V1 ships a one-context-per-server-instance shape: the host config
 *  supplies `FIREGRID_MCP_CONTEXT_ID`, the layer installs
 *  `FiregridAgentToolContext` once for the whole server, and context
 *  selection remains host configuration — never an agent-visible tool
 *  argument. Multi-context routing (`/mcp/runtime-context/:contextId`)
 *  lands as V2 host work.
 */

import { IdGenerator, McpServer } from "@effect/ai"
import { HttpRouter } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Config, Effect, Layer, Logger } from "effect"
/* eslint-disable-next-line local/no-hidden-control-plane --
   the MCP HTTP server is an explicit, opt-in agent-facing surface
   bound only to loopback; the `node:http` listener factory is the
   documented entrypoint passed to `NodeHttpServer.layer` per
   Effect Platform's example. */
import { createServer } from "node:http"
import { DurableToolsWaitForLive } from "../durable-tools/index.ts"
import { ScheduledInputWorkflowLayer } from "./scheduled-input-workflow.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "./tool-host.ts"
import { toolExecutionFailed } from "./tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
  ToolCallWorkflowLayer,
} from "./tools.ts"

/**
 * Effect Config for the host-owned MCP HTTP server's listener
 * topology. Process/listener knobs only — no runtime identity.
 *
 * Defaults bind only to loopback (`127.0.0.1`) on an OS-chosen port
 * (`0`) at `/mcp`, and the server is OPT-IN — `FIREGRID_MCP_ENABLED`
 * defaults to `false` so existing host deployments are unaffected.
 *
 * The runtime `contextId` is durable/session state, not host-process
 * env. Static MCP routing belongs at the Layer-factory call site (the
 * caller passes `contextId` to `FiregridMcpServerLayer`); dynamic
 * per-request routing belongs in V2 (`/mcp/runtime-context/:contextId`
 * route-based `FiregridAgentToolContext` injection).
 *
 * The durable-streams base URL and runtime namespace are reused from
 * `RuntimeHostTopologyFromConfig` at the caller; the durable-tools
 * stream URL is derived from those alongside the runtime/workflow URLs
 * the host already mounts.
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

/**
 * Default `AgentToolHost` for V1 host-local MCP. The `spawn`,
 * `spawn_all`, and `execute` arms route through `AgentToolHost`; until
 * the host wires real implementations (V2 work alongside the durable
 * indirect bridge), the V1 default returns a structured
 * `FiregridMcpToolFailure` so MCP `CallToolResult.isError` is `true`
 * for those tools rather than an HTTP error or a workflow failure.
 * `appendScheduledPrompt` is a no-op for the same reason; the
 * `ScheduledInputWorkflow` body still records the durable sleep
 * cleanly under replay.
 *
 * `sleep`, `wait_for`, and `schedule_me` do not route through
 * `AgentToolHost` and work end-to-end with this default.
 */
export const defaultV1AgentToolHost: AgentToolHostService = {
  spawnChildContext: ({ toolUseId }) =>
    Effect.fail(
      toolExecutionFailed(
        toolUseId,
        "spawn",
        "spawn is not implemented in the V1 host-local MCP server",
      ),
    ),
  spawnChildContexts: ({ toolUseId }) =>
    Effect.fail(
      toolExecutionFailed(
        toolUseId,
        "spawn_all",
        "spawn_all is not implemented in the V1 host-local MCP server",
      ),
    ),
  executeSandboxTool: ({ toolUseId }) =>
    Effect.fail(
      toolExecutionFailed(
        toolUseId,
        "execute",
        "execute is not implemented in the V1 host-local MCP server",
      ),
    ),
  appendScheduledPrompt: () => Effect.void,
}

export interface FiregridMcpServerLayerOptions {
  readonly host: string
  readonly port: number
  readonly path: HttpRouter.PathInput
  readonly contextId: string
  readonly agentToolsStreamUrl: string
  readonly agentToolHost?: AgentToolHostService
}

/**
 * The Firegrid MCP server Layer. Composes:
 *
 *   - `Layer.scopedDiscard(McpServer.registerToolkit(FiregridAgentToolkit))`
 *     — the protocol projection (Effect AI owns `tools/list` and
 *     `tools/call`)
 *   - `HttpRouter.Default.serve()` — exposes the router as the
 *     server's `HttpApp`
 *   - `FiregridAgentToolkitLayer` — toolkit handlers
 *   - `ToolCallWorkflowLayer` — gives the handlers a workflow instance
 *   - `ScheduledInputWorkflowLayer` — `schedule_me` child workflow
 *   - `FiregridAgentToolContext.layer({ contextId })` — bridge runtime
 *     context
 *   - `IdGenerator.defaultIdGenerator`
 *   - `AgentToolHost.layer(...)` (V1 default returns
 *     ToolExecutionFailed for spawn/spawn_all/execute)
 *   - `DurableToolsWaitForLive({ streamUrl })` — `wait_for` arm
 *   - `McpServer.layerHttp({ path })` — JSON-RPC HTTP serialization
 *   - `NodeHttpServer.layer(createServer, { port, host })` — loopback
 *     binder
 *
 * Caller must still provide the `WorkflowEngine` (typically through
 * `FiregridRuntimeHostWithWorkflowLive`).
 */
export const FiregridMcpServerLayer = (
  options: FiregridMcpServerLayerOptions,
) =>
  Layer.mergeAll(
    Layer.scopedDiscard(McpServer.registerToolkit(FiregridAgentToolkit)),
    HttpRouter.Default.serve(),
  ).pipe(
    Layer.provide(FiregridAgentToolkitLayer),
    Layer.provide(ToolCallWorkflowLayer),
    Layer.provide(ScheduledInputWorkflowLayer),
    Layer.provide(
      FiregridAgentToolContext.layer({ contextId: options.contextId }),
    ),
    Layer.provide(
      Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator),
    ),
    Layer.provide(
      AgentToolHost.layer(options.agentToolHost ?? defaultV1AgentToolHost),
    ),
    Layer.provide(
      DurableToolsWaitForLive({ streamUrl: options.agentToolsStreamUrl }),
    ),
    Layer.provide(
      McpServer.layerHttp({
        name: "firegrid.agent-tools",
        version: "0.0.0",
        path: options.path,
      }),
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
    // Quiet the default logger inside the MCP scope; the host's own
    // log surface remains the canonical operator log.
    Layer.provide(Logger.remove(Logger.defaultLogger)),
  )

/**
 * Derive the durable-tools stream URL alongside the runtime/workflow
 * URLs the host already mounts. Callers compose this with their own
 * `RuntimeHostTopologyFromConfig` value to avoid a parallel base-URL
 * or namespace knob.
 */
export const agentToolsStreamUrlFromTopology = (
  durableStreamsBaseUrl: string,
  namespace: string,
): string => {
  const base = durableStreamsBaseUrl.replace(/\/+$/, "")
  const streamPrefix = base.includes("/v1/stream/")
    ? `${base}/`
    : `${base}/v1/stream/`
  return `${streamPrefix}${encodeURIComponent(`${namespace}.firegrid.durableTools`)}`
}

export const ensurePathInput = (path: string): HttpRouter.PathInput => {
  if (path === "*") return path
  if (path.startsWith("/")) return path as HttpRouter.PathInput
  return `/${path}`
}

// `FiregridMcpServerFromConfig` (an unwrapEffect Layer that reads
// listener config + topology + a contextId from env) is intentionally
// NOT exported. Static MCP routing requires a runtime `contextId`,
// which is durable/session state, not host-process env. The host-side
// wiring lands once one of these is available:
//   1. `/mcp/runtime-context/:contextId` route-based
//      `FiregridAgentToolContext` injection through Effect AI's HTTP
//      layer without a custom JSON-RPC handler; or
//   2. A durable host/session/local-agent authority record in
//      `runtime-host` / control-plane shape that maps to `contextId`.
//
// Note: V1 does not pass authenticated headers through to the
// durable-tools wait stream. If `FIREGRID_DURABLE_STREAMS_TOKEN` is
// in use, `wait_for` calls against an authenticated Durable Streams
// backend will fail; `sleep` and `schedule_me` are unaffected.
// Authenticated `DurableToolsTableOptions` is a follow-up (V2,
// alongside the durable indirect bridge).
