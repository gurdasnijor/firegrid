import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
} from "@firegrid/client"
import { Effect, Layer } from "effect"

export interface FiregridScenarioHarness {
  readonly createStreamUrl: (name: string) => Promise<string>
  readonly runWithFiregrid: <A, E>(
    options: {
      readonly controlPlaneStreamUrl: string
      readonly dataPlaneStreamUrl: string
      readonly legacyRuntimeStreamUrl?: string
    },
    effect: Effect.Effect<A, E, Firegrid>,
  ) => Promise<A>
  readonly stop: () => Promise<void>
}

export const startFiregridScenarioHarness = async (): Promise<FiregridScenarioHarness> => {
  const server: DurableStreamsTestServerHandle = await startDurableStreamsTestServer()

  return {
    createStreamUrl: name => server.createStreamUrl(name),
    runWithFiregrid: (options, effect) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            FiregridLive.pipe(
              Layer.provide(Layer.succeed(FiregridConfig, {
                runtimeStreamUrl: options.legacyRuntimeStreamUrl ?? options.controlPlaneStreamUrl,
                controlPlaneStreamUrl: options.controlPlaneStreamUrl,
                dataPlaneStreamUrl: options.dataPlaneStreamUrl,
              })),
            ),
          ),
        ),
      ),
    stop: () => server.stop(),
  }
}
