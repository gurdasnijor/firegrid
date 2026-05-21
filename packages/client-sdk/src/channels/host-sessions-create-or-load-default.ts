/**
 * Standalone-wiring default Live Layer for the protocol-owned
 * `HostSessionsCreateOrLoadChannel`.
 *
 * Production hosts SHOULD consume the host-sdk-owned Live Layer
 * (`HostSessionsCreateOrLoadChannelLive` from the host-sdk package) so
 * the channel binding is composed with the rest of the host topology.
 * This default exists only so `FiregridStandaloneLive` (the client-sdk
 * test scaffold for non-host-process consumers) can satisfy the channel
 * Tag without dragging in the host-sdk package.
 */

import { HostSessionsCreateOrLoadChannel } from "@firegrid/protocol/channels"
import {
  makeHostSessionsCreateOrLoadRequestRowChannel,
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"

export const HostSessionsCreateOrLoadChannelStandaloneLive = Layer.effect(
  HostSessionsCreateOrLoadChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return makeHostSessionsCreateOrLoadRequestRowChannel(control, {
      bindingSource: "client-sdk-standalone-default",
    })
  }),
)
