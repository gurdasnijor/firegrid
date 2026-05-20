import {
  CurrentHostSession,
  hostOwnedStreamUrl,
} from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import {
  type DurableWaitRows,
  type DurableWaitRowLookup,
  type DurableWaitRowUpsert,
  DurableToolsWaitForLive,
} from "@firegrid/runtime/durable-tools"
import { RuntimeHostConfig } from "./config.ts"

export type HostOwnedRuntimeObservationSubstrate =
  | DurableWaitRows
  | DurableWaitRowLookup
  | DurableWaitRowUpsert

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
  }).pipe(
    Effect.withSpan("firegrid.host.durable_tools.wait_for.layer", {
      kind: "internal",
    }),
  ),
)
