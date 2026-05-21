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
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeHostSessionsCreateOrLoadChannel,
} from "@firegrid/runtime/channels"
import { Effect, Layer } from "effect"

export const HostSessionsCreateOrLoadChannelLive = Layer.effect(
  HostSessionsCreateOrLoadChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return makeRuntimeHostSessionsCreateOrLoadChannel(control)
  }),
)
