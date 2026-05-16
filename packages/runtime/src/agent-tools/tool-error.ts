/**
 * Structured agent-tool error types.
 *
 * `toolUseToEffect` catches every arm failure and emits a `ToolResult`
 * input event with `isError: true`. The workflow does NOT fail for tool
 * failures — the agent gets a structured error and decides what to do.
 *
 * `ToolError` is the tagged union match arms surface internally; the
 * outer lowering converts each variant into a `ToolResult` event with a
 * codec-friendly content payload using `toolErrorResult`.
 *
 * Implements:
 *  - agent-codec-runtime-tools.md/agent-tool-layer-phase-2 §"Tool error semantics"
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.3
 *    (typed expected results; retryable vs terminal failures)
 */

import { Prompt } from "@effect/ai"
import { ParseResult, Schema } from "effect"
import type { AgentInputEvent } from "../agent-event-pipeline/events/index.ts"

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

const stringifyCause = (cause: unknown): string => {
  if (cause === undefined) return "no cause"
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  if (typeof cause === "number" || typeof cause === "boolean") {
    return String(cause)
  }
  try {
    return JSON.stringify(cause)
  } catch {
    return "[unprintable cause]"
  }
}

/**
 * Human-friendly formatter for a `ToolError`. Used by the lowering when
 * constructing the `content` payload of an `isError: true` ToolResult,
 * and by tests asserting on the textual surface of error results.
 */
export const formatToolError = (error: ToolError): string => {
  switch (error._tag) {
    case "ToolInvalidInput":
      return `Tool "${error.name}" rejected input: ${error.reason}`
    case "ToolExecutionFailed":
      return `Tool "${error.name}" execution failed: ${error.message}`
    case "ToolCancelled":
      return `Tool "${error.name}" was cancelled`
  }
}

type ToolResultEvent = Extract<AgentInputEvent, { _tag: "ToolResult" }>

const toolResultEvent = (
  toolUseId: string,
  name: string,
  content: unknown,
  isError: boolean,
): ToolResultEvent => ({
  _tag: "ToolResult",
  part: Prompt.toolResultPart({
    id: toolUseId,
    name,
    result: content,
    isFailure: isError,
    providerExecuted: false,
  }),
})

/**
 * Build a success `ToolResult` event. `content` is the decoded tool
 * output; the codec re-encodes it for the agent's wire protocol.
 */
export const toolResult = (
  toolUseId: string,
  name: string,
  content: unknown,
): ToolResultEvent => toolResultEvent(toolUseId, name, content, false)

/**
 * Build an `isError: true` `ToolResult` event with a structured error
 * payload derived from `ToolError`. The payload includes the tagged
 * union shape so codecs can inspect the failure category.
 */
export const toolErrorResult = (error: ToolError): ToolResultEvent =>
  toolResultEvent(
    error.toolUseId,
    error.name,
    { error, message: formatToolError(error) },
    true,
  )

/**
 * Build the name-lookup-failure ToolResult for an unknown tool
 * name. This is a distinct production result from `ToolInvalidInput`
 * (the codec emitted a name that is not in `FiregridAgentToolkit`'s
 * Tool set).
 */
export const unknownToolResult = (
  toolUseId: string,
  name: string,
): ToolResultEvent =>
  toolResultEvent(
    toolUseId,
    name,
    {
      error: {
        _tag: "UnknownTool" as const,
        toolUseId,
        name,
      },
      message: `Unknown tool "${name}"`,
    },
    true,
  )

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
