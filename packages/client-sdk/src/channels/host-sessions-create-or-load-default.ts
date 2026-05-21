/**
 * Standalone-wiring default Live Layer for the protocol-owned
 * `HostSessionsCreateOrLoadChannel`.
 *
 * Production hosts SHOULD consume the host-sdk-owned Live Layer
 * (`HostSessionsCreateOrLoadChannelLive` from `@firegrid/host-sdk`) so
 * the channel binding is composed with the rest of the host topology.
 * This default exists only so `FiregridStandaloneLive` (the client-sdk
 * test scaffold for non-host-process consumers) can satisfy the channel
 * Tag without dragging in host-sdk.
 *
 * It binds the same Pattern 1 (request-row-only) implementation as the
 * host-sdk Live Layer — both resolve the Tag with a `CallableChannel`
 * whose `binding.call` writes a `RuntimeContextRequest` row via
 * `RuntimeControlPlaneTable.contextRequests.insertOrGet`. Either Layer
 * is a valid binding of the same protocol-owned contract; that is the
 * projection-contract property tf-35f4 Sim 2 measures.
 *
 * tf-35f4 / tf-kddg finish-line contribution: the residual move is to
 * delete this default in favor of host-sdk composition once the
 * standalone path either grows a real host topology or is restricted to
 * read-only operations.
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

export const HostSessionsCreateOrLoadChannelStandaloneLive = Layer.effect(
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
                "firegrid.channel.binding_source":
                  "client-sdk-standalone-default",
                "firegrid.external_key.source": request.externalKey.source,
                "firegrid.external_key.id": request.externalKey.id,
              },
            },
          ),
        ),
    })
  }),
)
