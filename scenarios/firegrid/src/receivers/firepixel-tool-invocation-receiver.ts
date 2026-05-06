import { Firegrid, run } from "@firegrid/runtime"
import {
  EventPlane,
  type PlaneProjectionQuery,
} from "@firegrid/substrate/event-plane"
import { Effect, Fiber } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import {
  appendRows,
  pollInspection,
  withScenarioTestServer,
} from "../runner.ts"
import {
  FirepixelToolInvocationOperation,
  FirepixelToolInvocationPlane,
  type ToolInvocationRequest,
  ToolInvocationResult,
  makeFirepixelToolInvocationScenarioRows,
} from "../emitters/firepixel-tool-invocation.ts"

const toolRequestByInvocationId = (
  invocationId: string,
): PlaneProjectionQuery<
  typeof FirepixelToolInvocationPlane.state,
  ToolInvocationRequest | undefined
> => ({
  label: `tool-request(${invocationId})`,
  authority: "observational",
  evaluate: (snap) =>
    Effect.succeed(snap.toolRequests.get(invocationId)),
})

const toolResultByInvocationId = (
  invocationId: string,
): PlaneProjectionQuery<
  typeof FirepixelToolInvocationPlane.state,
  ToolInvocationResult | undefined
> => ({
  label: `tool-result(${invocationId})`,
  authority: "terminal-domain",
  evaluate: (snap) =>
    Effect.succeed(snap.toolResults.get(invocationId)),
})

const isPresent = <A>(value: A | undefined): value is A =>
  value !== undefined

const toolInvocationRuntime = (streamUrl: string) =>
  // firegrid-runtime-process.RUNTIME_COMPOSITION.1
  // firegrid-runtime-process.RUNTIME_COMPOSITION.2
  // firegrid-runtime-process.RUNTIME_COMPOSITION.6
  // firegrid-runtime-process.SCENARIOS.21
  // client-event-plane-registration.FIREPIXEL_PROFILE.4
  // client-event-plane-registration.PRODUCER_API.5
  // client-event-plane-registration.PROJECTION_API.1
  // client-event-plane-registration.BOUNDARY.6
  Firegrid.composeRuntime({
    subscribers: [],
    handlers: [
      Firegrid.handler(FirepixelToolInvocationOperation, (input) =>
        Effect.gen(function* () {
          const producer = yield* FirepixelToolInvocationPlane.Producer
          const projection = yield* FirepixelToolInvocationPlane.Projection
          yield* producer.emit(
            FirepixelToolInvocationPlane.state.toolRequests.insert({
              value: {
                invocationId: input.invocationId,
                promptId: input.promptId,
                toolName: input.toolName,
                arguments: input.arguments,
                state: "requested",
              },
            }),
            {
              idempotencyKey: input.invocationId,
              correlationId: input.promptId,
              causationId: input.invocationId,
            },
          )
          return yield* projection.until(
            toolResultByInvocationId(input.invocationId),
            isPresent,
            { timeout: "5 seconds" },
          )
        }),
      ),
    ],
    provide: [
      EventPlane.layer(FirepixelToolInvocationPlane, { streamUrl }),
    ],
  })

const runFirepixelToolInvocationReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.SCENARIOS.21
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  run({
    connection: { streamUrl },
    runtime: toolInvocationRuntime(streamUrl),
  })

const completeToolInvocation = (input: {
  readonly streamUrl: string
  readonly invocationId: string
}) =>
  Effect.gen(function* () {
    const producer = yield* FirepixelToolInvocationPlane.Producer
    const projection = yield* FirepixelToolInvocationPlane.Projection
    const request = yield* projection.until(
      toolRequestByInvocationId(input.invocationId),
      isPresent,
      { timeout: "5 seconds" },
    )
    const result = {
      invocationId: request.invocationId,
      promptId: request.promptId,
      toolName: request.toolName,
      status: "succeeded",
      output: `scenario-result:${request.arguments.query ?? request.toolName}`,
    } as const
    yield* producer.emit(
      FirepixelToolInvocationPlane.state.toolResults.insert({
        value: result,
      }),
      {
        idempotencyKey: `${request.invocationId}:result`,
        correlationId: request.promptId,
        causationId: request.invocationId,
      },
    )
    return { request, result } as const
  }).pipe(
    Effect.provide(
      EventPlane.layer(FirepixelToolInvocationPlane, {
        streamUrl: input.streamUrl,
      }),
    ),
  )

export const selfTestFirepixelToolInvocationReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const runId = `run-firepixel-tool-${crypto.randomUUID()}`
      const invocationId = `tool-invocation-${crypto.randomUUID()}`
      const promptId = `prompt-${crypto.randomUUID()}`
      const toolName = "scenario.lookup"
      const rows = makeFirepixelToolInvocationScenarioRows({
        runId,
        invocationId,
        promptId,
        toolName,
        arguments: { query: "firepixel tool invocation" },
      })

      const receiver = yield* Effect.forkScoped(
        runFirepixelToolInvocationReceiver(streamUrl),
      )
      const adapter = yield* Effect.forkScoped(
        completeToolInvocation({ streamUrl, invocationId }),
      )

      yield* appendRows(streamUrl, rows)

      const plane = yield* Fiber.join(adapter)
      const completed = yield* pollInspection(
        streamUrl,
        (report) =>
          report.runs.some((run) =>
            run.runId === runId &&
            run.state === "completed" &&
            (run.result as { readonly invocationId?: unknown } | undefined)
              ?.invocationId === invocationId
          ),
        {
          times: 80,
          interval: "50 millis",
          reason: "Firepixel tool invocation run not completed",
        },
      )
      yield* Fiber.interrupt(receiver)

      return {
        report: {
          streamUrl,
          completed,
          plane,
        },
      } as const
    }),
  )

export const firepixelToolInvocationReceiverScenario =
  defineReceiverScenario({
    kind: "receiver",
    name: "firepixel-tool-invocation-receiver",
    run: runFirepixelToolInvocationReceiver,
    selfTest: selfTestFirepixelToolInvocationReceiver,
  })
