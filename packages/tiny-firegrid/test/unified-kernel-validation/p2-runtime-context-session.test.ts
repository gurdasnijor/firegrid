/**
 * P2 — Canonical RuntimeContext subscriber as a workflow body.
 *
 * Validates the unified-kernel shape against the most load-bearing
 * subscriber (RuntimeContext session lifecycle). Asserts:
 *
 *   1. Single execution per (contextId, attempt) via idempotencyKey —
 *      kills the production TOCTOU that spawned double agent PIDs.
 *      Activity-memoized spawn fires exactly once.
 *   2. Input arrival via kernelWriteArm wakes a parked body. The
 *      kernel command IS the input log; the body iterates by
 *      executionId in `recordedAt` order. Activity memoization on the
 *      per-position send means the host-side recorder sees each input
 *      exactly once across replays.
 *   3. Crash recovery: kernel replay re-arms a parked body across a
 *      generation boundary; the body completes (engine
 *      `executions.finalResult` lands) without test re-drive.
 *
 * State that the engine already owns is asserted via the engine:
 *   - "the session terminated" → executions.finalResult exists
 *   - "the spawn ran once" / "each send ran once" → recorder snapshot,
 *     which the spawn/send Activity wraps. The Activity record IS the
 *     durable memoization; the recorder is the side-effect proxy.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { WorkflowEngineTableService } from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Effect, Exit, Option, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  kernelWriteArm,
  type KernelCommandTableService,
} from "../../src/simulations/unified-kernel-validation/kernel.ts"
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
  SESSION_INPUT_TABLE,
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
  kernelTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.kernel`),
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
 * Append a session input by writing a kernel command and arming the
 * session execution. The command's `inputValueJson` carries the
 * `{ kind, payloadJson }` envelope the session body iterates.
 */
const appendAndArm = (options: {
  readonly kernel: KernelCommandTableService
  readonly executionId: string
  readonly inputId: string
  readonly kind: SessionInputPayload["kind"]
  readonly payloadJson: string
}) =>
  kernelWriteArm({
    kernel: options.kernel,
    workflow: RuntimeContextSessionWorkflow,
    executionId: options.executionId,
    inputTable: SESSION_INPUT_TABLE,
    inputKey: options.inputId,
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
              // Pre-arm two inputs (one prompt + terminal) so the body
              // can complete deterministically when it starts.
              yield* appendAndArm({
                kernel: services.kernel,
                executionId,
                inputId: "in-1",
                kind: "prompt",
                payloadJson: inputPayload("hello"),
              })
              yield* appendAndArm({
                kernel: services.kernel,
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

  it("input arrival via kernelWriteArm: append AFTER body parks, body wakes + processes", async () => {
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

              yield* appendAndArm({
                kernel: services.kernel,
                executionId,
                inputId: "i-1",
                kind: "prompt",
                payloadJson: inputPayload("one"),
              })
              yield* appendAndArm({
                kernel: services.kernel,
                executionId,
                inputId: "i-2",
                kind: "prompt",
                payloadJson: inputPayload("two"),
              })
              yield* appendAndArm({
                kernel: services.kernel,
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

  it("crash recovery: kernel replay re-arms parked body across reconstruction; body completes", async () => {
    const ns = `p2-crash-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-crash"
    const attempt = 1

    // Generation 1: park the body, record a terminal-kind kernel
    // command WITHOUT arming, drop the generation.
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
            // Record the command (with terminal payload) — no arm.
            yield* services.kernel.commands.insertOrGet({
              commandKey: `${RuntimeContextSessionWorkflow.name}|${gen1State.executionId}|terminal`,
              workflowName: RuntimeContextSessionWorkflow.name,
              executionId: gen1State.executionId,
              inputTable: SESSION_INPUT_TABLE,
              inputKey: "terminal",
              inputValueJson: JSON.stringify({
                kind: "terminal",
                payloadJson: inputPayload("terminal-payload"),
              } satisfies SessionInputPayload),
              recordedAt: new Date().toISOString(),
            }).pipe(Effect.orDie)
            yield* Effect.sleep("50 millis")
          }) as Effect.Effect<void, unknown>,
      ),
    )

    // Generation 2: rebuild. Replay re-arms; body completes.
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
    // gen2's spawn Activity is memoized from gen1's durable record, so
    // the fresh gen2 recorder sees zero spawn side effects. The
    // terminal send Activity is new in gen2, so the recorder sees one.
    expect(outcome.spawns).toBe(0)
    expect(outcome.sends).toBe(1)
    expect(outcome.replayed).toBeGreaterThanOrEqual(1)
  }, 20_000)
})
