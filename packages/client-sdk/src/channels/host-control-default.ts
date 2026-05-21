// tf-aago: client-sdk standalone-default Live Layer for the host-control
// write channels (contexts.create / prompt / session.prompt /
// sessions.start / permissions.respond).
//
// Production hosts compose the host-sdk-owned `HostControlChannelsLive`
// (which also serves the read/ingress/snapshot channels). This default
// exists only so the browser/app-safe client can satisfy the write-channel
// Tags for standalone (non-host-process) composition WITHOUT importing
// host-sdk. The binding bodies are NOT re-implemented here — they come from
// the shared `@firegrid/protocol/launch` factories, the single source of
// truth both packages consume (createOrLoad precedent).
//
// Per Cycle-2 synthesis §1.2 #5 / tf-cyet (Phase 3): these defaults are
// slated for deletion once production composition routes the client through
// host-sdk's Live Layer. They stay in tf-aago so standalone client tests
// pass.

import {
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostPromptChannel,
  HostSessionsStartChannel,
  SessionPromptChannel,
} from "@firegrid/protocol/channels"
import {
  makeHostContextsCreateChannel,
  makeHostPermissionRespondChannel,
  makeHostPromptChannel,
  makeHostSessionsStartChannel,
  makeSessionPromptChannelForSession,
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"

export const HostControlChannelsStandaloneLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return Layer.mergeAll(
      Layer.succeed(
        HostContextsCreateChannel,
        makeHostContextsCreateChannel(control),
      ),
      Layer.succeed(HostPromptChannel, makeHostPromptChannel(control)),
      Layer.succeed(SessionPromptChannel, {
        forSession: (sessionId: string) =>
          makeSessionPromptChannelForSession(control, sessionId),
      }),
      Layer.succeed(
        HostSessionsStartChannel,
        makeHostSessionsStartChannel(control),
      ),
      Layer.succeed(
        HostPermissionRespondChannel,
        makeHostPermissionRespondChannel(control),
      ),
    )
  }),
)
