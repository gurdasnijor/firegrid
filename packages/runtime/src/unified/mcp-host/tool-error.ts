/**
 * Structured agent-tool error types.
 *
 * `ToolError` is the typed tool-failure union. It is the `.setFailure`
 * schema each Firegrid `Tool` binds (`FiregridMcpToolFailureSchema` in
 * `./toolkit.ts`), and it is the error channel the typed arms + toolkit
 * handlers fail with. The workflow does NOT fail for tool failures — the
 * agent gets a structured error and decides what to do.
 *
 * The MCP-entry path does NOT build the MCP result: `@effect/ai`'s
 * `McpServer.registerToolkit` (default `failureMode: "error"`) catches a
 * handler failure of this shape and lowers it into
 * `CallToolResult{isError:true, structuredContent: <ToolError>}`. The
 * `ToolResult` → `AgentInputEvent` lowering that the legacy
 * `toolUseToEffect` did is WIRE-path delivery machinery and lives in the
 * future wire-path slice, not here.
 *
 * Implements:
 *  - agent-codec-runtime-tools.md/agent-tool-layer-phase-2 §"Tool error semantics"
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.3
 *    (typed expected results; retryable vs terminal failures)
 */

import { Cause, ParseResult, Schema } from "effect"

export const ToolInvalidInputError = Schema.TaggedStruct("ToolInvalidInput", {
  toolUseId: Schema.String,
  name: Schema.String,
  reason: Schema.String,
})
export type ToolInvalidInputError = Schema.Schema.Type<
  typeof ToolInvalidInputError
>

export const ToolExecutionFailedError = Schema.TaggedStruct(
  "ToolExecutionFailed",
  {
    toolUseId: Schema.String,
    name: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
)
export type ToolExecutionFailedError = Schema.Schema.Type<
  typeof ToolExecutionFailedError
>

export const ToolCancelledError = Schema.TaggedStruct("ToolCancelled", {
  toolUseId: Schema.String,
  name: Schema.String,
})
export type ToolCancelledError = Schema.Schema.Type<typeof ToolCancelledError>

export const ToolError = Schema.Union(
  ToolInvalidInputError,
  ToolExecutionFailedError,
  ToolCancelledError,
)
export type ToolError = Schema.Schema.Type<typeof ToolError>

// Render an arbitrary caught value to a human-readable message. Plain
// string causes pass through verbatim (many call sites pass a literal
// message); everything else is rendered with Effect's `Cause.pretty`.
const stringifyCause = (cause: unknown): string =>
  cause === undefined
    ? "no cause"
    : typeof cause === "string"
      ? cause
      : Cause.pretty(Cause.die(cause))

/**
 * Convenience: turn a `Schema.decodeUnknown` ParseError into the
 * `ToolInvalidInput` variant. Used by the lowering when protocol
 * input-schema validation fails.
 */
export const toolInvalidInputFromParseError = (
  toolUseId: string,
  name: string,
  cause: ParseResult.ParseError,
): ToolInvalidInputError => ({
  _tag: "ToolInvalidInput",
  toolUseId,
  name,
  reason: ParseResult.TreeFormatter.formatErrorSync(cause),
})

/**
 * Convenience: turn an arbitrary cause into the `ToolExecutionFailed`
 * variant for a known tool name.
 */
export const toolExecutionFailed = (
  toolUseId: string,
  name: string,
  cause: unknown,
): ToolExecutionFailedError => ({
  _tag: "ToolExecutionFailed",
  toolUseId,
  name,
  message: stringifyCause(cause),
  ...(cause === undefined ? {} : { cause }),
})

/**
 * Convenience: cancellation variant. Reserved for future cancellation
 * propagation; not currently emitted by any arm.
 */
export const toolCancelled = (
  toolUseId: string,
  name: string,
): ToolCancelledError => ({
  _tag: "ToolCancelled",
  toolUseId,
  name,
})
