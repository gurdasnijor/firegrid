import { Firegrid, run } from "@firegrid/runtime"
import { Effect, Fiber } from "effect"
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

const EchoReceiverRuntime = Firegrid.handler(EchoOperation, (input) =>
  Effect.succeed({
    message: input.message,
    length: input.message.length,
  }),
)

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
  // firegrid-runtime-process.READY_WORK_OPERATOR.7
  // firegrid-operation-messaging.RUNTIME_HANDLERS.1
  // firegrid-operation-messaging.RUNTIME_HANDLERS.2
  // firegrid-operation-messaging.RUNTIME_HANDLERS.3
  // firegrid-operation-messaging.RUNTIME_HANDLERS.4
  run({
    connection: { streamUrl },
    runtime: EchoReceiverRuntime,
  })

export const selfTestEchoReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runEchoReceiver(streamUrl))
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
      yield* Fiber.interrupt(fiber)
      return { streamUrl, completed } as const
    }),
  )

export const echoReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "echo-receiver",
  run: runEchoReceiver,
  selfTest: selfTestEchoReceiver,
})
