/**
 * Normalized agent I/O event contract.
 *
 * Codecs translate per-protocol wire formats (ACP, stdio-jsonl, future)
 * into and out of these events. The supervising workflow body
 * (`RuntimeContextWorkflow`, wired in PR 2) consumes them without
 * knowing which protocol produced them.
 *
 * This module owns the normalized agent I/O event types. The agent
 * tools layer (`packages/runtime/src/agent-tools`) owns the canonical
 * `FiregridAgentToolkit` (`Toolkit.make` allowlist over Effect AI
 * `Tool.make` values) and the host-side lowering of `ToolUse` events.
 *
 * Anchors:
 *   - firegrid-platform-invariants.AUTHORITY.4 (external decisions
 *     flow through documented authority surfaces),
 *   - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.2
 *     (suspension/result vocabulary stays substrate-neutral).
 */

import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Prompt content (input events)
// ---------------------------------------------------------------------------

export const PromptPartSchema = Schema.Union(
  Schema.TaggedStruct("Text", { text: Schema.String }),
  Schema.TaggedStruct("Image", {
    mediaType: Schema.String,
    // Codecs choose whether to ship raw bytes or a string-encoded form.
    data: Schema.Union(Schema.Uint8ArrayFromSelf, Schema.String),
  }),
  Schema.TaggedStruct("Structured", { data: Schema.Unknown }),
)
export type PromptPart = Schema.Schema.Type<typeof PromptPartSchema>

export const PromptContentSchema = Schema.Array(PromptPartSchema)
export type PromptContent = Schema.Schema.Type<typeof PromptContentSchema>

// ---------------------------------------------------------------------------
// Input events (workflow body -> codec)
// ---------------------------------------------------------------------------

export const PermissionDecisionSchema = Schema.Union(
  Schema.TaggedStruct("Allow", { optionId: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Deny", { reason: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Cancelled", {}),
)
export type PermissionDecision = Schema.Schema.Type<typeof PermissionDecisionSchema>

/**
 * Schema for the `ToolResult` input event variant. Promoted to its
 * own export so the agent-tools layer (and any future ToolResult
 * producer) can reference one canonical schema instead of redeclaring
 * the shape. The variant is still part of `AgentInputEventSchema`.
 */
export const ToolResultEventSchema = Schema.TaggedStruct("ToolResult", {
  toolUseId: Schema.String,
  content: Schema.Unknown,
  isError: Schema.Boolean,
})
export type ToolResultEvent = Schema.Schema.Type<typeof ToolResultEventSchema>

export const AgentInputEventSchema = Schema.Union(
  Schema.TaggedStruct("Prompt", {
    content: PromptContentSchema,
    correlationId: Schema.String,
  }),
  ToolResultEventSchema,
  Schema.TaggedStruct("PermissionResponse", {
    permissionRequestId: Schema.String,
    decision: PermissionDecisionSchema,
  }),
  Schema.TaggedStruct("Cancel", { reason: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Terminate", {}),
)
export type AgentInputEvent = Schema.Schema.Type<typeof AgentInputEventSchema>

// ---------------------------------------------------------------------------
// Output events (codec -> workflow body)
// ---------------------------------------------------------------------------

export const StopReasonSchema = Schema.Literal(
  "end_turn",
  "tool_use",
  "cancelled",
  "max_tokens",
  "error",
)
export type StopReason = Schema.Schema.Type<typeof StopReasonSchema>

export const PermissionOptionKindSchema = Schema.Literal(
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
)
export type PermissionOptionKind = Schema.Schema.Type<typeof PermissionOptionKindSchema>

export const PermissionOptionSchema = Schema.Struct({
  optionId: Schema.String,
  kind: PermissionOptionKindSchema,
  name: Schema.String,
})
export type PermissionOption = Schema.Schema.Type<typeof PermissionOptionSchema>

export const AgentCapabilitiesSchema = Schema.Struct({
  streamingText: Schema.Boolean,
  tools: Schema.Boolean,
  permissions: Schema.Boolean,
  images: Schema.Boolean,
  structuredInput: Schema.Boolean,
  cancellation: Schema.Boolean,
  multiTurn: Schema.Boolean,
  customStatus: Schema.Array(Schema.String),
})
export type AgentCapabilities = Schema.Schema.Type<typeof AgentCapabilitiesSchema>

export const AgentOutputEventSchema = Schema.Union(
  Schema.TaggedStruct("Ready", { capabilities: AgentCapabilitiesSchema }),
  Schema.TaggedStruct("TextChunk", {
    text: Schema.String,
    messageId: Schema.String,
  }),
  Schema.TaggedStruct("ToolUse", {
    toolUseId: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  }),
  Schema.TaggedStruct("PermissionRequest", {
    permissionRequestId: Schema.String,
    toolUseId: Schema.String,
    options: Schema.Array(PermissionOptionSchema),
  }),
  Schema.TaggedStruct("TurnComplete", {
    stopReason: StopReasonSchema,
    messageId: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Status", {
    kind: Schema.String,
    payload: Schema.optional(Schema.Unknown),
  }),
  Schema.TaggedStruct("Error", {
    cause: Schema.Unknown,
    recoverable: Schema.Boolean,
  }),
  Schema.TaggedStruct("Terminated", {
    exitCode: Schema.optional(Schema.Number),
  }),
)
export type AgentOutputEvent = Schema.Schema.Type<typeof AgentOutputEventSchema>
