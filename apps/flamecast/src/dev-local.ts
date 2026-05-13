import { Command } from "@effect/platform"
import { CommandExecutor } from "@effect/platform/CommandExecutor"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Console, Effect } from "effect"

const DevLocalConfig = Config.all({
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE").pipe(
    Config.withDefault("flamecast-toy-local"),
  ),
  vitePort: Config.integer("FLAMECAST_VITE_PORT").pipe(
    Config.withDefault(4441),
  ),
  durableStreamsPort: Config.integer("DURABLE_STREAMS_PORT").pipe(
    Config.withDefault(8080),
  ),
})

const program = Effect.gen(function* () {
  const config = yield* DevLocalConfig
  const executor = yield* CommandExecutor
  const durableStreamsBaseUrl = `http://127.0.0.1:${config.durableStreamsPort}`
  const env = {
    DURABLE_STREAMS_BASE_URL: durableStreamsBaseUrl,
    FIREGRID_RUNTIME_NAMESPACE: config.namespace,
    VITE_DURABLE_STREAMS_BASE_URL: durableStreamsBaseUrl,
    VITE_FIREGRID_RUNTIME_NAMESPACE: config.namespace,
  }

  yield* executor.start(
    Command.make("tsx", "--tsconfig", "tsconfig.json", "scripts/dev-local-server.ts")
      .pipe(Command.stdin("inherit"))
      .pipe(Command.stdout("inherit"))
      .pipe(Command.stderr("inherit"))
      .pipe(Command.env({
        DURABLE_STREAMS_PORT: String(config.durableStreamsPort),
      })),
  )

  yield* Console.log(`Durable Streams: ${durableStreamsBaseUrl}`)
  yield* Console.log("Press Ctrl-C to stop.")

  yield* executor.start(
    Command.make("tsx", "--tsconfig", "tsconfig.json", "src/run.ts")
      .pipe(Command.stdin("inherit"))
      .pipe(Command.stdout("inherit"))
      .pipe(Command.stderr("inherit"))
      .pipe(Command.env(env)),
  )

  yield* Effect.never
})

NodeRuntime.runMain(
  program.pipe(Effect.provide(NodeContext.layer), Effect.scoped),
)
