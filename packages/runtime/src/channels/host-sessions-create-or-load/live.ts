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
 * Relocated from the deleted host-sdk path
 * `host-sdk/src/host/channels/host-sessions-create-or-load-live.ts`
 * (Class D channel-Lives relocation). The protocol-owned channel Tag
 * stays in `@firegrid/protocol/channels`; only the Live Layer that
 * resolves the binding moves here.
 */

import {
  HostSessionsCreateOrLoadChannel,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeHostSessionsCreateOrLoadChannel,
} from "../../channels/index.ts"
import { Effect, Layer } from "effect"

export const HostSessionsCreateOrLoadChannelLive = Layer.effect(
  HostSessionsCreateOrLoadChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return makeRuntimeHostSessionsCreateOrLoadChannel(control)
  }),
)
