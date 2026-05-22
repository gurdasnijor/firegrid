import { CurrentHostSession } from "@firegrid/protocol/launch"
import { Context, Effect, Layer } from "effect"
import {
  makePerContextRuntimeAgentOutputAfterEvents,
  makePerContextRuntimeOutputWriter,
  type PerContextRuntimeOutputWriterService,
} from "@firegrid/runtime/per-context-output"
import { RuntimeAgentOutputAfterEvents } from "@firegrid/runtime/runtime-output"
import {
  makePerContextRuntimeContextStateStore,
  RuntimeContextStateStore,
} from "@firegrid/runtime/kernel"
import { RuntimeHostConfig } from "./config.ts"

// tf-bffo: the durable per-context RuntimeOutputTable wiring now lives in
// @firegrid/runtime/per-context-output. host-sdk only COMPOSES it — these Layers
// resolve the host topology config + CurrentHostSession and delegate to the
// runtime factories. host-sdk owns no durable-state wiring here.
export class PerContextRuntimeOutputWriter extends Context.Tag(
  "@firegrid/host-sdk/PerContextRuntimeOutputWriter",
)<PerContextRuntimeOutputWriter, PerContextRuntimeOutputWriterService>() {}

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
