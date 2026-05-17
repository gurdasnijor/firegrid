/**
 * `@firegrid/host-sdk/agent-tools`
 *
 * Convenience barrel re-exporting the agent-tool BINDING surface
 * (`./bindings`) and the EXECUTION surface (`./execution`). Per
 * `firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6` the two concerns are kept in
 * separate modules; consumers that only need bindings (e.g. codec/MCP
 * exposure) should import `@firegrid/host-sdk/agent-tools/bindings`
 * directly.
 */

export * from "./bindings/index.ts"
export * from "./execution/index.ts"
