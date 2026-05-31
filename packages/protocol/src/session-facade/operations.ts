import { EventOffsetSchema, type EventOffset } from "../channels/core.ts"
import {
  PermissionDecisionSchema,
  PermissionRespondInputSchema,
  SessionPromptToolInputSchema,
  SessionPromptToolOutputSchema,
  type PermissionDecision,
  type PermissionRespondInput,
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
  type EventOffset,
  type FiregridRuntimeObservationSourceName,
  type PermissionDecision,
  type PermissionRespondInput,
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
      EventOffsetSchema,
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
      EventOffsetSchema,
    ),
    respondScoped: defineFiregridOperation(
      SessionPermissionRespondInputSchema,
      EventOffsetSchema,
    ),
  },
} as const
