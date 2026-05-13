import { NodeRuntime } from "@effect/platform-node"
import { FiregridRuntimeHostWithWorkflowFromConfig } from "@firegrid/runtime"
import { Console, Effect, Layer } from "effect"

export const firegridHostProgram = Effect.never

export const firegridHostLayer = FiregridRuntimeHostWithWorkflowFromConfig

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
