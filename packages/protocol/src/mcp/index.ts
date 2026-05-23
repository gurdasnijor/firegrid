// Public subpath: `@firegrid/protocol/mcp`.
//
// Pure, CLI-safe MCP path vocabulary. No Effect, no Layer, no Schema,
// no runtime/host-sdk imports, no `@effect/platform` imports —
// protocol-tier shared helpers only.
//
// Wave (CC4-unblock): the runtime-context MCP route template
// (`<basePath>/runtime-context/:contextId`) is referenced from three
// callers — the host-sdk MCP listener (which mounts the route on its
// bound `HttpServer`), the runtime codec session adapter (which
// constructs the concrete contextId-scoped URL from the host's bound
// `address` + `basePath`), and the CLI (which prints the resolved URL
// for operator-facing diagnostics). All three need the SAME shape;
// living here, with no upstream coupling, lets each consumer reach the
// helper without depending on either of the other two.
//
// The helpers take/return plain `string`. The host-sdk router's
// `HttpRouter.PathInput` is a structurally-equivalent branded string
// alias from `@effect/platform`; host-sdk consumers cast the result
// with `as HttpRouter.PathInput` at the boundary. Keeping the brand
// out of `@firegrid/protocol` lets this subpath stay free of any
// third-party type dependency.

/**
 * Normalize a raw string into the path shape the host-sdk router
 * expects. Accepts `"*"` (mount-without-prefix sentinel) as-is;
 * otherwise ensures a single leading slash.
 *
 * Pure: zero dependencies.
 */
export const ensurePathInput = (path: string): string => {
  if (path === "*") return path
  if (path.startsWith("/")) return path
  return `/${path}`
}

/**
 * Build the route template for the runtime-context MCP server's
 * per-contextId mount point, given a configured MCP base path.
 *
 *   - `"*"` (mount-without-base-prefix sentinel) → `"/runtime-context/:contextId"`.
 *   - otherwise → `"<normalized-base>/runtime-context/:contextId"`,
 *     with trailing slashes on the base stripped.
 *
 * Pure: deterministic string derivation. Used by the host-sdk MCP
 * listener (to register the route on its bound HttpServer), the runtime
 * codec session adapter (to inject the concrete contextId-scoped URL
 * into the codec session), and the CLI (for operator-facing URL prints).
 */
export const runtimeContextMcpPath = (path: string): string => {
  if (path === "*") return "/runtime-context/:contextId"
  const normalized = ensurePathInput(path).replace(/\/+$/, "")
  return `${normalized}/runtime-context/:contextId`
}
