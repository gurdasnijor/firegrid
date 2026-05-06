import { Firegrid, run } from "@firegrid/runtime"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import {
  EchoOperation,
  makeEchoScenarioRows,
} from "../emitters/echo.ts"
import {
  appendRows,
  pollInspection,
  withScenarioTestServer,
} from "../runner.ts"

class EchoAdapter extends Context.Tag(
  "firegrid/scenarios/EchoAdapter",
)<EchoAdapter, {
  readonly measure: (message: string) => Effect.Effect<number>
}>() {}

interface EchoAdapterLayerEvents {
  readonly acquired?: Deferred.Deferred<void>
  readonly finalized?: Deferred.Deferred<void>
}

const EchoAdapterLive = (
  events: EchoAdapterLayerEvents = {},
): Layer.Layer<EchoAdapter> =>
  // firegrid-runtime-process.EFFECT_PLATFORM.6
  Layer.scoped(
    EchoAdapter,
    Effect.gen(function* () {
      if (events.acquired !== undefined) {
        yield* Deferred.succeed(events.acquired, undefined)
      }
      yield* Effect.addFinalizer(() =>
        events.finalized === undefined
          ? Effect.void
          : Deferred.succeed(events.finalized, undefined).pipe(Effect.asVoid),
      )
      return {
        measure: (message) => Effect.succeed(message.length),
      }
    }),
  )

const echoReceiverRuntime = (
  events?: EchoAdapterLayerEvents,
) =>
  // firegrid-runtime-process.RUNTIME_COMPOSITION.1
  // firegrid-runtime-process.RUNTIME_COMPOSITION.2
  // firegrid-runtime-process.RUNTIME_COMPOSITION.5
  // firegrid-runtime-process.RUNTIME_COMPOSITION.6
  // firegrid-runtime-process.RUNTIME_RUN_API.11
  Firegrid.composeRuntime({
    subscribers: [],
    handlers: [
      Firegrid.handler(EchoOperation, (input) =>
        Effect.gen(function* () {
          const adapter = yield* EchoAdapter
          const length = yield* adapter.measure(input.message)
          return {
            message: input.message,
            length,
          }
        }),
      ),
    ],
    provide: [EchoAdapterLive(events)],
  })

const runEchoReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.SCENARIOS.7
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.4
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.7
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  // firegrid-runtime-process.RUNTIME_RUN_API.11
  // firegrid-runtime-process.EFFECT_PLATFORM.6
  // firegrid-runtime-process.READY_WORK_OPERATOR.7
  // firegrid-operation-messaging.RUNTIME_HANDLERS.1
  // firegrid-operation-messaging.RUNTIME_HANDLERS.2
  // firegrid-operation-messaging.RUNTIME_HANDLERS.3
  // firegrid-operation-messaging.RUNTIME_HANDLERS.4
  run({
    connection: { streamUrl },
    runtime: echoReceiverRuntime(),
  })

export const selfTestEchoReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const adapterAcquired = yield* Deferred.make<void>()
      const adapterFinalized = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkScoped(
        run({
          connection: { streamUrl },
          runtime: echoReceiverRuntime({
            acquired: adapterAcquired,
            finalized: adapterFinalized,
          }),
        }),
      )
      yield* appendRows(streamUrl, makeEchoScenarioRows())
      const completed = yield* pollInspection(
        streamUrl,
        (report) =>
          report.runs.some((run) =>
            run.runId === "run-echo-cli-1" &&
            run.state === "completed" &&
            (run.result as { readonly length?: unknown } | undefined)
              ?.length === 14
          ),
        { times: 50, interval: "50 millis", reason: "Echo run not completed" },
      )
      yield* Deferred.await(adapterAcquired).pipe(Effect.timeout("5 seconds"))
      const adapterFinalizedBeforeInterrupt = yield* Deferred.isDone(
        adapterFinalized,
      )
      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(adapterFinalized).pipe(Effect.timeout("5 seconds"))
      return {
        streamUrl,
        completed,
        adapterFinalizedBeforeInterrupt,
        adapterFinalized: true,
      } as const
    }),
  )

export const echoReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "echo-receiver",
  run: runEchoReceiver,
  selfTest: selfTestEchoReceiver,
})
