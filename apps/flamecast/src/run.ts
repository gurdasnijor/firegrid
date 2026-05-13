import { fileURLToPath } from "node:url"
import { Command } from "@effect/platform"
import { CommandExecutor } from "@effect/platform/CommandExecutor"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Console, Effect, Option, Redacted } from "effect"

const appRoot = fileURLToPath(new URL("..", import.meta.url))

const FlamecastRunConfig = Config.all({
  durableStreamsBaseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE").pipe(
    Config.withDefault("flamecast-toy-local"),
  ),
  token: Config.option(Config.redacted("FIREGRID_DURABLE_STREAMS_TOKEN")),
  vitePort: Config.integer("FLAMECAST_VITE_PORT").pipe(
    Config.withDefault(4441),
  ),
})

const startProcess = (
  name: string,
  command: Command.Command,
) =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor
    const process = yield* executor.start(
      command.pipe(
        Command.workingDirectory(appRoot),
        Command.stdin("inherit"),
        Command.stdout("inherit"),
        Command.stderr("inherit"),
      ),
    )
    yield* Console.log(`${name} started`)
    return process
  })

const program = Effect.gen(function* () {
  const config = yield* FlamecastRunConfig
  const token = Option.match(config.token, {
    onNone: () => undefined,
    onSome: Redacted.value,
  })
  const env = {
    DURABLE_STREAMS_BASE_URL: config.durableStreamsBaseUrl,
    FIREGRID_RUNTIME_NAMESPACE: config.namespace,
    ...(token === undefined ? {} : { FIREGRID_DURABLE_STREAMS_TOKEN: token }),
    VITE_DURABLE_STREAMS_BASE_URL: config.durableStreamsBaseUrl,
    VITE_FIREGRID_RUNTIME_NAMESPACE: config.namespace,
    ...(token === undefined ? {} : { VITE_FIREGRID_DURABLE_STREAMS_TOKEN: token }),
  }

  yield* Console.log(`Durable Streams: ${config.durableStreamsBaseUrl}`)
  yield* Console.log(`Namespace:       ${config.namespace}`)
  yield* Console.log("Flamecast UI:    Vite will print the local URL")
  yield* Console.log("Press Ctrl-C to stop.")

  yield* startProcess(
    "Flamecast runtime",
    Command.make("tsx", "--tsconfig", "tsconfig.json", "src/runtime/main.ts")
      .pipe(Command.env(env)),
  ).pipe(Effect.forkScoped)

  yield* startProcess(
    "Flamecast UI",
    Command.make("vite", "--host", "127.0.0.1", "--port", String(config.vitePort))
      .pipe(Command.env(env)),
  ).pipe(Effect.forkScoped)

  yield* Effect.never
})

NodeRuntime.runMain(
  program.pipe(Effect.provide(NodeContext.layer), Effect.scoped),
)
