/**
 * Structured agent-tool error types.
 *
 * `ToolError` is the typed tool-failure schema. It is the `.setFailure`
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

import { AiError } from "@effect/ai"
import { Cause, ParseResult, Schema } from "effect"

export const ToolError = Schema.Union(AiError.MalformedInput, AiError.UnknownError)
export type ToolError = Schema.Schema.Type<typeof ToolError>
export type ToolInvalidInputError = AiError.MalformedInput
export type ToolExecutionFailedError = AiError.UnknownError

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
 * Effect AI's `MalformedInput` variant. Used by the lowering when protocol
 * input-schema validation fails. The installed `@effect/ai` version exposes
 * the same context fields as upstream (`module`, `method`, `description`,
 * `cause`), so the Firegrid tool name and `toolUseId` live there instead of
 * in a parallel tool-error hierarchy.
 */
export const toolInvalidInputFromParseError = (
  toolUseId: string,
  name: string,
  cause: ParseResult.ParseError,
): ToolInvalidInputError =>
  new AiError.MalformedInput({
    module: "FiregridMcpHost",
    method: `${name}.tool/${toolUseId}`,
    description: `Malformed input for tool "${name}" (${toolUseId}): ${
      ParseResult.TreeFormatter.formatErrorSync(cause)
    }`,
    cause,
  })

/**
 * Convenience: turn an arbitrary cause into Effect AI's `UnknownError`
 * variant for a known tool name.
 */
export const toolExecutionFailed = (
  toolUseId: string,
  name: string,
  cause: unknown,
): ToolExecutionFailedError =>
  new AiError.UnknownError({
    module: "FiregridMcpHost",
    method: `${name}.tool/${toolUseId}`,
    description: stringifyCause(cause),
    ...(cause === undefined ? {} : { cause }),
  })
