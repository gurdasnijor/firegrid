// tf-aago: shared binding factories for the host-control callable/egress
// channels. Mirrors the createOrLoad precedent
// (`host-session-create-or-load-request.ts`): each factory takes a
// `RuntimeControlPlaneTableService` and returns the protocol-owned channel
// value whose binding closes over `control`. Both the host-sdk Live Layer
// (`HostControlChannelsLive`) and the client-sdk standalone-default Layer
// consume these, so the substrate-write logic has a single source of truth
// and neither package re-implements it (no client→host-sdk import; no
// duplicated insertOrGet bodies).
//
// These are the write paths the SDD §"What This Unifies" + Cycle-2
// synthesis §1.2 #3 named as the per-method substrate-dispatch collapse:
// contextRequests / inputIntents / startRequests inserts behind callable
// + egress channel verbs.

import {
  HostContextsCreateChannelTarget,
  HostContextsCreateRequestSchema,
  HostContextsCreateResponseSchema,
  HostPermissionRespondChannelRequestSchema,
  HostPermissionRespondChannelResponseSchema,
  HostPermissionRespondChannelTarget,
  HostPromptChannelTarget,
  HostSessionsStartChannelTarget,
  HostSessionsStartRequestSchema,
  HostSessionsStartResponseSchema,
  SessionPromptChannelTarget,
  type HostPermissionRespondChannelRequest,
} from "../channels/host-control.ts"
import {
  makeCallableChannel,
  makeEgressChannel,
  type CallableChannel,
  type EgressChannel,
} from "../channels/core.ts"
import { stampRowOtel } from "../otel/row-otel.ts"
import {
  PublicPromptRequestSchema,
  makeRuntimeInputIntentRow,
  promptToRuntimeIngressRequest,
  type RuntimeIngressRequest,
} from "../runtime-ingress/schema.ts"
import {
  FiregridSessionIdSchema,
  RuntimeContextIdSchema,
  SessionHandlePromptInputSchema,
} from "../session-facade/schema.ts"
import {
  makeRuntimeContextRequestRow,
  makeRuntimeStartRequestAck,
  makeRuntimeStartRequestRow,
} from "./control-request.ts"
import {
  type RuntimeControlPlaneTableService,
} from "./table.ts"
import { Effect, Schema } from "effect"

const appendInputIntent = (
  control: RuntimeControlPlaneTableService,
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function*() {
    const stamped = yield* stampRowOtel(makeRuntimeInputIntentRow(request))
    const result = yield* control.inputIntents.insertOrGet(stamped)
    return result._tag === "Found" ? result.row : stamped
  })

const permissionResponseInput = (
  request: HostPermissionRespondChannelRequest,
): RuntimeIngressRequest => ({
  contextId: request.contextId,
  kind: "required_action_result" as const,
  authoredBy: "client" as const,
  payload: {
    _tag: "PermissionResponse",
    permissionRequestId: request.permissionRequestId,
    decision: request.decision,
  },
  idempotencyKey: request.idempotencyKey ??
    `permission-response:${request.contextId}:${request.permissionRequestId}`,
})

export const makeHostContextsCreateChannel = (
  control: RuntimeControlPlaneTableService,
): CallableChannel<
  typeof HostContextsCreateRequestSchema,
  typeof HostContextsCreateResponseSchema
