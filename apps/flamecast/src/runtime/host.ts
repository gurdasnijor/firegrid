import { NodeRuntime } from "@effect/platform-node"
import { Firegrid, FiregridConfig, FiregridLive } from "@firegrid/client/firegrid"
import { FiregridRuntimeHostLive, startRuntime } from "@firegrid/runtime/runtime-host"
import { Config, Console, Effect, Layer, Option, Redacted, Stream } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import { flamecastToyCreatedBy } from "../shared/agent.ts"

const FlamecastToyHostConfig = Config.all({
  durableStreamsBaseUrl: Config.string("DURABLE_STREAMS_BASE_URL").pipe(
    Config.orElse(() => Config.string("FLAMECAST_DURABLE_STREAMS_BASE_URL")),
  ),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE").pipe(
    Config.withDefault("flamecast-toy-local"),
  ),
  token: Config.option(Config.redacted("FIREGRID_DURABLE_STREAMS_TOKEN")),
})

const contextStream = Stream.unwrap(
  Effect.map(Firegrid, firegrid =>
    // flamecast-toy-stdio-agents.FIREGRID_BOUNDARY.1
    firegrid.watchContexts(context => context.createdBy === flamecastToyCreatedBy),
  ),
)

const shouldStart = (contextId: string) =>
  Effect.gen(function* () {
    const firegrid = yield* Firegrid
    const snapshot = yield* firegrid.open(contextId).snapshot
    return snapshot.status !== "started" &&
      snapshot.status !== "exited" &&
      snapshot.status !== "failed"
  })

const flamecastToyHostProgram = Effect.gen(function* () {
  const running = new Set<string>()
  yield* Console.log("Flamecast toy host running. Press Ctrl-C to stop.")
  yield* contextStream.pipe(
    Stream.runForEach(context =>
      Effect.gen(function* () {
        if (running.has(context.contextId)) return
        const start = yield* shouldStart(context.contextId)
        if (!start) return
        running.add(context.contextId)
        yield* startRuntime({ contextId: context.contextId }).pipe(
          // flamecast-toy-stdio-agents.LOCAL_AGENT.1
          // flamecast-toy-stdio-agents.LOCAL_AGENT.2
          Effect.catchAll(cause => Console.error(cause)),
          Effect.ensuring(Effect.sync(() => running.delete(context.contextId))),
          Effect.forkScoped,
        )
      }),
    ),
  )
})

const flamecastToyHostLayer = Layer.unwrapEffect(
  Effect.map(FlamecastToyHostConfig, config => {
    const headers = Option.match(config.token, {
      onNone: () => undefined,
      onSome: token => ({
        Authorization: () => `Bearer ${Redacted.value(token)}`,
      }) satisfies DurableTableHeaders,
    })
    return Layer.mergeAll(
      FiregridLive.pipe(
        Layer.provide(
          Layer.succeed(FiregridConfig, {
            durableStreamsBaseUrl: config.durableStreamsBaseUrl,
            namespace: config.namespace,
            ...(headers === undefined ? {} : { headers }),
          }),
        ),
      ),
      FiregridRuntimeHostLive({
        durableStreamsBaseUrl: config.durableStreamsBaseUrl,
        namespace: config.namespace,
        input: true,
        ...(headers === undefined ? {} : { headers }),
      }),
    )
  }),
)

export const runFlamecastToyHost = (): void => {
  NodeRuntime.runMain(
    Effect.scoped(
      flamecastToyHostProgram.pipe(
        Effect.provide(flamecastToyHostLayer),
        Effect.zipRight(Effect.never),
      ),
    ),
  )
}
