import type {
  RuntimeControlPlaneTable,
  RuntimeInputIntentRow,
} from "@firegrid/protocol/launch"
import type {
  SessionPermissionChannelRequest,
  SessionPermissionChannelResponse,
} from "@firegrid/protocol/channels/session-permission"
import { makeRuntimeInputIntentRow } from "@firegrid/protocol/runtime-ingress"
import { stampRowOtel } from "@firegrid/protocol/otel"
import { Effect } from "effect"

// tf-bffo: the durable SessionPermission response wiring (build the input-intent
// row + idempotent RuntimeControlPlaneTable.inputIntents.insertOrGet) lives in the
// runtime. host-sdk only COMPOSES it (channel contract + binding selection).

type PermissionRequestWithDecision = SessionPermissionChannelRequest & {
  readonly decision: NonNullable<SessionPermissionChannelRequest["decision"]>
}

const permissionResponseMetadata = (
  request: SessionPermissionChannelRequest,
): Readonly<Record<string, string>> | undefined =>
  request.responseOrigin === undefined
    ? undefined
    : { "firegrid.permission.response.origin": request.responseOrigin }

const makePermissionIntent = (
  sessionId: string,
  request: PermissionRequestWithDecision,
): RuntimeInputIntentRow =>
  makeRuntimeInputIntentRow({
    contextId: sessionId,
    kind: "required_action_result",
    authoredBy: "client",
    payload: {
      _tag: "PermissionResponse",
      permissionRequestId: request.permissionRequestId,
      decision: request.decision,
    },
    idempotencyKey: request.idempotencyKey ??
      `permission-response:${sessionId}:${request.permissionRequestId}`,
    metadata: permissionResponseMetadata(request),
  })

export const submitSessionPermissionResponse = (
  control: RuntimeControlPlaneTable["Type"],
  sessionId: string,
  request: PermissionRequestWithDecision,
): Effect.Effect<SessionPermissionChannelResponse, unknown> =>
  Effect.gen(function*() {
    const intent = makePermissionIntent(sessionId, request)
    const stamped = yield* stampRowOtel(intent)
    const stored = yield* control.inputIntents.insertOrGet(stamped)
    const row = stored._tag === "Found" ? stored.row : stamped
    return {
      responded: true,
      contextId: sessionId,
      permissionRequestId: request.permissionRequestId,
      inputId: row.intentId,
    }
  })
