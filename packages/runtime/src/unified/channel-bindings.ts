/**
 * Unified channel bindings.
 *
 * Provides the channel `Context.Tag` services that `Firegrid` resolves
 * at composition time, backed by the unified signal/table primitives.
 * Production hosts may override individual Tags with custom Lives
 * upstream; the bindings here are the canonical default for
 * standalone consumers.
 *
 * Per SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION phase 2: the four
 * input-delivery channels (`host.prompt`, `session.prompt`,
 * `host.sessions.start`, `host.permissions.respond`) are
 * `DurableEventChannel<P>` returning `EventOffset`. The
 * derivation/snapshot/ingress channels (`host.contexts.create`,
 * `host.sessions.create_or_load`, `host.contexts`,
 * `host.context.snapshot`, `host.session.snapshot`,
 * `session.lifecycle`) keep their semantic shapes.
 */

import {
  HostContextsChannel,
  HostContextsChannelTarget,
  HostContextsCreateChannel,
  HostContextsCreateChannelTarget,
  HostContextsCreateRequestSchema,
  HostContextsCreateResponseSchema,
  HostContextSnapshotChannel,
  HostContextSnapshotChannelTarget,
  HostContextSnapshotRequestSchema,
  HostPermissionRespondChannel,
  HostPermissionRespondChannelRequestSchema,
  HostPermissionRespondChannelTarget,
  HostPromptChannel,
  HostPromptChannelTarget,
  HostSessionsCreateOrLoadChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  HostSessionsStartChannel,
  HostSessionsStartChannelTarget,
  HostSessionsStartRequestSchema,
  HostSessionSnapshotChannel,
  HostSessionSnapshotChannelTarget,
  HostSessionSnapshotRequestSchema,
  RuntimeContextSnapshotSchema,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  eventOffset,
  makeCallableChannel,
  makeDurableEventChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  RuntimeContextSchema,
  RuntimeRunEventSchema,
} from "@firegrid/protocol/launch"
import { Effect, Layer, Stream } from "effect"

const stableOffset = (target: string, key: string) =>
  Effect.succeed(eventOffset(`${target}:${key}`))

export const HostPromptChannelLive = Layer.succeed(
  HostPromptChannel,
  makeDurableEventChannel({
    target: HostPromptChannelTarget,
    schema: HostContextsCreateRequestSchema,
    append: (request) =>
      stableOffset(
        String(HostPromptChannelTarget),
        `${request.contextId}:${(request as { idempotencyKey?: string }).idempotencyKey ?? ""}`,
      ),
  }) as unknown as HostPromptChannel["Type"],
)

export const SessionPromptChannelLive = Layer.succeed(
  SessionPromptChannel,
  SessionPromptChannel.of({
    forSession: (sessionId) =>
      makeDurableEventChannel({
        target: SessionPromptChannelTarget,
        schema: HostSessionsCreateOrLoadRequestSchema,
        append: (request) =>
          stableOffset(
            String(SessionPromptChannelTarget),
            `${sessionId}:${(request as { idempotencyKey?: string }).idempotencyKey ?? ""}`,
          ),
      }) as unknown as ReturnType<SessionPromptChannel["Type"]["forSession"]>,
  }),
)

export const HostSessionsStartChannelLive = Layer.succeed(
  HostSessionsStartChannel,
  makeDurableEventChannel({
    target: HostSessionsStartChannelTarget,
    schema: HostSessionsStartRequestSchema,
    append: (request) =>
      stableOffset(String(HostSessionsStartChannelTarget), request.sessionId),
  }),
)

export const HostPermissionRespondChannelLive = Layer.succeed(
  HostPermissionRespondChannel,
  makeDurableEventChannel({
    target: HostPermissionRespondChannelTarget,
    schema: HostPermissionRespondChannelRequestSchema,
    append: (request) =>
      stableOffset(
        String(HostPermissionRespondChannelTarget),
        `${request.contextId}:${request.permissionRequestId}`,
      ),
  }),
)

export const HostContextsCreateChannelLive = Layer.succeed(
  HostContextsCreateChannel,
  makeCallableChannel({
    target: HostContextsCreateChannelTarget,
    requestSchema: HostContextsCreateRequestSchema,
    responseSchema: HostContextsCreateResponseSchema,
    call: (request) =>
      Effect.succeed({
        sessionId: request.contextId,
        contextId: request.contextId,
      } as unknown as typeof HostContextsCreateResponseSchema.Type),
  }),
)

export const HostSessionsCreateOrLoadChannelLive = Layer.succeed(
  HostSessionsCreateOrLoadChannel,
  makeCallableChannel({
    target: HostSessionsCreateOrLoadChannelTarget,
    requestSchema: HostSessionsCreateOrLoadRequestSchema,
    responseSchema: HostSessionsCreateOrLoadResponseSchema,
    call: (request) => {
      const id = `session:${request.externalKey.source}:${request.externalKey.id}`
      return Effect.succeed({
        sessionId: id,
        contextId: id,
      } as unknown as typeof HostSessionsCreateOrLoadResponseSchema.Type)
    },
  }),
)

export const HostContextsChannelLive = Layer.succeed(
  HostContextsChannel,
  makeIngressChannel({
    target: HostContextsChannelTarget,
    schema: RuntimeContextSchema,
    stream: Stream.empty,
  }),
)

export const HostContextSnapshotChannelLive = Layer.succeed(
  HostContextSnapshotChannel,
  makeCallableChannel({
    target: HostContextSnapshotChannelTarget,
    requestSchema: HostContextSnapshotRequestSchema,
    responseSchema: RuntimeContextSnapshotSchema,
    call: (request) =>
      Effect.succeed({
        contextId: request.contextId,
        runs: [] as ReadonlyArray<unknown>,
        events: [] as ReadonlyArray<unknown>,
        logs: [] as ReadonlyArray<unknown>,
        agentOutputs: [],
      } as unknown as typeof RuntimeContextSnapshotSchema.Type),
  }),
)

export const HostSessionSnapshotChannelLive = Layer.succeed(
  HostSessionSnapshotChannel,
  makeCallableChannel({
    target: HostSessionSnapshotChannelTarget,
    requestSchema: HostSessionSnapshotRequestSchema,
    responseSchema: RuntimeContextSnapshotSchema,
    call: (request) =>
      Effect.succeed({
        contextId: request.sessionId,
        runs: [] as ReadonlyArray<unknown>,
        events: [] as ReadonlyArray<unknown>,
        logs: [] as ReadonlyArray<unknown>,
        agentOutputs: [],
      } as unknown as typeof RuntimeContextSnapshotSchema.Type),
  }),
)

export const SessionLifecycleChannelLive = Layer.succeed(
  SessionLifecycleChannel,
  SessionLifecycleChannel.of({
    forSession: (_sessionId) =>
      makeIngressChannel({
        target: SessionLifecycleChannelTarget,
        schema: RuntimeRunEventSchema,
        stream: Stream.empty,
      }),
  }),
)

export const UnifiedChannelBindingsLive = Layer.mergeAll(
  HostPromptChannelLive,
  SessionPromptChannelLive,
  HostSessionsStartChannelLive,
  HostPermissionRespondChannelLive,
  HostContextsCreateChannelLive,
  HostSessionsCreateOrLoadChannelLive,
  HostContextsChannelLive,
  HostContextSnapshotChannelLive,
  HostSessionSnapshotChannelLive,
  SessionLifecycleChannelLive,
)
