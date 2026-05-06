#!/usr/bin/env tsx
import { Terminal } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Data, Effect } from "effect"
import { FiregridRuntime, FiregridRuntimeBoot } from "../src/index.ts"

class UsageError extends Data.TaggedError("firegrid/UsageError")<{
  readonly message: string
}> {}

// firegrid-runtime-process.RUNTIME_PACKAGE.1
// firegrid-runtime-process.BINARIES.1
// firegrid-runtime-process.BINARIES.2
// firegrid-runtime-process.BINARIES.3
// firegrid-runtime-process.BINARIES.6
// firegrid-runtime-process.BINARIES.7
// firegrid-runtime-process.BINARIES.8
// firegrid-runtime-process.EFFECT_PLATFORM.1
// firegrid-runtime-process.EFFECT_PLATFORM.2
// firegrid-runtime-process.EFFECT_PLATFORM.3
// firegrid-runtime-process.EFFECT_PLATFORM.4
// firegrid-runtime-process.EFFECT_PLATFORM.5
// firegrid-runtime-process.CONFIG_SURFACE.1
// firegrid-runtime-process.CONFIG_SURFACE.3
// firegrid-runtime-process.CONFIG_SURFACE.6
//
// `firegrid` is attached-only. It never launches Durable Streams and
// never spawns child dev processes. Local development should run a
// Durable Streams server externally and pass the resolved stream URL
// through DURABLE_STREAMS_URL.

const writeStdout = (line: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display(`${line}\n`),
  )

const streamUrlFromConfig = Config.string("DURABLE_STREAMS_URL").pipe(
  Config.validate({
    message: "DURABLE_STREAMS_URL must not be empty",
    validation: (value) => value.length > 0,
  }),
)

const runAttached = Effect.scoped(
  Effect.gen(function* () {
    const streamUrl = yield* streamUrlFromConfig
    const runtimeLayer = FiregridRuntimeBoot.attached({ streamUrl })

    return yield* Effect.gen(function* () {
      const runtime = yield* FiregridRuntime
      yield* writeStdout(runtime.streamIdentity.streamUrl)
      yield* writeStdout(
        `firegrid runtime ready (${runtime.bootMode}); Ctrl-C to stop`,
      )
      return yield* Effect.never
    }).pipe(Effect.provide(runtimeLayer))
  }),
)

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    yield* writeStdout("usage: DURABLE_STREAMS_URL=<url> firegrid")
    return yield* new UsageError({
      message: "firegrid has no dev-server launcher subcommands",
    })
  }

  return yield* runAttached
}) satisfies Effect.Effect<void, unknown, Terminal.Terminal>

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
