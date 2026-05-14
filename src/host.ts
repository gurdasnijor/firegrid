import { NodeRuntime } from "@effect/platform-node"
import {
  FiregridRuntimeHostWithWorkflowLive,
  RuntimeHostTopologyFromConfig,
  localProcessSpawnEnvFromHostEnv,
} from "@firegrid/runtime"
import { Console, Effect, Layer } from "effect"

export const firegridHostProgram = Effect.never

export const firegridHostLayer = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, topology =>
    FiregridRuntimeHostWithWorkflowLive({
      ...topology,
      localProcessEnv: localProcessSpawnEnvFromHostEnv(globalThis.process.env),
    }),
  ),
)

export const runFiregridHost = (): void => {
  // firegrid-runtime-process.BINARIES.12
  NodeRuntime.runMain(
    Effect.scoped(
      Layer.build(firegridHostLayer).pipe(
        Effect.tap(() => Console.log("Firegrid host running. Press Ctrl-C to stop.")),
        Effect.zipRight(firegridHostProgram),
      ),
    ),
  )
}
