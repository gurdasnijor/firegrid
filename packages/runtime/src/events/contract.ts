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

import { Prompt } from "@effect/ai"
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Effect AI semantic payloads
// ---------------------------------------------------------------------------

export const AgentPromptSchema = Prompt.UserMessage
export type AgentPrompt = Prompt.UserMessage

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

// firegrid TFIND-035: the agent-output event union and its part
// sub-schemas are canonical in `@firegrid/protocol/agent-output` (the
// dependency graph is one-directional: runtime depends on protocol).
// Re-exported here so runtime codecs and `@firegrid/runtime/events`
// consumers keep their existing import paths unchanged.
export {
  AgentCapabilitiesSchema,
  type AgentCapabilities,
  AgentOutputEventSchema,
  type AgentOutputEvent,
  AgentTextDeltaPartSchema,
  type AgentTextDeltaPart,
  AgentToolCallPartSchema,
  type AgentToolCallPart,
  AgentToolResultEventSchema,
  PermissionOptionKindSchema,
  type PermissionOptionKind,
  PermissionOptionSchema,
  type PermissionOption,
  StopReasonSchema,
  type StopReason,
} from "@firegrid/protocol/agent-output"

// Session-mode authority (NOT part of the output event union); stays
// runtime-owned.
export const AgentToolUseModeSchema = Schema.Literal(
  "observation_only",
  "client_result_roundtrip",
  "control_channel_request_response",
)
export type AgentToolUseMode = Schema.Schema.Type<typeof AgentToolUseModeSchema>
