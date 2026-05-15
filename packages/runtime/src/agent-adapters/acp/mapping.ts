import type * as acp from "@agentclientprotocol/sdk"
import { type Prompt, Response } from "@effect/ai"
import { Effect, Match } from "effect"
import {
  acpStopReasonToFinishReason as sharedAcpStopReasonToFinishReason,
  acpUserPromptPartToContentBlock,
} from "../../agent-codecs/acp/mapping.ts"
import { AdapterProtocolError, AdapterUnsupportedFeature } from "../errors.ts"

// firegrid-effect-ai-native-agents.ACP_ADAPTER.4
export const acpStopReasonToFinishReason = sharedAcpStopReasonToFinishReason

// firegrid-effect-ai-native-agents.ACP_ADAPTER.2
// Extract the most recent user message from a Prompt and translate
// its parts to ACP ContentBlocks. ACP sessions are stateful, so prior
// turns remain server-side memory; the adapter sends only the new
// user input.
export const promptToAcpContent = (
  prompt: Prompt.Prompt,
): Effect.Effect<Array<acp.ContentBlock>, AdapterProtocolError | AdapterUnsupportedFeature> => {
  const lastUser = [...prompt.content].reverse().find(message => message.role === "user")
  if (lastUser === undefined) {
    return Effect.fail(
      new AdapterProtocolError({
        op: "send-prompt",
        message: "ACP adapter requires at least one user message in the prompt",
      }),
    )
  }
  return Effect.forEach(lastUser.content, part =>
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
    Match.when({ sessionUpdate: "tool_call" }, toolCall =>
      Effect.succeed([
        Response.toolCallPart({
          id: toolCall.toolCallId,
          name: toolCall.title,
          params: toolCall.rawInput,
          providerExecuted: false,
        }) as Response.StreamPart<Record<string, never>>,
      ])),
    Match.orElse(() => Effect.succeed([])),
  )
}
