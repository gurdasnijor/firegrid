import {
  RuntimeInputIntentRowSchema,
} from "../runtime-ingress/schema.ts"
import {
  PermissionDecisionSchema,
  PermissionRespondInputSchema,
  PermissionRespondOutputSchema,
  SessionPromptToolInputSchema,
  SessionPromptToolOutputSchema,
  type PermissionDecision,
  type PermissionRespondInput,
  type PermissionRespondOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
} from "../agent-tools/schema.ts"
import {
  FiregridRuntimeObservationSourceNames,
  type FiregridRuntimeObservationSourceName,
} from "../observations/schema.ts"
import { defineFiregridOperation } from "../operations/schema.ts"
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
} from "./schema.ts"

export {
  FiregridRuntimeObservationSourceNames,
  PermissionDecisionSchema,
  type FiregridRuntimeObservationSourceName,
  type PermissionDecision,
  type PermissionRespondInput,
  type PermissionRespondOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
}

export const FiregridClientOperations = {
  sessions: {
    createOrLoad: defineFiregridOperation(
      SessionCreateOrLoadInputSchema,
      SessionHandleReferenceSchema,
    ),
    attach: defineFiregridOperation(
      SessionAttachInputSchema,
      SessionHandleReferenceSchema,
    ),
    prompt: defineFiregridOperation(
      SessionPromptToolInputSchema,
      SessionPromptToolOutputSchema,
    ),
    promptScoped: defineFiregridOperation(
      SessionHandlePromptInputSchema,
      RuntimeInputIntentRowSchema,
    ),
  },
  wait: {
    forAgentOutput: defineFiregridOperation(
      SessionAgentOutputWaitInputSchema,
      SessionAgentOutputWaitOutputSchema,
    ),
    forPermissionRequest: defineFiregridOperation(
      SessionPermissionRequestWaitInputSchema,
      SessionPermissionRequestWaitOutputSchema,
    ),
  },
  permissions: {
    respond: defineFiregridOperation(
      PermissionRespondInputSchema,
      PermissionRespondOutputSchema,
    ),
    respondScoped: defineFiregridOperation(
      SessionPermissionRespondInputSchema,
      PermissionRespondOutputSchema,
    ),
  },
} as const
