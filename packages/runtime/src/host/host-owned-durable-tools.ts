import {
  CurrentHostSession,
  hostOwnedStreamUrl,
} from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import { DurableToolsWaitForLive } from "../durable-tools/DurableToolsWaitFor.ts"
import { RuntimeHostConfig } from "./config.ts"

export const HostOwnedDurableToolsWaitForLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const session = yield* CurrentHostSession
    const config = yield* RuntimeHostConfig
    return DurableToolsWaitForLive({
      streamUrl: hostOwnedStreamUrl({
        baseUrl: config.durableStreamsBaseUrl,
        prefix: session.streamPrefix,
        segment: "durableTools",
      }),
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    })
  }),
)
