// Host-sdk representative for the Wave C channel/router thesis.
//
// Per SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md §"Package Placement" the
// host-sdk owns:
//
//   - selecting which channel router a host exposes;
//   - composing router Layers with runtime/kernel Layers;
//   - installing MCP/ACP/HTTP/CLI edge adapters;
//   - host-author convenience options that lower to Layer composition.
//
// "Host SDK should not implement DurableTable-backed route bodies as
// stable architecture." This file is the negative shape proof for that
// rule. It does:
//
//   ✓ import the channelRouter() builder
//   ✓ import the RuntimeRouteSet type + makeRuntimeRoutes factory
//   ✓ assemble the router descriptor under the seven production targets
//
// It does NOT import any Shape C handler symbol, runtime state-store
// symbol, generic-stream aggregator, ambient AgentSession, or workflow
// machinery. Asserted by `probe.test.ts`.

import { Effect } from "effect"
import { channelRouter, type ChannelRouter } from "./router.ts"
import {
  makeRuntimeRoutes,
  type RuntimeRouteSet,
} from "./runtime-routes.ts"

export type FiregridHostChannelRoutes = {
  readonly "host.contexts.create": RuntimeRouteSet["hostContextsCreate"]
  readonly "host.prompt": RuntimeRouteSet["hostPrompt"]
  readonly "host.sessions.create_or_load": RuntimeRouteSet["hostSessionsCreateOrLoad"]
  readonly "host.sessions.start": RuntimeRouteSet["hostSessionsStart"]
  readonly "session.prompt": RuntimeRouteSet["sessionPrompt"]
  readonly "session.agent_output": RuntimeRouteSet["sessionAgentOutput"]
  readonly "host.permissions.respond": RuntimeRouteSet["hostPermissionRespond"]
}

export type FiregridHostChannelRouter = ChannelRouter<FiregridHostChannelRoutes>

/**
 * The host topology assembly. Returns a `FiregridHostChannelRouter`
 * whose `routes` are the runtime-owned route descriptors and whose
 * `dispatch` is the derived string-keyed edge surface for
 * ACP/MCP/CLI/HTTP edges and for the typed `FiregridClient`-shaped
 * facade in `client.ts`.
 *
 * The `R` channel is `never`: the host facade pulls in no Shape C
 * subscriber capabilities, no `AgentSession`, no `WorkflowEngine`.
 */
export const composeFiregridHost: Effect.Effect<FiregridHostChannelRouter> =
  Effect.gen(function*() {
    const runtime = yield* makeRuntimeRoutes()
    return channelRouter({
      "host.contexts.create": runtime.routes.hostContextsCreate,
      "host.prompt": runtime.routes.hostPrompt,
      "host.sessions.create_or_load": runtime.routes.hostSessionsCreateOrLoad,
      "host.sessions.start": runtime.routes.hostSessionsStart,
      "session.prompt": runtime.routes.sessionPrompt,
      "session.agent_output": runtime.routes.sessionAgentOutput,
      "host.permissions.respond": runtime.routes.hostPermissionRespond,
    })
  })
