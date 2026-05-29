/**
 * P2 — Canonical RuntimeContext subscriber as a workflow body.
 *
 * Validates the unified-kernel shape against the most load-bearing
 * subscriber (RuntimeContext session lifecycle). Asserts:
 *
 *   1. Single execution per (contextId, attempt) via idempotencyKey —
 *      kills the production TOCTOU that spawned double agent PIDs.
 *   2. Activity-memoized spawn fires exactly once across resumes /
 *      reconstruction.
 *   3. Input arrival via kernelWriteArm wakes the body; the body
 *      consumes via cursor and emits an output row per input.
 *   4. Crash recovery: kernel replay re-arms a parked body across a
 *      generation boundary; outputs land without test re-drive.
 *   5. Terminal completion writes a durable runs row with
 *      status="exited" — the terminal-after-settlement evidence
 *      observers should bind to (vs raw "Terminated" output events).
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { WorkflowEngineTableService } from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Effect, Exit, Option, Stream } from "effect"
import type { KernelCommandTableService } from "../../src/simulations/unified-kernel-validation/kernel.ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendInputIntent, ensureContext } from "../../src/simulations/unified-kernel-validation/input-append.ts"
import {
  type KernelRowRewriter,
  kernelWriteArm,
} from "../../src/simulations/unified-kernel-validation/kernel.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
  tableLayerFor,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"
import {
  buildRuntimeContextSessionLayer,
  makeRuntimeContextRecorder,
  RuntimeContextSessionWorkflow,
  type RuntimeContextRecorder,
} from "../../src/simulations/unified-kernel-validation/subscribers/runtime-context.ts"
import {
  inputKey,
  runKey,
  UnifiedTable,
} from "../../src/simulations/unified-kernel-validation/tables.ts"

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

// Per-test setup: build a fresh recorder, fresh workflow layer over it.
// Each test owns its recorder, so cross-test ordering doesn't matter.
const setupFor = (
  urls: GenerationUrls,
  recorder: RuntimeContextRecorder,
) => ({
  urls,
  workflowLayers: [buildRuntimeContextSessionLayer(recorder)],
  catalog: makeCatalog([RuntimeContextSessionWorkflow]),
})

const inputPayload = (text: string) => JSON.stringify({ text })

// Rewriter for restart: re-write a missing input row from the kernel command.
const inputRewriter = (unified: UnifiedTable["Type"]): KernelRowRewriter => ({
  forCommand: (cmd) => {
    if (cmd.inputTable !== "inputs") return undefined
    const value = JSON.parse(cmd.inputValueJson) as {
      readonly contextId: string
      readonly inputId: string
      readonly sequence: number
      readonly kind:
        | "prompt"
        | "permission-response"
        | "tool-result"
        | "peer-event"
        | "scheduled-fire"
        | "terminal"
      readonly payloadJson: string
    }
    return unified.inputs.insertOrGet({
      inputKey: cmd.inputKey,
      contextId: value.contextId,
      inputId: value.inputId,
      sequence: value.sequence,
      kind: value.kind,
      payloadJson: value.payloadJson,
      appendedAt: new Date().toISOString(),
    }).pipe(Effect.orDie, Effect.asVoid)
  },
})

// Helper: write an input via the atomic append + arm via the kernel.
const appendAndArm = (options: {
  readonly unified: UnifiedTable["Type"]
  readonly kernel: KernelCommandTableService
  readonly contextId: string
  readonly inputId: string
  readonly kind:
    | "prompt"
    | "permission-response"
    | "tool-result"
    | "peer-event"
    | "scheduled-fire"
    | "terminal"
  readonly payloadJson: string
  readonly executionId: string
}) =>
  Effect.gen(function*() {
    const result = yield* appendInputIntent({
      table: options.unified,
      contextId: options.contextId,
      inputId: options.inputId,
      kind: options.kind,
      payloadJson: options.payloadJson,
    })
    yield* kernelWriteArm({
      kernel: options.kernel,
      workflow: RuntimeContextSessionWorkflow,
      executionId: options.executionId,
      inputTable: "inputs",
      inputKey: result.inputKey,
      write: () => Effect.void, // row already written by atomic append
      value: {
        contextId: options.contextId,
        inputId: options.inputId,
        sequence: result.sequence,
        kind: options.kind,
        payloadJson: options.payloadJson,
      },
      serializeValue: (v) => JSON.stringify(v),
    })
    return result
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

// ── Tests ───────────────────────────────────────────────────────────────────

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
              yield* ensureContext({
                table: services.unified,
                contextId,
                agent: "test",
              })

              // Append one input AND a terminal input so the body
              // completes deterministically.
              yield* appendInputIntent({
                table: services.unified,
                contextId,
                inputId: "in-1",
                kind: "prompt",
                payloadJson: inputPayload("hello"),
              })
              yield* appendInputIntent({
                table: services.unified,
                contextId,
                inputId: "in-term",
                kind: "terminal",
                payloadJson: inputPayload("done"),
              })

              // Two concurrent executes with the same payload.
              const exec1 = RuntimeContextSessionWorkflow.execute({
                contextId,
                attempt,
                expectedInputs: 10,
              })
              const exec2 = RuntimeContextSessionWorkflow.execute({
                contextId,
                attempt,
                expectedInputs: 10,
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
              yield* ensureContext({
                table: services.unified,
                contextId,
                agent: "test",
              })

              // Get the execution id BEFORE starting the body (so we
              // can arm it from the test driver).
              const executionId = yield* RuntimeContextSessionWorkflow.executionId({
                contextId,
                attempt,
                expectedInputs: 3,
              })

              // Start the body — it will park on the missing input row.
              const executeFiber = yield* Effect.fork(
                RuntimeContextSessionWorkflow.execute({
                  contextId,
                  attempt,
                  expectedInputs: 3,
                }),
              )

              // Give the body a moment to park.
              yield* Effect.sleep("100 millis")

              // Send three inputs via append + kernel arm.
              yield* appendAndArm({
                unified: services.unified,
                kernel: services.kernel,
                contextId,
                inputId: "i-1",
                kind: "prompt",
                payloadJson: inputPayload("one"),
                executionId,
              })
              yield* appendAndArm({
                unified: services.unified,
                kernel: services.kernel,
                contextId,
                inputId: "i-2",
                kind: "prompt",
                payloadJson: inputPayload("two"),
                executionId,
              })
              yield* appendAndArm({
                unified: services.unified,
                kernel: services.kernel,
                contextId,
                inputId: "i-3",
                kind: "terminal",
                payloadJson: inputPayload("three-terminal"),
                executionId,
              })

              const exit = yield* executeFiber.await
              if (Exit.isFailure(exit)) {
                return yield* Effect.failCause(exit.cause)
              }
              const snapshot = yield* recorder.snapshot
              const runRow = yield* services.unified.runs.get(
                runKey(contextId, attempt),
              ).pipe(Effect.map(Option.getOrUndefined))
              const outputRows = yield* services.unified.outputs.query((coll) =>
                coll.toArray.filter((r) => r.contextId === contextId))
              return {
                spawns: snapshot.spawns.length,
                sends: snapshot.sends.length,
                runStatus: runRow?.status,
                outputCount: outputRows.length,
              }
            }),
        )
      }) as Effect.Effect<
        {
          readonly spawns: number
          readonly sends: number
          readonly runStatus: "started" | "exited" | "failed" | undefined
          readonly outputCount: number
        },
        unknown
      >,
    )

    expect(outcome.spawns).toBe(1)
    expect(outcome.sends).toBe(3)
    expect(outcome.runStatus).toBe("exited")
    expect(outcome.outputCount).toBe(3)
  }, 20_000)

  it("crash recovery: kernel replay re-arms parked body across reconstruction; outputs land + run row settles", async () => {
    const ns = `p2-crash-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-crash"
    const attempt = 1

    // Generation 1: park the body, atomic-append one input (the
    // unified atomic append already writes the row + ids; we then call
    // kernelRecordAndWrite WITHOUT arm by going through the lower-level
    // path). For this test we use kernelWriteArm normally for the
    // first input so the body processes it, then we record-only the
    // terminal input + drop the generation before the body completes.
    const gen1State: { executionId: string } = { executionId: "" }
    const gen1Recorder = await Effect.runPromise(makeRuntimeContextRecorder())
    await Effect.runPromise(
      runGeneration(
        setupFor(urls, gen1Recorder),
        (services) =>
          Effect.gen(function*() {
            yield* ensureContext({
              table: services.unified,
              contextId,
              agent: "test",
            })
            gen1State.executionId =
              yield* RuntimeContextSessionWorkflow.executionId({
                contextId,
                attempt,
                expectedInputs: 1,
              })
            // Start the body in a forked fiber; let it park.
            yield* Effect.fork(
              RuntimeContextSessionWorkflow.execute({
                contextId,
                attempt,
                expectedInputs: 1,
              }),
            )
            yield* Effect.sleep("100 millis")
            // Append the terminal input WITHOUT arming — the row exists
            // but the engine doesn't know to wake. Generation 2 must
            // close the gap via replay.
            yield* appendInputIntent({
              table: services.unified,
              contextId,
              inputId: "terminal",
              kind: "terminal",
              payloadJson: inputPayload("terminal-payload"),
            })
            // Record kernel fact so replay knows what to do.
            yield* services.kernel.commands.insertOrGet({
              commandKey: `${RuntimeContextSessionWorkflow.name}|${gen1State.executionId}|${inputKey(contextId, 0)}`,
              workflowName: RuntimeContextSessionWorkflow.name,
              executionId: gen1State.executionId,
              inputTable: "inputs",
              inputKey: inputKey(contextId, 0),
              inputValueJson: JSON.stringify({
                contextId,
                inputId: "terminal",
                sequence: 0,
                kind: "terminal",
                payloadJson: inputPayload("terminal-payload"),
              }),
              status: "pending",
              recordedAt: new Date().toISOString(),
            }).pipe(Effect.orDie)
            yield* Effect.sleep("50 millis")
            // Close generation here.
          }) as Effect.Effect<void, unknown>,
      ),
    )

    // Generation 2: rebuild. Replay re-arms the parked body. The
    // existing input row is already on disk; replay sees that, sees
    // the execution has no finalResult, and re-arms.
    const gen2Recorder = await Effect.runPromise(makeRuntimeContextRecorder())
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        // Build the rewriter against an isolated UnifiedTable scope so
        // we can pass it into runGeneration's rewriter.
        const dummyUnified = yield* Effect.scoped(
          Effect.gen(function*() {
            return yield* UnifiedTable
          }).pipe(Effect.provide(tableLayerFor(UnifiedTable, urls.unifiedTableStreamUrl))),
        )
        return yield* runGeneration(
          {
            ...setupFor(urls, gen2Recorder),
            rewriter: inputRewriter(dummyUnified),
          },
          (services) =>
            Effect.gen(function*() {
              const found = yield* awaitExecutionFinalResult(
                services.engineTable,
                gen1State.executionId,
                "5 seconds",
              )
              const runRow = yield* services.unified.runs.get(
                runKey(contextId, attempt),
              ).pipe(Effect.map(Option.getOrUndefined))
              const outputRows = yield* services.unified.outputs.query((coll) =>
                coll.toArray.filter((r) => r.contextId === contextId))
              return {
                found,
                runStatus: runRow?.status,
                outputCount: outputRows.length,
                replayed: services.replayed,
              }
            }),
        )
      }) as Effect.Effect<
        {
          readonly found: boolean
          readonly runStatus: string | undefined
          readonly outputCount: number
          readonly replayed: number
        },
        unknown
      >,
    )

    expect(outcome.found).toBe(true)
    expect(outcome.runStatus).toBe("exited")
    expect(outcome.outputCount).toBe(1)
    expect(outcome.replayed).toBeGreaterThanOrEqual(1)
  }, 20_000)
})

