import { Firegrid, run } from "@firegrid/runtime"
import { Effect, Fiber } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import {
  FailingOperation,
  makeFailingOperationScenarioRows,
} from "../emitters/failing-operation.ts"
import {
  appendRows,
  pollInspection,
  withScenarioTestServer,
} from "../runner.ts"

const FailingOperationReceiverRuntime = Firegrid.handler(
  FailingOperation,
  (input) =>
    Effect.fail({
      _tag: "ScenarioFailure" as const,
      requestId: input.requestId,
      reason: input.reason,
    }),
)

const runFailingOperationReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.SCENARIOS.12
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  // firegrid-operation-messaging.RUNTIME_HANDLERS.1
  // firegrid-operation-messaging.RUNTIME_HANDLERS.3
  // firegrid-operation-messaging.RUNTIME_HANDLERS.4
  run({
    connection: { streamUrl },
    runtime: FailingOperationReceiverRuntime,
  })

export const selfTestFailingOperationReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(
        runFailingOperationReceiver(streamUrl),
      )
      yield* appendRows(streamUrl, makeFailingOperationScenarioRows())
      const completed = yield* pollInspection(
        streamUrl,
        (report) =>
          report.runs.some((run) =>
            run.runId === "run-failing-operation-cli-1" &&
            run.state === "failed" &&
            (run.error as { readonly _tag?: unknown } | undefined)?._tag ===
              "ScenarioFailure"
          ),
        {
          times: 50,
          interval: "50 millis",
          reason: "FailingOperation run not failed",
        },
      )
      yield* Fiber.interrupt(fiber)
      return { streamUrl, completed } as const
    }),
  )

export const failingOperationReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "failing-operation-receiver",
  run: runFailingOperationReceiver,
  selfTest: selfTestFailingOperationReceiver,
})
