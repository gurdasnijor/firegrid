import type * as acp from "@agentclientprotocol/sdk"
import type { Prompt, Response } from "@effect/ai"
import { Effect, Match } from "effect"

/**
 * Pure ACP <-> Effect AI mapping helpers shared by the ACP codec
 * (Firegrid AgentOutputEvent shape) and the ACP agent adapter
 * (LanguageModel.Service shape). Keeping these in one place avoids
 * forking the protocol surface across two consumers.
 */

// firegrid-effect-ai-native-agents.ACP_ADAPTER.4
export const acpStopReasonToFinishReason = (
  stopReason: acp.StopReason,
): Response.FinishReason =>
  Match.value(stopReason).pipe(
    Match.when("end_turn", () => "stop" as const),
    Match.when("cancelled", () => "other" as const),
    Match.when("max_tokens", () => "length" as const),
    Match.when("max_turn_requests", () => "length" as const),
    Match.when("refusal", () => "error" as const),
    Match.exhaustive,
  )

class AcpUnsupportedPromptPart {
  readonly _tag = "AcpUnsupportedPromptPart"
  constructor(readonly partType: string) {}
}

// Pure Effect mapper: callers (codec, adapter) wrap the failure
// (carrying the unsupported `partType`) into their own domain error.
export const acpUserPromptPartToContentBlock = (
  part: Prompt.UserMessagePart,
): Effect.Effect<acp.ContentBlock, { readonly partType: string }> =>
  Match.value(part).pipe(
    Match.when({ type: "text" }, text =>
      Effect.succeed({
        type: "text" as const,
        text: text.text,
      } satisfies acp.ContentBlock)),
    Match.orElse(other =>
      Effect.fail(new AcpUnsupportedPromptPart(other.type))),
  )
