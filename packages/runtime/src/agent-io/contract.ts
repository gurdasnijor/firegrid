/**
 * Normalized agent I/O event contract.
 *
 * Codecs translate per-protocol wire formats (ACP, stdio-jsonl, future)
 * into and out of these events. Model-content payloads use Effect AI
 * Prompt/Response contracts; Firegrid owns only lifecycle/control
 * envelopes around the agent process.
 * firegrid-agent-io-effect-ai-alignment.LOCAL_LIFECYCLE_EVENTS.1
 * firegrid-agent-io-effect-ai-alignment.EFFECT_AI_BOUNDARIES.3
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

import { Prompt, Response } from "@effect/ai"
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Effect AI semantic payloads
// ---------------------------------------------------------------------------

export const AgentPromptSchema = Prompt.UserMessage
export type AgentPrompt = Prompt.UserMessage

export const AgentTextDeltaPartSchema = Response.TextDeltaPart
export type AgentTextDeltaPart = Response.TextDeltaPart

export const AgentToolCallPartSchema = Prompt.ToolCallPart
export type AgentToolCallPart = Prompt.ToolCallPart

export const AgentToolResultPartSchema = Prompt.ToolResultPart
export type AgentToolResultPart = Prompt.ToolResultPart

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
  // firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.3
  part: AgentToolResultPartSchema,
})
export type ToolResultEvent = Schema.Schema.Type<typeof ToolResultEventSchema>

export const AgentInputEventSchema = Schema.Union(
  Schema.TaggedStruct("Prompt", {
    // firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.1
    prompt: AgentPromptSchema,
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

export const StopReasonSchema = Response.FinishReason
export type StopReason = Response.FinishReason

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

export const AgentToolUseModeSchema = Schema.Literal(
  "observation_only",
  "client_result_roundtrip",
  "control_channel_request_response",
)
export type AgentToolUseMode = Schema.Schema.Type<typeof AgentToolUseModeSchema>

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
    part: AgentTextDeltaPartSchema,
  }),
  Schema.TaggedStruct("ToolUse", {
    // firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.2
    part: AgentToolCallPartSchema,
  }),
  Schema.TaggedStruct("PermissionRequest", {
    permissionRequestId: Schema.String,
    toolUseId: Schema.String,
    options: Schema.Array(PermissionOptionSchema),
  }),
  Schema.TaggedStruct("TurnComplete", {
    finishReason: StopReasonSchema,
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
