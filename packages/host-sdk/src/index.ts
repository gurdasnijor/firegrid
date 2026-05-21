/**
 * `@firegrid/host-sdk`
 *
 * Host-plane composition for Firegrid: host layer composition, agent
 * provider installation, route-scoped MCP exposure, agent-tool bindings,
 * runtime start capability, and the live `RuntimeToolUseExecutor` layer.
 *
 * Boundary (`firegrid-host-sdk.PACKAGE_GRAPH.4`,
 * `firegrid-host-sdk.TOOL_EXECUTOR_SEAM`):
 *  - imports `@firegrid/protocol`, `@firegrid/runtime`, `@effect/ai`,
 *    `@effect/platform-node`, `@modelcontextprotocol/sdk`;
 *  - never imports `@firegrid/client-sdk` or `@firegrid/cli`;
 *  - `@firegrid/runtime` owns the `RuntimeToolUseExecutor` capability tag;
 *    this package only provides the live layer.
 */

// Host composition, config, commands, sync-run, env policy.
export * from "./host/index.ts"

// Route-scoped MCP server exposure of the agent toolkit.
export {
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridMcpServerListenerConfig,
  runtimeContextMcpPath,
  type FiregridMcpServerLayerOptions,
} from "./host/mcp-host.ts"

// TFIND-048 host-provisioning seam. Single-purpose, host-scoped
// late-bind of the runtime-context MCP base URL + the exact resolution
// the codec start path uses to honor the URL-less `runtimeContextMcp`
// marker. Exported so the deterministic CI-gating test can assert the
// seam (host provisions the URL; client predicts none) with zero
// real-LLM dependence.
export {
  FiregridRuntimeContextMcpBaseUrl,
  FiregridRuntimeContextMcpBaseUrlLive,
  type FiregridRuntimeContextMcpBase,
} from "./host/runtime-context-mcp-base-url.ts"

// Agent-tool bindings (protocol → Effect AI Tool/Toolkit) and execution
// (lowering, AgentToolHost seam, scheduled-input workflow). Kept split
// per firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6; also reachable via the
// `@firegrid/host-sdk/agent-tools/{bindings,execution}` subpaths.
export * from "./agent-tools/index.ts"
