import {
  RuntimeIngressInputRowSchema,
} from "../runtime-ingress/schema.ts"
import {
  FiregridRuntimeObservationSourceNames,
  PermissionDecisionSchema,
  PermissionRespondInputSchema,
  PermissionRespondOutputSchema,
  SessionPromptToolInputSchema,
  SessionPromptToolOutputSchema,
  WaitForToolInputSchema,
  WaitForToolOutputSchema,
  type FiregridRuntimeObservationSourceName,
  type PermissionDecision,
  type PermissionRespondInput,
  type PermissionRespondOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
  type WaitForToolInput,
  type WaitForToolOutput,
} from "../agent-tools/schema.ts"
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
  type WaitForToolInput,
  type WaitForToolOutput,
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
      RuntimeIngressInputRowSchema,
    ),
  },
  wait: {
    for: defineFiregridOperation(
      WaitForToolInputSchema,
      WaitForToolOutputSchema,
    ),
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
