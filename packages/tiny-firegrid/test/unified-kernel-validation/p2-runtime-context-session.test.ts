/**
 * P2 — RuntimeContext session as workflow body.
 *
 * Validates the unified shape against the most load-bearing
 * subscriber (RuntimeContext session lifecycle). Asserts:
 *
 *   1. Single execution per (contextId, attempt) via idempotencyKey.
 *      Activity-memoized spawn fires exactly once.
 *   2. Input arrival via `sendSignal` wakes a parked body. The body
 *      iterates its own signals in `recordedAt` order. Activity
 *      memoization on the per-position send means the host-side
 *      recorder sees each input exactly once across replays.
 *   3. Crash recovery: signal recovery re-arms a parked body across
 *      a generation boundary; the body completes (engine
 *      `executions.finalResult` lands) without test re-drive.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { WorkflowEngineTableService } from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Effect, Exit, Option, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  sendSignal,
  type SignalTableService,
} from "../../src/simulations/unified-kernel-validation/signal.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"
import {
  buildRuntimeContextSessionLayer,
  makeRuntimeContextRecorder,
  RuntimeContextSessionWorkflow,
  type RuntimeContextRecorder,
  type SessionInputPayload,
} from "../../src/simulations/unified-kernel-validation/subscribers/runtime-context.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const buildUrls = (namespace: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.engine`),
  unifiedTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.tables`),
  signalTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.signals`),
})

const setupFor = (
  urls: GenerationUrls,
  recorder: RuntimeContextRecorder,
) => ({
  urls,
  workflowLayers: [buildRuntimeContextSessionLayer(recorder)],
  catalog: makeCatalog([RuntimeContextSessionWorkflow]),
})

const inputPayload = (text: string) => JSON.stringify({ text })

/**
 * Send a session input as a signal. The signal name is the producer-
 * supplied inputId; the body iterates all session signals by
 * recordedAt order.
 */
const sendInput = (options: {
  readonly signals: SignalTableService
  readonly executionId: string
  readonly inputId: string
  readonly kind: SessionInputPayload["kind"]
  readonly payloadJson: string
}) =>
  sendSignal({
    signals: options.signals,
    workflow: RuntimeContextSessionWorkflow,
    executionId: options.executionId,
    name: options.inputId,
    write: () => Effect.void,
    value: { kind: options.kind, payloadJson: options.payloadJson } satisfies SessionInputPayload,
    serializeValue: (v) => JSON.stringify(v),
  })

const awaitExecutionFinalResult = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
  timeout = "5 seconds" as const,
) =>
  engineTable.executions.get(executionId).pipe(
    Effect.flatMap((opt) =>
      Option.match(opt, {
        onSome: (exec) =>
          exec.finalResult !== undefined
            ? Effect.succeed(true)
            : engineTable.executions.rows().pipe(
              Stream.filter((row) =>
                row.executionId === executionId &&
                row.finalResult !== undefined),
              Stream.runHead,
              Effect.timeoutOption(timeout),
              Effect.map((o) => Option.flatten(o)),
              Effect.map(Option.isSome),
            ),
        onNone: () => Effect.succeed(false),
      }),
    ),
  )

