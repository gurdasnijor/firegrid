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
import { Effect, Layer, Logger } from "effect"
import { FiregridHost } from "../unified/host.ts"
import {
  defaultNamespace,
  embeddedOrConfiguredDurableStreams,
  nonEmptyEnv,
} from "./_compose.ts"

const makeHostLayer = Effect.gen(function*() {
  const endpoint = yield* embeddedOrConfiguredDurableStreams
  const namespace = nonEmptyEnv("FIREGRID_RUNTIME_NAMESPACE") ?? defaultNamespace()
  const hostId = nonEmptyEnv("FIREGRID_HOST_ID")

  if (endpoint.embedded) {
    // firegrid-runtime-process.BINARIES.13
    // firegrid-runtime-process.CONFIG_SURFACE.8
    process.stderr.write(
      [
        `firegrid host: embedded durable-streams at ${endpoint.durableStreamsBaseUrl}`,
        "firegrid host: local dev: ephemeral in-process durable-streams; state lost on exit; set DURABLE_STREAMS_BASE_URL for a real backend",
      ].join("\n") + "\n",
    )
  }

  return FiregridHost({
    codec: "acp",
    durableStreamsBaseUrl: endpoint.durableStreamsBaseUrl,
    namespace,
    ...(hostId === undefined ? {} : { hostId }),
  })
})

const program = Effect.gen(function*() {
  const hostLayer = yield* makeHostLayer
  process.stderr.write("Firegrid host started\n")
  return yield* Layer.launch(hostLayer).pipe(Effect.zipRight(Effect.never))
}).pipe(Effect.scoped)

NodeRuntime.runMain(
  program.pipe(Effect.provide(Logger.replace(Logger.defaultLogger, Logger.none))),
  { disablePrettyLogger: true },
)
