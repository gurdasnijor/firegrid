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
  HostContextsChannelTarget,
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
  makeIngressChannel,
  type CallableChannel,
  type EgressChannel,
  type IngressChannel,
} from "../channels/core.ts"
import { RuntimeContextSchema } from "./schema.ts"
import { stampRowOtel } from "../otel/row-otel.ts"
import {
  PublicPromptRequestSchema,
  makeRuntimeInputIntentRow,
  promptToRuntimeIngressRequest,
  type RuntimeIngressRequest,
} from "../runtime-ingress/schema.ts"
import {
  SessionHandlePromptInputSchema,
} from "../session-facade/schema.ts"
import {
  makeRuntimeStartRequestAck,
  makeRuntimeStartRequestRow,
} from "./control-request.ts"
import { requestRuntimeContextCreate } from "./host-context-request-binding.ts"
import { ContextNotFound } from "./host-context-authority.ts"
import {
  type RuntimeControlPlaneTableService,
} from "./table.ts"
import { Effect, Option } from "effect"

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
      requestRuntimeContextCreate(control, request).pipe(
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
        // tf-aago regression guard (#560 review): do NOT record a permission
        // response for a nonexistent context. The pre-channel client path
        // guarded this via resolveContext in appendRuntimeInputIntent; the
        // channel binding must preserve it, otherwise a missing context
        // creates an orphan required_action_result intent AND falsely
        // returns responded:true. Fail fast with a not-found error instead;
        // the client projection maps it to AppendError (no false success).
        const context = yield* control.contexts.get(request.contextId)
        if (Option.isNone(context)) {
          return yield* new ContextNotFound({ contextId: request.contextId })
        }
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

// tf-qu7l: ingress binding for the contexts read-path. binding.stream is the
// RuntimeContext ProjectionStream (current rows + live changes) over
// control.contexts.rows(). Backs both watchContexts (filter by predicate) and
// whenReady (first match on contextId) on the client surface; consumed by the
// host-sdk HostControlChannelsLive too (single source of truth).
export const makeHostContextsChannel = (
  control: RuntimeControlPlaneTableService,
): IngressChannel<typeof RuntimeContextSchema> =>
  makeIngressChannel({
    target: HostContextsChannelTarget,
    schema: RuntimeContextSchema,
    sourceClass: "static-source",
    stream: control.contexts.rows(),
  })