describe("P2 — RuntimeContext session as workflow body", () => {
  it("single execution + memoized spawn: concurrent executes for the same (contextId, attempt) admit ONE body", async () => {
    const ns = `p2-single-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-single"
    const attempt = 1

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const recorder = yield* makeRuntimeContextRecorder()
        return yield* runGeneration(
          setupFor(urls, recorder),
          (services) =>
            Effect.gen(function*() {
              const executionId = yield* RuntimeContextSessionWorkflow.executionId({
                contextId,
                attempt,
              })
              // Pre-send two inputs (one prompt + terminal) so the
              // body can complete deterministically.
              yield* sendInput({
                signals: services.signals,
                executionId,
                inputId: "in-1",
                kind: "prompt",
                payloadJson: inputPayload("hello"),
              })
              yield* sendInput({
                signals: services.signals,
                executionId,
                inputId: "in-term",
                kind: "terminal",
                payloadJson: inputPayload("done"),
              })

              const exec1 = RuntimeContextSessionWorkflow.execute({
                contextId,
                attempt,
              })
              const exec2 = RuntimeContextSessionWorkflow.execute({
                contextId,
                attempt,
              })
              const both = yield* Effect.all([exec1, exec2], {
                concurrency: 2,
              }).pipe(Effect.orDie)

              const snapshot = yield* recorder.snapshot
              return {
                result1: both[0],
                result2: both[1],
                spawns: snapshot.spawns.length,
                sends: snapshot.sends.length,
              }
            }),
        )
      }) as Effect.Effect<
        {
          readonly result1: {
            readonly contextId: string
            readonly attempt: number
            readonly inputsConsumed: number
            readonly reachedTerminal: boolean
          }
          readonly result2: {
            readonly contextId: string
            readonly attempt: number
            readonly inputsConsumed: number
            readonly reachedTerminal: boolean
          }
          readonly spawns: number
          readonly sends: number
        },
        unknown
      >,
    )

    expect(result.spawns).toBe(1)
    expect(result.sends).toBe(2)
    expect(result.result1.inputsConsumed).toBe(2)
    expect(result.result2.inputsConsumed).toBe(2)
    expect(result.result1.reachedTerminal).toBe(true)
    expect(result.result2.reachedTerminal).toBe(true)
  }, 15_000)

  it("input arrival via sendSignal: append AFTER body parks, body wakes + processes", async () => {
    const ns = `p2-arrival-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-arrival"
    const attempt = 1

    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const recorder = yield* makeRuntimeContextRecorder()
        return yield* runGeneration(
          setupFor(urls, recorder),
          (services) =>
            Effect.gen(function*() {
              const executionId = yield* RuntimeContextSessionWorkflow.executionId({
                contextId,
                attempt,
              })

              const executeFiber = yield* Effect.fork(
                RuntimeContextSessionWorkflow.execute({
                  contextId,
                  attempt,
                }),
              )
              yield* Effect.sleep("100 millis")

              yield* sendInput({
                signals: services.signals,
                executionId,
                inputId: "i-1",
                kind: "prompt",
                payloadJson: inputPayload("one"),
              })
              yield* sendInput({
                signals: services.signals,
                executionId,
                inputId: "i-2",
                kind: "prompt",
                payloadJson: inputPayload("two"),
              })
              yield* sendInput({
                signals: services.signals,
                executionId,
                inputId: "i-3",
                kind: "terminal",
                payloadJson: inputPayload("three-terminal"),
              })

              const exit = yield* executeFiber.await
              if (Exit.isFailure(exit)) {
                return yield* Effect.failCause(exit.cause)
              }
              const snapshot = yield* recorder.snapshot
              const finalLanded = yield* awaitExecutionFinalResult(
                services.engineTable,
                executionId,
                "3 seconds",
              )
              return {
                spawns: snapshot.spawns.length,
                sends: snapshot.sends.length,
                finalLanded,
              }
            }),
        )
      }) as Effect.Effect<
        {
          readonly spawns: number
          readonly sends: number
          readonly finalLanded: boolean
        },
        unknown
      >,
    )

    expect(outcome.spawns).toBe(1)
    expect(outcome.sends).toBe(3)
    expect(outcome.finalLanded).toBe(true)
  }, 20_000)

  it("crash recovery: signal recovery re-arms parked body across reconstruction; body completes", async () => {
    const ns = `p2-crash-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-crash"
    const attempt = 1

    const gen1State: { executionId: string } = { executionId: "" }
    const gen1Recorder = await Effect.runPromise(makeRuntimeContextRecorder())
    await Effect.runPromise(
      runGeneration(
        setupFor(urls, gen1Recorder),
        (services) =>
          Effect.gen(function*() {
            gen1State.executionId =
              yield* RuntimeContextSessionWorkflow.executionId({
                contextId,
                attempt,
              })
            yield* Effect.fork(
              RuntimeContextSessionWorkflow.execute({
                contextId,
                attempt,
              }),
            )
            yield* Effect.sleep("100 millis")
            // Record the signal (terminal payload) — no resume.
            yield* services.signals.signals.insertOrGet({
              signalKey: `${gen1State.executionId}|terminal`,
              workflowName: RuntimeContextSessionWorkflow.name,
              executionId: gen1State.executionId,
              name: "terminal",
              payloadJson: JSON.stringify({
                kind: "terminal",
                payloadJson: inputPayload("terminal-payload"),
              } satisfies SessionInputPayload),
              recordedAt: new Date().toISOString(),
            }).pipe(Effect.orDie)
            yield* Effect.sleep("50 millis")
          }) as Effect.Effect<void, unknown>,
      ),
    )

    const gen2Recorder = await Effect.runPromise(makeRuntimeContextRecorder())
    const outcome = await Effect.runPromise(
      runGeneration(
        setupFor(urls, gen2Recorder),
        (services) =>
          Effect.gen(function*() {
            const found = yield* awaitExecutionFinalResult(
              services.engineTable,
              gen1State.executionId,
              "5 seconds",
            )
            const snapshot = yield* gen2Recorder.snapshot
            return {
              found,
              spawns: snapshot.spawns.length,
              sends: snapshot.sends.length,
              replayed: services.replayed,
            }
          }),
      ),
    )

    expect(outcome.found).toBe(true)
    expect(outcome.spawns).toBe(0)
    expect(outcome.sends).toBe(1)
    expect(outcome.replayed).toBeGreaterThanOrEqual(1)
  }, 20_000)
})
