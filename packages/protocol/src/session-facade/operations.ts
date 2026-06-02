import { EventOffsetSchema, type EventOffset } from "../channels/core.ts"
import {
  PermissionDecisionSchema,
  PermissionRespondInputSchema,
  SessionCancelToolInputSchema,
  SessionCancelToolOutputSchema,
  SessionCloseToolInputSchema,
  SessionCloseToolOutputSchema,
  SessionPromptToolInputSchema,
  SessionPromptToolOutputSchema,
  type PermissionDecision,
  type PermissionRespondInput,
  type SessionCancelToolInput,
  type SessionCancelToolOutput,
  type SessionCloseToolInput,
  type SessionCloseToolOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
} from "../agent-tools/schema.ts"
import {
  FiregridRuntimeObservationSourceNames,
  type FiregridRuntimeObservationSourceName,
} from "../observations/schema.ts"
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
  type SessionCancelToolInput,
  type SessionCancelToolOutput,
  type SessionCloseToolInput,
  type SessionCloseToolOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
}

export const FiregridClientOperations = {
  sessions: {
    createOrLoad: {
      input: SessionCreateOrLoadInputSchema,
      output: SessionHandleReferenceSchema,
    },
    attach: {
      input: SessionAttachInputSchema,
      output: SessionHandleReferenceSchema,
    },
    prompt: {
      input: SessionPromptToolInputSchema,
      output: SessionPromptToolOutputSchema,
    },
    promptScoped: {
      input: SessionHandlePromptInputSchema,
      output: EventOffsetSchema,
    },
    cancel: {
      input: SessionCancelToolInputSchema,
      output: SessionCancelToolOutputSchema,
    },
    close: {
      input: SessionCloseToolInputSchema,
      output: SessionCloseToolOutputSchema,
    },
  },
  wait: {
    forAgentOutput: {
      input: SessionAgentOutputWaitInputSchema,
      output: SessionAgentOutputWaitOutputSchema,
    },
    forPermissionRequest: {
      input: SessionPermissionRequestWaitInputSchema,
      output: SessionPermissionRequestWaitOutputSchema,
    },
  },
  permissions: {
    respond: {
      input: PermissionRespondInputSchema,
      output: EventOffsetSchema,
    },
    respondScoped: {
      input: SessionPermissionRespondInputSchema,
      output: EventOffsetSchema,
    },
  },
} as const
