// Relocated from deleted `host-sdk/src/host/per-context-runtime-output.ts`
// (Class F3 host composition support). The composition Lives that bind
// `RuntimeHostConfig` + `CurrentHostSession` to the per-context runtime
// factories already at canonical runtime paths.

import { CurrentHostSession } from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import {
  makePerContextRuntimeAgentOutputAfterEvents,
  makePerContextRuntimeOutputWriter,
  PerContextRuntimeOutputWriter,
} from "../tables/per-context-output.ts"
import { RuntimeAgentOutputAfterEvents } from "../tables/runtime-output-public.ts"
import {
  makePerContextRuntimeContextStateStore,
  RuntimeContextStateStore,
} from "../tables/runtime-context-state.ts"
import { RuntimeHostConfig } from "../channels/runtime-host-config.ts"

// tf-bffo: the durable per-context RuntimeOutputTable wiring lives in
// runtime/tables/per-context-output.ts. Composition
// only RESOLVES the host config + CurrentHostSession and delegates to
// the runtime factories. Composition owns no durable-state wiring here.

export const PerContextRuntimeOutputWriterLive = Layer.effect(
  PerContextRuntimeOutputWriter,
  Effect.map(RuntimeHostConfig, hostConfig =>
    PerContextRuntimeOutputWriter.of(
      makePerContextRuntimeOutputWriter({
        durableStreamsBaseUrl: hostConfig.durableStreamsBaseUrl,
        ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
      }),
    )),
)

export const PerContextRuntimeAgentOutputAfterEventsLive = Layer.effect(
  RuntimeAgentOutputAfterEvents,
  Effect.gen(function*() {
    const hostConfig = yield* RuntimeHostConfig
    const hostSession = yield* CurrentHostSession
    return RuntimeAgentOutputAfterEvents.of(
      makePerContextRuntimeAgentOutputAfterEvents(
        {
          durableStreamsBaseUrl: hostConfig.durableStreamsBaseUrl,
          ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
        },
        hostSession.streamPrefix,
      ),
    )
  }),
)

// tf-aseo: workflow-owned durable loop state for the runtime-context body.
// Same per-context stream + host topology resolution as the output wiring
// above; the body loads/advances its cursors + pending-permission sets here
// instead of through a host-owned output scan.
export const RuntimeContextStateStoreLive = Layer.scoped(
  RuntimeContextStateStore,
  Effect.gen(function*() {
    const hostConfig = yield* RuntimeHostConfig
    const hostSession = yield* CurrentHostSession
    return yield* makePerContextRuntimeContextStateStore(
      {
        durableStreamsBaseUrl: hostConfig.durableStreamsBaseUrl,
        ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
      },
      hostSession.streamPrefix,
    )
  }),
)
