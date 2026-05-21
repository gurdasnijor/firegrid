import { CurrentHostSession } from "@firegrid/protocol/launch"
import { SessionAgentOutputChannel } from "@firegrid/protocol/channels"
import { sessionAgentOutputChannel } from "@firegrid/runtime/channels"
import { Effect, Layer } from "effect"
import { RuntimeHostConfig } from "../../config.ts"

// tf-bffo: host-sdk COMPOSES only. The durable SessionAgentOutput channel
// implementation lives in @firegrid/runtime/channels; this layer resolves the
// host topology config + CurrentHostSession and delegates to the runtime builder.
export const SessionAgentOutputChannelLive: Layer.Layer<
  SessionAgentOutputChannel,
  never,
  RuntimeHostConfig | CurrentHostSession
> =
  Layer.effect(
    SessionAgentOutputChannel,
    Effect.gen(function*() {
      const hostConfig = yield* RuntimeHostConfig
      const hostSession = yield* CurrentHostSession
      return SessionAgentOutputChannel.of({
        forContext: contextId =>
          sessionAgentOutputChannel({
            durableStreamsBaseUrl: hostConfig.durableStreamsBaseUrl,
            streamPrefix: hostSession.streamPrefix,
            ...(hostConfig.headers === undefined
              ? {}
              : { headers: hostConfig.headers }),
            contextId,
          }),
      })
    }),
  )
