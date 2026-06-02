/**
 * Runtime-owned Firegrid host process entrypoint.
 *
 * firegrid-runtime-process.BINARIES.10
 * firegrid-runtime-process.BINARIES.11
 * firegrid-runtime-process.BINARIES.12
 * firegrid-runtime-process.EFFECT_PLATFORM.1
 * firegrid-runtime-process.EFFECT_PLATFORM.2
 * firegrid-runtime-process.CONFIG_SURFACE.1
 */

import { NodeRuntime } from "@effect/platform-node"
import { Console, Data, Effect, Layer } from "effect"
import { defaultProductionAdapterLayer, FiregridRuntime } from "../unified/host.ts"

class MissingHostEnv extends Data.TaggedError("MissingHostEnv")<{
  readonly name: string
}> {}

const requiredEnv = (name: string): Effect.Effect<string, MissingHostEnv> =>
  Effect.sync(() => process.env[name]).pipe(
    Effect.flatMap((value) =>
      value === undefined || value.trim() === ""
        ? Effect.fail(new MissingHostEnv({ name }))
        : Effect.succeed(value),
    ),
  )

const optionalEnv = (name: string): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    const value = process.env[name]
    return value === undefined || value.trim() === "" ? undefined : value
  })

const makeHostLayer = Effect.gen(function*() {
  const durableStreamsBaseUrl = yield* requiredEnv("DURABLE_STREAMS_BASE_URL")
  const namespace = yield* requiredEnv("FIREGRID_RUNTIME_NAMESPACE")
  const hostId = yield* optionalEnv("FIREGRID_HOST_ID")

  return FiregridRuntime(
    {
      durableStreamsBaseUrl,
      namespace,
      ...(hostId === undefined ? {} : { hostId }),
    },
    defaultProductionAdapterLayer(),
  )
})

const program = Effect.gen(function*() {
  const hostLayer = yield* makeHostLayer
  yield* Console.log("Firegrid host started")
  return yield* Layer.launch(hostLayer).pipe(Effect.zipRight(Effect.never))
}).pipe(Effect.scoped)

NodeRuntime.runMain(program)