> =>
  makeCallableChannel({
    target: HostContextsCreateChannelTarget,
    requestSchema: HostContextsCreateRequestSchema,
    responseSchema: HostContextsCreateResponseSchema,
    call: (request) =>
      Effect.gen(function*() {
        const stamped = yield* stampRowOtel(
          makeRuntimeContextRequestRow({
            contextId: request.contextId,
            runtime: request.runtime,
            ...(request.createdBy === undefined
              ? {}
              : { createdBy: request.createdBy }),
          }),
        )
        yield* control.contextRequests.insertOrGet(stamped)
        const sessionId = yield* Schema.decodeUnknown(FiregridSessionIdSchema)(
          request.contextId,
        )
        const contextId = yield* Schema.decodeUnknown(RuntimeContextIdSchema)(
          request.contextId,
        )
        return { sessionId, contextId }
      }).pipe(
        Effect.withSpan("firegrid.channel.host.contexts.create.call", {
          kind: "internal",
          attributes: {
            "firegrid.channel.target": HostContextsCreateChannelTarget,
            "firegrid.channel.direction": "call",
            "firegrid.context.id": request.contextId,
          },
        }),
      ),
  })

export const makeHostPromptChannel = (
  control: RuntimeControlPlaneTableService,
): EgressChannel<typeof PublicPromptRequestSchema> =>
  makeEgressChannel({
    target: HostPromptChannelTarget,
    schema: PublicPromptRequestSchema,
    append: (request) =>
      appendInputIntent(control, promptToRuntimeIngressRequest(request)).pipe(
        Effect.asVoid,
      ),
  })

export const makeSessionPromptChannelForSession = (
  control: RuntimeControlPlaneTableService,
  sessionId: string,
): EgressChannel<typeof SessionHandlePromptInputSchema> =>
  makeEgressChannel({
    target: SessionPromptChannelTarget,
    schema: SessionHandlePromptInputSchema,
    append: (request) =>
      appendInputIntent(control, {
        contextId: sessionId,
        kind: "message",
        authoredBy: "client",
        payload: request.payload,
        idempotencyKey: request.idempotencyKey,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      }).pipe(Effect.asVoid),
  })

export const makeHostSessionsStartChannel = (
  control: RuntimeControlPlaneTableService,
): CallableChannel<
  typeof HostSessionsStartRequestSchema,
  typeof HostSessionsStartResponseSchema
> =>
  makeCallableChannel({
    target: HostSessionsStartChannelTarget,
    requestSchema: HostSessionsStartRequestSchema,
    responseSchema: HostSessionsStartResponseSchema,
    call: (request) =>
      Effect.gen(function*() {
        const row = makeRuntimeStartRequestRow({
          contextId: request.sessionId,
          requestedBy: "client",
        })
        const stamped = yield* stampRowOtel(row)
        const result = yield* control.startRequests.insertOrGet(stamped)
        return makeRuntimeStartRequestAck({
          requestId: row.requestId,
          contextId: row.contextId,
          inserted: result._tag === "Inserted",
        })
      }).pipe(
        Effect.withSpan("firegrid.channel.host.sessions.start.call", {
          kind: "internal",
          attributes: {
            "firegrid.channel.target": HostSessionsStartChannelTarget,
            "firegrid.channel.direction": "call",
            "firegrid.context.id": request.sessionId,
          },
        }),
      ),
  })

export const makeHostPermissionRespondChannel = (
  control: RuntimeControlPlaneTableService,
): CallableChannel<
  typeof HostPermissionRespondChannelRequestSchema,
  typeof HostPermissionRespondChannelResponseSchema
> =>
  makeCallableChannel({
    target: HostPermissionRespondChannelTarget,
    requestSchema: HostPermissionRespondChannelRequestSchema,
    responseSchema: HostPermissionRespondChannelResponseSchema,
    call: (request) =>
      Effect.gen(function*() {
        const row = yield* appendInputIntent(
          control,
          permissionResponseInput(request),
        )
        return {
          responded: true as const,
          contextId: request.contextId,
          permissionRequestId: request.permissionRequestId,
          inputId: row.intentId,
        }
      }).pipe(
        Effect.withSpan("firegrid.channel.host.permissions.respond.call", {
          kind: "internal",
          attributes: {
            "firegrid.channel.target": HostPermissionRespondChannelTarget,
            "firegrid.channel.direction": "call",
            "firegrid.context.id": request.contextId,
          },
        }),
      ),
  })
