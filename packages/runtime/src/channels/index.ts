export {
  sessionAgentOutputChannel,
  type SessionAgentOutputChannelOptions,
} from "./session-agent-output.ts"
export {
  SessionAgentOutputRouteInputSchema,
  sessionAgentOutputObservationRoute,
  type SessionAgentOutputRouteInput,
} from "./session-agent-output-route.ts"
export {
  SessionLifecycleRouteInputSchema,
  type SessionLifecycleRouteInput,
} from "./session-lifecycle-route.ts"
// `submitSessionPermissionResponse` deleted per SDD_FIREGRID_PROTOCOL_
// RESPONSE_UNIFICATION phase 2. Permission responses flow as signals
// to PermissionRoundtripWorkflow via the unified channel bindings.
export {
  sessionLogChannel,
  sessionLogChannelFromCollection,
} from "./session-log.ts"
export * from "./router.ts"
export type { ChannelMetadata } from "./router/live.ts"
export * from "./host-control.ts"
