/**
 * tf-35f4 Sim 2 — multi-surface projection equivalence for a callable
 * channel.
 *
 * Substrate composition for the sim. Two projection surfaces share a
 * single Live Layer for `HostSessionsCreateOrLoadChannel` (the
 * protocol-owned channel Tag declared in
 * `@firegrid/protocol/channels/host-sessions-create-or-load.ts`):
 *
 *   - The typed client-method projection: `firegrid.sessions.createOrLoad`,
 *     which (after the tf-35f4 rewire) dispatches via the channel Tag
 *     rather than directly poking `RuntimeControlPlaneTable`.
 *   - The agent-tool / MCP-style projection: a thin tool-shaped wrapper
 *     constructed in `driver.ts` that resolves the SAME channel Tag and
 *     calls `binding.call(req)`. Stands in for the not-yet-shipped
 *     `session.create_or_load` MCP tool that would project this channel
 *     in production.
 *
 * The sim DOES NOT spawn a real agent, MCP server, or sandbox process —
 * Sim 2's measurement is substrate-row equivalence and response
 * equivalence, neither of which requires an agent in the loop.
 */

import {
  type HostSessionsCreateOrLoadChannel,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import {
  FiregridConfig,
  FiregridLive,
} from "@firegrid/client-sdk/firegrid"
import { HostSessionsCreateOrLoadChannelLive } from "@firegrid/runtime/channels/host-sessions-create-or-load/live"
import { Layer } from "effect"

export const SIM_ID = "tf-35f4-sim2-multi-surface-projection"

export const sim2ChannelLayer = (env: {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}): Layer.Layer<
  HostSessionsCreateOrLoadChannel | RuntimeControlPlaneTable,
  unknown,
  never
> => {
  const controlPlane = RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
      contentType: "application/json",
    },
  })
  // Bind the host-sdk-owned Live Layer for the channel; this is the
  // canonical binding (Pattern 1, request-row-only). The same Tag is
  // resolved by:
  //   (a) the typed client-method projection (via Firegrid)
  //   (b) the sim-local MCP-tool-style projection (via driver.ts)
  // proving that one CONTRACT can be shared across N projections.
  const channel = HostSessionsCreateOrLoadChannelLive.pipe(
    Layer.provideMerge(controlPlane),
  )
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Layer.provideMerge leaks `any` into the success channel through DurableTable's inferred generics (same any-leak class documented in PR #534 / control-request-side-effects.ts); the declared Layer.Layer<HostSessionsCreateOrLoadChannel | RuntimeControlPlaneTable, unknown, never> IS the intended host capability boundary.
  return channel
}

export const sim2FullLayer = (env: {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}) => {
  const config = Layer.succeed(FiregridConfig, {
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
  })
  const channelAndControl = sim2ChannelLayer(env)
  return FiregridLive.pipe(
    Layer.provideMerge(channelAndControl),
    Layer.provideMerge(config),
  )
}
