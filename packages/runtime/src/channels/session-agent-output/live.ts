import { CurrentHostSession } from "@firegrid/protocol/launch"
import { SessionAgentOutputChannel } from "@firegrid/protocol/channels"
import { sessionAgentOutputChannel } from "../session-agent-output.ts"
import { Effect, Layer } from "effect"
import { RuntimeHostConfig } from "../runtime-host-config.ts"

// tf-bffo: Live binding for `SessionAgentOutputChannel`. Resolves the host
// topology config + `CurrentHostSession` and delegates to the runtime
// channel builder (`sessionAgentOutputChannel` in the parent file).
//
// Relocated from the deleted host-sdk path
// `host-sdk/src/host/channels/session-agent-output/index.ts` (Class D
// channel-Lives relocation). The pure builder
// `sessionAgentOutputChannel` already lives at
// `runtime/src/channels/session-agent-output.ts`; this Live wires it
// against `RuntimeHostConfig` from the canonical
// `runtime/channels/runtime-host-config` Tag.
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
