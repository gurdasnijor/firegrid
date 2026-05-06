import { Effect } from "effect"
import type { Layer, Scope } from "effect"
import { FiregridRuntimeBoot } from "./boot.ts"
import type { RuntimeContext } from "./context.ts"
import { FiregridRuntime } from "./service.ts"

export interface FiregridRuntimeConnection {
  readonly streamUrl: string
}

export interface FiregridRunOptions<E = never, R = never> {
  readonly connection: FiregridRuntimeConnection
  readonly runtime: Layer.Layer<never, E, RuntimeContext | R>
}

// firegrid-runtime-process.RUNTIME_RUN_API.1
// firegrid-runtime-process.RUNTIME_RUN_API.2
// firegrid-runtime-process.RUNTIME_RUN_API.3
// firegrid-runtime-process.RUNTIME_RUN_API.5
// firegrid-runtime-process.RUNTIME_RUN_API.6
// firegrid-runtime-process.RUNTIME_RUN_API.7
// firegrid-runtime-process.RUNTIME_RUN_API.8
// firegrid-runtime-process.RUNTIME_RUN_API.9
export const run = <E = never, R = never>(
  opts: FiregridRunOptions<E, R>,
): Effect.Effect<
  never,
  E,
  Exclude<Exclude<R, RuntimeContext>, Scope.Scope>
> =>
  Effect.scoped(
    Effect.flatMap(FiregridRuntime, () => Effect.never).pipe(
      Effect.provide(
        FiregridRuntimeBoot.attached<E, RuntimeContext | R>({
          streamUrl: opts.connection.streamUrl,
          runtime: opts.runtime,
        }),
      ),
    ),
  )
