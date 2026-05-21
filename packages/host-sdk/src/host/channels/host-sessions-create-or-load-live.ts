/**
 * Default Live Layer for `HostSessionsCreateOrLoadChannel`.
 *
 * Pattern 1 binding (from SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md
 * §"Variants of CallableChannel binding"): the request is durably
 * recorded via `RuntimeControlPlaneTable.contextRequests.insertOrGet`
 * (idempotent on the deterministic `requestId` derived from `contextId`)
 * and the response is the stable `{sessionId, contextId}` handle
 * identity. There is no separate completion row to wait on — context
 * creation is fire-and-forget at this seam; downstream readiness is
 * observed through the existing run/output projections.
 *
 * This Live Layer sits BELOW the contract line (which lives in
 * `@firegrid/protocol/channels/host-sessions-create-or-load.ts`). The
 * client-sdk and any agent-tool / MCP projection consume the SAME
 * protocol-owned Tag; only the Live Layer that resolves the Tag's
 * binding differs across composition contexts.
 */

import {
  HostSessionsCreateOrLoadChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  makeCallableChannel,
  type HostSessionsCreateOrLoadResponse,
} from "@firegrid/protocol/channels"
import {
  makeRuntimeContextRequestRow,
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import { stampRowOtel } from "@firegrid/protocol/otel"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { Effect, Layer } from "effect"

export const HostSessionsCreateOrLoadChannelLive = Layer.effect(
  HostSessionsCreateOrLoadChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return makeCallableChannel({
      target: HostSessionsCreateOrLoadChannelTarget,
      requestSchema: HostSessionsCreateOrLoadRequestSchema,
      responseSchema: HostSessionsCreateOrLoadResponseSchema,
      call: (request) =>
        Effect.gen(function*() {
          const contextId = sessionContextIdForExternalKey(request.externalKey)
          const stamped = yield* stampRowOtel(
            makeRuntimeContextRequestRow({
              contextId,
              runtime: request.runtime,
              ...(request.createdBy === undefined
                ? {}
                : { createdBy: request.createdBy }),
            }),
          )
          yield* control.contextRequests.insertOrGet(stamped)
          const response: HostSessionsCreateOrLoadResponse = {
            sessionId: contextId,
            contextId,
          }
          return response
        }).pipe(
          Effect.withSpan(
            "firegrid.channel.host.sessions.create_or_load.call",
            {
              kind: "internal",
              attributes: {
                "firegrid.channel.target":
                  HostSessionsCreateOrLoadChannelTarget,
                "firegrid.channel.direction": "call",
                "firegrid.channel.binding_pattern":
                  "request-row-only",
                "firegrid.external_key.source": request.externalKey.source,
                "firegrid.external_key.id": request.externalKey.id,
              },
            },
          ),
        ),
    })
  }),
)
