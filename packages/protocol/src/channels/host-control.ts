import { Context, Schema } from "effect"
import {
  PermissionRespondInputSchema,
} from "../agent-tools/schema.ts"
import {
  PublicLaunchRuntimeIntentSchema,
} from "../launch/schema.ts"
import type { RuntimeRunEventSchema } from "../launch/schema.ts"
import type {
  PublicPromptRequestSchema,
} from "../runtime-ingress/schema.ts"
import {
  SessionHandleReferenceSchema,
} from "../session-facade/schema.ts"
import type { SessionHandlePromptInputSchema } from "../session-facade/schema.ts"
import {
  makeChannelTarget,
  type CallableChannel,
  type DurableEventChannel,
  type IngressChannel,
} from "./core.ts"

export const HostContextsCreateChannelTarget = makeChannelTarget(
  "host.contexts.create",
)

export const HostContextsCreateRequestSchema = Schema.Struct({
  contextId: Schema.String.pipe(Schema.minLength(1)),
  runtime: PublicLaunchRuntimeIntentSchema,
  createdBy: Schema.optional(Schema.String),
  parentContextId: Schema.optional(Schema.String),
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

// Synchronous derivation — returns a `SessionHandleReference` derived
// from the externalKey/contextId. Stays as `CallableChannel`; not an
// input-delivery operation.
export type HostContextsCreateChannelService = CallableChannel<
  typeof HostContextsCreateRequestSchema,
  typeof HostContextsCreateResponseSchema
>

export class HostContextsCreateChannel extends Context.Tag(
  "firegrid/protocol/channels/host.contexts.create",
)<HostContextsCreateChannel, HostContextsCreateChannelService>() {}

// ── Input-delivery channels — `DurableEventChannel<P>` ─────────────
// Per SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.

export const HostPromptChannelTarget = makeChannelTarget("host.prompt")
export type HostPromptChannelService = DurableEventChannel<
  typeof PublicPromptRequestSchema
>

export class HostPromptChannel extends Context.Tag(
  "firegrid/protocol/channels/host.prompt",
)<HostPromptChannel, HostPromptChannelService>() {}

export const SessionPromptChannelTarget = makeChannelTarget("session.prompt")
export interface SessionPromptChannelService {
  readonly forSession: (
    sessionId: string,
  ) => DurableEventChannel<typeof SessionHandlePromptInputSchema>
}

export class SessionPromptChannel extends Context.Tag(
  "firegrid/protocol/channels/session.prompt",
)<SessionPromptChannel, SessionPromptChannelService>() {}


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
export type HostPermissionRespondChannelService = DurableEventChannel<
  typeof HostPermissionRespondChannelRequestSchema
>

export class HostPermissionRespondChannel extends Context.Tag(
  "firegrid/protocol/channels/host.permissions.respond",
)<HostPermissionRespondChannel, HostPermissionRespondChannelService>() {}
