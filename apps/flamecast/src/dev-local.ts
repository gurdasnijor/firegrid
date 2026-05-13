import { Command } from "@effect/platform"
import { CommandExecutor } from "@effect/platform/CommandExecutor"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Config, Console, Effect } from "effect"

const DevLocalConfig = Config.all({
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE").pipe(
    Config.withDefault("flamecast-toy-local"),
  ),
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
        Command.stdin("inherit"),
        Command.stdout("inherit"),
        Command.stderr("inherit"),
      ),
    )
    yield* Console.log(`${name} started`)
    return process
  })

const program = Effect.gen(function* () {
  const config = yield* DevLocalConfig
  const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  const durableStreamsBaseUrl = yield* Effect.acquireRelease(
    Effect.promise(() => server.start()),
    () => Effect.promise(() => server.stop()).pipe(Effect.ignore),
  )
  const env = {
    DURABLE_STREAMS_BASE_URL: durableStreamsBaseUrl,
    FIREGRID_RUNTIME_NAMESPACE: config.namespace,
    VITE_DURABLE_STREAMS_BASE_URL: durableStreamsBaseUrl,
    VITE_FIREGRID_RUNTIME_NAMESPACE: config.namespace,
  }

  yield* Console.log(`Durable Streams: ${durableStreamsBaseUrl}`)
  yield* Console.log(`Flamecast UI:    Vite will print the local URL`)
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
