export {
  type PermissionRespondInput,
  type PermissionRespondOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
} from "@firegrid/protocol/agent-tools"
import {
  PermissionRespondInputSchema,
  PermissionRespondOutputSchema,
  SessionPromptToolInputSchema,
  SessionPromptToolOutputSchema,
} from "@firegrid/protocol/agent-tools"
import { RuntimeInputIntentRowSchema } from "@firegrid/protocol/runtime-ingress"
import {
  SessionAgentOutputWaitInputSchema,
  SessionAgentOutputWaitOutputSchema,
  SessionAttachInputSchema,
  SessionCreateOrLoadInputSchema,
  SessionHandlePromptInputSchema,
  SessionHandleReferenceSchema,
  SessionPermissionRequestWaitInputSchema,
  SessionPermissionRequestWaitOutputSchema,
  SessionPermissionRespondInputSchema,
} from "@firegrid/protocol/session-facade"

const operation = <InputSchema, OutputSchema>(
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
) => ({
  inputSchema,
  outputSchema,
})

export const FiregridClientOperations = {
  sessions: {
    createOrLoad: operation(
      SessionCreateOrLoadInputSchema,
      SessionHandleReferenceSchema,
    ),
    attach: operation(SessionAttachInputSchema, SessionHandleReferenceSchema),
    prompt: operation(SessionPromptToolInputSchema, SessionPromptToolOutputSchema),
    promptScoped: operation(
      SessionHandlePromptInputSchema,
      RuntimeInputIntentRowSchema,
    ),
  },
  wait: {
    forAgentOutput: operation(
      SessionAgentOutputWaitInputSchema,
      SessionAgentOutputWaitOutputSchema,
    ),
    forPermissionRequest: operation(
      SessionPermissionRequestWaitInputSchema,
      SessionPermissionRequestWaitOutputSchema,
    ),
  },
  permissions: {
    respond: operation(PermissionRespondInputSchema, PermissionRespondOutputSchema),
    respondScoped: operation(
      SessionPermissionRespondInputSchema,
      PermissionRespondOutputSchema,
    ),
  },
} as const
