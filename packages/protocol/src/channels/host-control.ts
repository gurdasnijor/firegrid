import { Context, Schema } from "effect"
import {
  PermissionRespondInputSchema,
  PermissionRespondOutputSchema,
} from "../agent-tools/schema.ts"
import {
  PublicLaunchRuntimeIntentSchema,
  RuntimeContextSchema,
} from "../launch/schema.ts"
import type { RuntimeRunEventSchema } from "../launch/schema.ts"
import {
  RuntimeStartRequestAckSchema,
} from "../launch/control-request.ts"
import type { PublicPromptRequestSchema } from "../runtime-ingress/schema.ts"
import {
  RuntimeAgentOutputObservationSchema,
  SessionHandleReferenceSchema,
} from "../session-facade/schema.ts"
import type { SessionHandlePromptInputSchema } from "../session-facade/schema.ts"
import {
  makeChannelTarget,
  type CallableChannel,
  type EgressChannel,
  type IngressChannel,
} from "./core.ts"

export const HostContextsCreateChannelTarget = makeChannelTarget(
  "host.contexts.create",
)

export const HostContextsCreateRequestSchema = Schema.Struct({
  contextId: Schema.String.pipe(Schema.minLength(1)),
  runtime: PublicLaunchRuntimeIntentSchema,
  createdBy: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.channel.hostContextsCreate.request",
  title: "Host contexts create request",
})
export type HostContextsCreateRequest = Schema.Schema.Type<
  typeof HostContextsCreateRequestSchema
>

export const HostContextsCreateResponseSchema = SessionHandleReferenceSchema
export type HostContextsCreateResponse = Schema.Schema.Type<
  typeof HostContextsCreateResponseSchema
>

export type HostContextsCreateChannelService = CallableChannel<
  typeof HostContextsCreateRequestSchema,
  typeof HostContextsCreateResponseSchema
>

export class HostContextsCreateChannel extends Context.Tag(
  "firegrid/protocol/channels/host.contexts.create",
)<HostContextsCreateChannel, HostContextsCreateChannelService>() {}

export const HostPromptChannelTarget = makeChannelTarget("host.prompt")
export type HostPromptChannelService = EgressChannel<typeof PublicPromptRequestSchema>

export class HostPromptChannel extends Context.Tag(
  "firegrid/protocol/channels/host.prompt",
)<HostPromptChannel, HostPromptChannelService>() {}

export const SessionPromptChannelTarget = makeChannelTarget("session.prompt")
export interface SessionPromptChannelService {
  readonly forSession: (
    sessionId: string,
  ) => EgressChannel<typeof SessionHandlePromptInputSchema>
}

export class SessionPromptChannel extends Context.Tag(
  "firegrid/protocol/channels/session.prompt",
)<SessionPromptChannel, SessionPromptChannelService>() {}

export const HostSessionsStartChannelTarget = makeChannelTarget(
  "host.sessions.start",
)

export const HostSessionsStartRequestSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.channel.hostSessionsStart.request",
  title: "Host sessions start request",
})
export type HostSessionsStartRequest = Schema.Schema.Type<
  typeof HostSessionsStartRequestSchema
>

export const HostSessionsStartResponseSchema = RuntimeStartRequestAckSchema
export type HostSessionsStartResponse = Schema.Schema.Type<
  typeof HostSessionsStartResponseSchema
>

export type HostSessionsStartChannelService = CallableChannel<
  typeof HostSessionsStartRequestSchema,
  typeof HostSessionsStartResponseSchema
>

export class HostSessionsStartChannel extends Context.Tag(
  "firegrid/protocol/channels/host.sessions.start",
)<HostSessionsStartChannel, HostSessionsStartChannelService>() {}

export const HostContextSnapshotChannelTarget = makeChannelTarget(
  "host.context.snapshot",
)
export const HostSessionSnapshotChannelTarget = makeChannelTarget(
  "host.session.snapshot",
)

export const HostContextSnapshotRequestSchema = Schema.Struct({
  contextId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.channel.hostContextSnapshot.request",
  title: "Host context snapshot request",
})
export type HostContextSnapshotRequest = Schema.Schema.Type<
  typeof HostContextSnapshotRequestSchema
>

export const HostSessionSnapshotRequestSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.channel.hostSessionSnapshot.request",
  title: "Host session snapshot request",
})
export type HostSessionSnapshotRequest = Schema.Schema.Type<
  typeof HostSessionSnapshotRequestSchema
>

export const RuntimeContextSnapshotSchema = Schema.Struct({
  contextId: Schema.String.pipe(Schema.minLength(1)),
  context: Schema.optional(RuntimeContextSchema),
  status: Schema.optional(Schema.Literal("started", "exited", "failed")),
  runs: Schema.Array(Schema.Unknown),
  events: Schema.Array(Schema.Unknown),
  logs: Schema.Array(Schema.Unknown),
  agentOutputs: Schema.Array(RuntimeAgentOutputObservationSchema),
}).annotations({
  identifier: "firegrid.channel.runtimeContextSnapshot",
  title: "Runtime context snapshot",
})
export type RuntimeContextSnapshot = Schema.Schema.Type<
  typeof RuntimeContextSnapshotSchema
>

export type HostContextSnapshotChannelService = CallableChannel<
  typeof HostContextSnapshotRequestSchema,
  typeof RuntimeContextSnapshotSchema
>

export type HostSessionSnapshotChannelService = CallableChannel<
  typeof HostSessionSnapshotRequestSchema,
  typeof RuntimeContextSnapshotSchema
>

export class HostContextSnapshotChannel extends Context.Tag(
  "firegrid/protocol/channels/host.context.snapshot",
)<HostContextSnapshotChannel, HostContextSnapshotChannelService>() {}

export class HostSessionSnapshotChannel extends Context.Tag(
  "firegrid/protocol/channels/host.session.snapshot",
)<HostSessionSnapshotChannel, HostSessionSnapshotChannelService>() {}

export const HostContextsChannelTarget = makeChannelTarget("host.contexts")
export type HostContextsChannelService = IngressChannel<typeof RuntimeContextSchema>

export class HostContextsChannel extends Context.Tag(
  "firegrid/protocol/channels/host.contexts",
)<HostContextsChannel, HostContextsChannelService>() {}

export const SessionLifecycleChannelTarget = makeChannelTarget(
  "session.lifecycle",
)
export interface SessionLifecycleChannelService {
  readonly forSession: (
    sessionId: string,
  ) => IngressChannel<typeof RuntimeRunEventSchema>
}

export class SessionLifecycleChannel extends Context.Tag(
  "firegrid/protocol/channels/session.lifecycle",
)<SessionLifecycleChannel, SessionLifecycleChannelService>() {}

export const HostPermissionRespondChannelTarget = makeChannelTarget(
  "host.permissions.respond",
)
export const HostPermissionRespondChannelRequestSchema =
  PermissionRespondInputSchema
export type HostPermissionRespondChannelRequest = Schema.Schema.Type<
  typeof HostPermissionRespondChannelRequestSchema
>
export const HostPermissionRespondChannelResponseSchema =
  PermissionRespondOutputSchema
export type HostPermissionRespondChannelResponse = Schema.Schema.Type<
  typeof HostPermissionRespondChannelResponseSchema
>
export type HostPermissionRespondChannelService = CallableChannel<
  typeof HostPermissionRespondChannelRequestSchema,
  typeof HostPermissionRespondChannelResponseSchema
>

export class HostPermissionRespondChannel extends Context.Tag(
  "firegrid/protocol/channels/host.permissions.respond",
)<HostPermissionRespondChannel, HostPermissionRespondChannelService>() {}
