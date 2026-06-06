export {
  FiregridConfig,
  type ClientOptions,
} from "./config.ts"
export {
  discoverFluentControlClient,
  makeFluentControlClient,
  type FluentControlClient,
  type FluentControlClientOptions,
  type FluentControlDiscoveryOptions,
  type FluentControlHeadResult,
  type FluentControlReadResult,
  type FluentControlSendInput,
  type FluentControlSendResult,
} from "./fluent-control.ts"
export {
  FiregridMcpClientError,
  makeFiregridMcpClient,
  type FiregridMcpClient,
  type FiregridMcpClientOptions,
  type FiregridMcpSessionHandle,
  type FiregridMcpTask,
} from "./mcp.ts"
export {
  autoApproveSessionPermissions,
  type PermissionAutoApproveOptions,
  type PermissionAutoApprovePolicy,
  type PermissionAutoApproveSession,
} from "./permission-auto-approve.ts"
export type {
  PermissionRespondInput,
  SessionCancelToolInput,
  SessionCancelToolOutput,
  SessionCloseToolInput,
  SessionCloseToolOutput,
  SessionPromptToolInput,
  SessionPromptToolOutput,
} from "@firegrid/protocol/agent-tools"
export type {
  PublicPromptRequest,
} from "@firegrid/protocol/runtime-ingress"
export type {
  AgentOutputEvent,
  FiregridSessionId,
  RuntimeAgentOutputEventPayload,
  RuntimeAgentOutputObservation,
  RuntimeContextId,
  RuntimePermissionOption,
  RuntimePermissionRequestObservation,
  SessionAgentOutputWaitInput,
  SessionAgentOutputWaitOutput,
  SessionAttachInput,
  SessionCreateOrLoadInput,
  SessionExternalKey,
  SessionHandlePromptInput,
  SessionPermissionRequestWaitInput,
  SessionPermissionRequestWaitOutput,
  SessionPermissionRespondInput,
} from "@firegrid/protocol/session-facade"
