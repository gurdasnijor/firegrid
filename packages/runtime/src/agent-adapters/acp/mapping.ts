import type * as acp from "@agentclientprotocol/sdk"
import { type Prompt, Response } from "@effect/ai"
import { Effect, Match } from "effect"
import {
  acpStopReasonToFinishReason as sharedAcpStopReasonToFinishReason,
  acpUserPromptPartToContentBlock,
} from "../../codecs/acp/mapping.ts"
import { AdapterProtocolError, AdapterUnsupportedFeature } from "../errors.ts"

// firegrid-effect-ai-native-agents.ACP_ADAPTER.4
export const acpStopReasonToFinishReason = sharedAcpStopReasonToFinishReason

// firegrid-effect-ai-native-agents.ACP_ADAPTER.2
// firegrid-effect-ai-native-agents.ACP_ADAPTER.10
//
// Translate a Prompt to ACP ContentBlocks for a single new user turn.
// ACP sessions are stateful and the agent retains prior turns
// server-side, so the adapter sends ONLY the new user input. To
// avoid silently dropping caller-supplied context that would not
// survive that translation, the adapter rejects:
//
//   - prompts that contain no messages
//   - prompts that contain more than one message
//   - prompts whose single message is not a user message
//
// Callers that want to seed system / assistant / tool / earlier-user
// content must do so through an explicit multi-message protocol (a
// future PermissionedAdapter / AcpAdapter capability tag, or a
// deliberate "replay history into ACP" helper). The base
// LanguageModel view fails loudly rather than producing a lossy
// translation that diverges from caller intent.
export const promptToAcpContent = (
  prompt: Prompt.Prompt,
): Effect.Effect<Array<acp.ContentBlock>, AdapterProtocolError | AdapterUnsupportedFeature> => {
  if (prompt.content.length === 0) {
    return Effect.fail(
      new AdapterProtocolError({
        op: "send-prompt",
        message: "ACP adapter requires exactly one user message; prompt is empty",
      }),
    )
  }
  if (prompt.content.length > 1) {
    const roles = prompt.content.map(message => message.role).join(",")
    return Effect.fail(
      new AdapterUnsupportedFeature({
        feature: "multi-message-prompt",
        message:
          `ACP adapter supports exactly one user message per streamText/generateText call; received ${String(prompt.content.length)} messages (roles: ${roles}). ACP sessions are stateful and the agent retains prior turns server-side; replaying history through the base LanguageModel view is not supported.`,
      }),
    )
  }
  const message = prompt.content[0]!
  if (message.role !== "user") {
    return Effect.fail(
      new AdapterUnsupportedFeature({
        feature: `prompt-role:${message.role}`,
        message:
          `ACP adapter accepts only user-role messages in the base LanguageModel view; received role "${message.role}". System / assistant / tool messages must be expressed through a capability tag.`,
      }),
    )
  }
  return Effect.forEach(message.content, part =>
    acpUserPromptPartToContentBlock(part).pipe(
      Effect.mapError(error =>
        new AdapterUnsupportedFeature({
          feature: `prompt-part:${error.partType}`,
          message: `ACP adapter does not support ${error.partType} prompt parts`,
        })),
    ))
}

// firegrid-effect-ai-native-agents.ACP_ADAPTER.3
// Translate a single ACP session update into zero or more decoded
// Response.StreamPart values. tool_call_update and other non-base
// observations are dropped from the base LanguageModel view by
// design; a future PermissionedAdapter/AcpAdapter capability tag may
// expose them separately.
export const acpSessionUpdateToStreamParts = (
  params: acp.SessionNotification,
  textDeltaId: (messageId: string | undefined) => Effect.Effect<string>,
): Effect.Effect<ReadonlyArray<Response.StreamPart<Record<string, never>>>> => {
  const update = params.update
  return Match.value(update).pipe(
    Match.when({ sessionUpdate: "agent_message_chunk" }, chunk => {
      const content = chunk.content
      if (content.type !== "text") {
        return Effect.succeed([])
      }
      return textDeltaId(chunk.messageId ?? undefined).pipe(
        Effect.map(id => [
          Response.textDeltaPart({
            id,
            delta: content.text,
          }),
        ]),
      )
    }),
    // firegrid-effect-ai-native-agents.ACP_ADAPTER.11
    //
    // ACP tool_call notifications are agent-executed observations:
    // the agent itself runs the tool and reports back; the protocol
    // has no client-supplied tool-result path on the base view. From
    // Effect AI's perspective this is provider-executed
    // (`providerExecuted: true`), not a framework-resolved tool call.
    //
    // The Effect AI `name` field is set from ACP's `title`, which is
    // a human-readable description rather than a machine identifier.
    // ACP does not currently expose a separate tool-name field on
    // `tool_call`, so this mapping is deliberately lossy. Consumers
    // that need a stable machine identifier should rely on
    // `tool-call.id` (= ACP `toolCallId`), not on `name`.
    Match.when({ sessionUpdate: "tool_call" }, toolCall =>
      Effect.succeed([
        Response.toolCallPart({
          id: toolCall.toolCallId,
          name: toolCall.title,
          params: toolCall.rawInput,
          providerExecuted: true,
        }) as Response.StreamPart<Record<string, never>>,
      ])),
    Match.orElse(() => Effect.succeed([])),
  )
}
