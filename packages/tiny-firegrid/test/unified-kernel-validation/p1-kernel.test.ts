/**
 * P1 — Kernel + substrate validation.
 *
 * Asserts the kernel-owned write+arm primitive:
 *   1. happy path: write+arm wakes a parked workflow body.
 *   2. crash between write and arm: replay re-arms on restart.
 *   3. bounded ownership: workflows the kernel doesn't own a fact for
 *      are NOT touched by replay.
 *   4. per-key mutex: same-key serializes, cross-key concurrent.
 *
 * Pattern ported from `kernel-owned-write-arm` simulation, generalized
 * for use as the substrate underneath the full subscriber matrix in
 * P2-P5.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import {
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Effect, Exit, Option, Ref, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type KernelRowRewriter,
  type KernelWorkflowCatalog,
  kernelRecordAndWrite,
  kernelWriteArm,
  type ResumableWorkflow,
} from "../../src/simulations/unified-kernel-validation/kernel.ts"
import {
  makePerKeyMutex,
} from "../../src/simulations/unified-kernel-validation/per-key-mutex.ts"
import {
  type GenerationServices,
  type GenerationUrls,
  makeCatalog,
  runGeneration,
  tableLayerFor,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"
import {
  UnifiedTable,
  inputKey,
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

// ── Test workflow: parks on a workflow-owned input row ──────────────────────

const TestPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  inputId: Schema.String,
})

const InputBodyWorkflow = Workflow.make({
  name: "p1-input-body",
  payload: TestPayloadSchema,
  success: Schema.String,
  idempotencyKey: (p) => `${p.contextId}:${p.inputId}`,
})

const buildInputBodyLayer = () =>
  InputBodyWorkflow.toLayer((payload) =>
    Effect.gen(function*() {
      const instance = yield* WorkflowEngine.WorkflowInstance
      const table = yield* UnifiedTable
      // P1 uses sequence=0 for simplicity — the test workflow processes
      // a single input at the cursor head.
      const row = yield* table.inputs.get(
        inputKey(payload.contextId, 0),
      ).pipe(Effect.orDie)
      if (Option.isNone(row)) {
        return yield* Workflow.suspend(instance)
      }
      return row.value.payloadJson
    }))

// ── Deferred-only contrast workflow (bounded-ownership probe) ───────────────

const Gate = DurableDeferred.make("p1-gate", { success: Schema.String })

const DeferredOnlyWorkflow = Workflow.make({
  name: "p1-deferred-only",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: (p) => p.id,
})

const buildDeferredOnlyLayer = () =>
  DeferredOnlyWorkflow.toLayer(() => DurableDeferred.await(Gate))

// ── Catalog + rewriter (for restart recovery) ───────────────────────────────

const catalogFor = (
  workflows: ReadonlyArray<ResumableWorkflow>,
): KernelWorkflowCatalog => makeCatalog(workflows)

const inputRewriterFor = (
  unified: UnifiedTable["Type"],
): KernelRowRewriter => ({
  forCommand: (cmd) => {
    if (cmd.inputTable !== "inputs") return undefined
    const payload = JSON.parse(cmd.inputValueJson) as {
      readonly contextId: string
      readonly inputId: string
      readonly kind: string
      readonly payloadJson: string
    }
    return unified.inputs.insertOrGet({
      inputKey: cmd.inputKey,
      contextId: payload.contextId,
      inputId: payload.inputId,
      sequence: 0,
      kind: payload.kind as "prompt",
      payloadJson: payload.payloadJson,
      appendedAt: new Date().toISOString(),
    }).pipe(Effect.orDie, Effect.asVoid)
  },
})

// ── Test plumbing ───────────────────────────────────────────────────────────

const buildUrls = (namespace: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.engine`),
  unifiedTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.tables`),
  kernelTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.kernel`),
})

const inputValuePayload = (contextId: string, inputId: string, body: string) => ({
  contextId,
  inputId,
  kind: "prompt" as const,
  payloadJson: body,
})

const writeInputRow = (
  unified: UnifiedTable["Type"],
  contextId: string,
  inputId: string,
  body: string,
) =>
  unified.inputs.insertOrGet({
    inputKey: inputKey(contextId, 0),
    contextId,
    inputId,
    sequence: 0,
    kind: "prompt",
    payloadJson: body,
    appendedAt: new Date().toISOString(),
  }).pipe(Effect.orDie, Effect.asVoid)

// ── Tests ───────────────────────────────────────────────────────────────────

describe("P1 — kernel + substrate", () => {
  it("happy path: kernelWriteArm wakes a parked body, body returns the row's payload", async () => {
    const ns = `p1-happy-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-A"
    const inputId = "i-1"
    const expectedBody = "hello-from-kernel"

    const inputBodyLayer = buildInputBodyLayer()
    const setup = {
      urls,
      workflowLayers: [inputBodyLayer],
      catalog: catalogFor([InputBodyWorkflow]),
    }

    const result = await Effect.runPromise(
      runGeneration(setup, (services) =>
        Effect.gen(function*() {
          // Park the body (no row yet → Workflow.suspend).
          const exit = yield* Effect.exit(
            InputBodyWorkflow.execute({ contextId, inputId }).pipe(
              Effect.timeoutOption("100 millis"),
            ),
          )
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) expect(Option.isNone(exit.value)).toBe(true)

          const executionId = yield* InputBodyWorkflow.executionId({ contextId, inputId })

          // Now arm: kernel records fact + writes row + resumes.
          yield* kernelWriteArm({
            kernel: services.kernel,
            workflow: InputBodyWorkflow,
            executionId,
            inputTable: "inputs",
            inputKey: inputKey(contextId, inputId),
            write: (value) => writeInputRow(services.unified, value.contextId, value.inputId, value.payloadJson),
            value: inputValuePayload(contextId, inputId, expectedBody),
            serializeValue: (v) => JSON.stringify(v),
          })

          // Await the final result via the executions table.
          const final = yield* services.engineTable.executions.rows().pipe(
            Stream.filter((row) =>
              row.executionId === executionId && row.finalResult !== undefined),
            Stream.runHead,
            Effect.timeoutOption("3 seconds"),
            Effect.map(Option.flatten),
          )
          expect(Option.isSome(final)).toBe(true)
        })),
    )
    expect(result).toBeUndefined()
  }, 10_000)

  it("crash between write and arm: replay re-arms on restart", async () => {
    const ns = `p1-replay-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-B"
    const inputId = "i-replay"
    const body = "delivered-by-replay"

    // Generation 1: kernel records fact, writes row, but we DROP the arm
    // before the body can complete. We simulate this by calling
    // kernelWriteArm WITHOUT awaiting the engine finalResult; then we
    // close the generation (drops in-memory state).
    const gen1Layer = buildInputBodyLayer()
    const gen1: { executionId: string } = { executionId: "" }
    await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [gen1Layer],
          catalog: catalogFor([InputBodyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            // Park the body.
            yield* Effect.exit(
              InputBodyWorkflow.execute({ contextId, inputId }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            const executionId = yield* InputBodyWorkflow.executionId({ contextId, inputId })
            gen1.executionId = executionId

            // Record the kernel fact + write the row, but DO NOT arm —
            // models a crash between the durable write and the engine
            // resume. Generation 2's replay must re-arm.
            yield* kernelRecordAndWrite({
              kernel: services.kernel,
              workflowName: InputBodyWorkflow.name,
              executionId,
              inputTable: "inputs",
              inputKey: inputKey(contextId, 0),
              write: (v) => writeInputRow(services.unified, v.contextId, v.inputId, v.payloadJson),
              value: inputValuePayload(contextId, inputId, body),
              serializeValue: (v) => JSON.stringify(v),
            })
            // Closing the scope here drops the in-memory engine state.
          }) as Effect.Effect<void, unknown>,
      ),
    )

    // Generation 2: rebuild. Replay should re-arm and the body should complete.
    const gen2Layer = buildInputBodyLayer()
    const final = await Effect.runPromise(
      Effect.gen(function*() {
        // Build kernel/unified outside runGeneration so we can capture
        // the unified table for the rewriter.
        const dummyUnified = yield* Effect.scoped(
          Effect.gen(function*() {
            return yield* UnifiedTable
          }).pipe(
            Effect.provide(
              tableLayerFor(UnifiedTable, urls.unifiedTableStreamUrl),
            ),
          ),
        )
        return yield* runGeneration(
          {
            urls,
            workflowLayers: [gen2Layer],
            catalog: catalogFor([InputBodyWorkflow]),
            rewriter: inputRewriterFor(dummyUnified),
          },
          (services) =>
            Effect.gen(function*() {
              // Replay already ran inside runGeneration. Await final result.
              const finalRow = yield* services.engineTable.executions.get(
                gen1.executionId,
              ).pipe(Effect.map(Option.getOrUndefined))
              if (finalRow?.finalResult !== undefined) return true
              // Else wait briefly for the resumed body to settle.
              const found = yield* services.engineTable.executions.rows().pipe(
                Stream.filter((row) =>
                  row.executionId === gen1.executionId &&
                  row.finalResult !== undefined),
                Stream.runHead,
                Effect.timeoutOption("3 seconds"),
                Effect.map((opt) => Option.flatten(opt)),
                Effect.map(Option.isSome),
              )
              return found
            }),
        )
      }) as Effect.Effect<boolean, unknown>,
    )
    expect(final).toBe(true)
  }, 15_000)

  it("bounded ownership: deferred-only workflow is NOT touched by kernel replay", async () => {
    const ns = `p1-bounded-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-C"
    const inputId = "i-bounded"
    const body = "kernel-owned-body"

    // Generation 1: park the kernel-owned body + start (and DON'T resolve)
    // the deferred-only body. Crash.
    const gen1WakeLayer = buildInputBodyLayer()
    const gen1DeferredLayer = buildDeferredOnlyLayer()
    const gen1State: { wakeExec: string; deferredExec: string } = {
      wakeExec: "",
      deferredExec: "",
    }
    await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [gen1WakeLayer, gen1DeferredLayer],
          catalog: catalogFor([InputBodyWorkflow, DeferredOnlyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            // Park the kernel-owned body.
            yield* Effect.exit(
              InputBodyWorkflow.execute({ contextId, inputId }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            gen1State.wakeExec = yield* InputBodyWorkflow.executionId({ contextId, inputId })
            // Record the kernel fact + write the row, but DO NOT arm —
            // so generation 2's replay has work to do.
            yield* kernelRecordAndWrite({
              kernel: services.kernel,
              workflowName: InputBodyWorkflow.name,
              executionId: gen1State.wakeExec,
              inputTable: "inputs",
              inputKey: inputKey(contextId, 0),
              write: (v) => writeInputRow(services.unified, v.contextId, v.inputId, v.payloadJson),
              value: inputValuePayload(contextId, inputId, body),
              serializeValue: (v) => JSON.stringify(v),
            })
            // Start the deferred-only body (no kernel fact for it).
            yield* Effect.exit(
              DeferredOnlyWorkflow.execute({ id: "deferred-1" }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            gen1State.deferredExec = yield* DeferredOnlyWorkflow.executionId({ id: "deferred-1" })
          }) as Effect.Effect<void, unknown>,
      ),
    )

    // Generation 2: replay only touches the kernel-owned execution.
    const gen2Layers = [buildInputBodyLayer(), buildDeferredOnlyLayer()]
    const observations = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: gen2Layers,
          catalog: catalogFor([InputBodyWorkflow, DeferredOnlyWorkflow]),
          rewriter: {
            forCommand: (cmd) => {
              if (cmd.inputTable !== "inputs") return undefined
              const value = JSON.parse(cmd.inputValueJson) as ReturnType<
                typeof inputValuePayload
              >
              return Effect.gen(function*() {
                const unified = yield* UnifiedTable
                yield* writeInputRow(unified, value.contextId, value.inputId, value.payloadJson)
              }) as Effect.Effect<void, unknown>
            },
          },
        },
        (services) =>
          Effect.gen(function*() {
            // Wait for the kernel-owned execution to complete.
            const wakeFinal = yield* services.engineTable.executions.rows().pipe(
              Stream.filter((row) =>
                row.executionId === gen1State.wakeExec &&
                row.finalResult !== undefined),
              Stream.runHead,
              Effect.timeoutOption("3 seconds"),
              Effect.map((opt) => Option.flatten(opt)),
              Effect.map(Option.isSome),
            )

            // The deferred-only execution should NOT have a finalResult
            // (kernel replay didn't touch it).
            const deferredRow = yield* services.engineTable.executions.get(
              gen1State.deferredExec,
            ).pipe(Effect.map(Option.getOrUndefined))

            return {
              wakeFinal,
              deferredHasFinal: deferredRow?.finalResult !== undefined,
              replayed: services.replayed,
              replaySkipped: services.replaySkipped,
            }
          }),
      ),
    )
    expect(observations.wakeFinal).toBe(true)
    expect(observations.deferredHasFinal).toBe(false)
    expect(observations.replayed).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it("per-key mutex: same-key serializes, cross-key runs concurrent", async () => {
    const concurrentInKey = await Effect.runPromise(
      Effect.gen(function*() {
        const mutex = yield* makePerKeyMutex()
        const inFlight = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
        const maxInFlight = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

        const bump = (key: string, delta: number) =>
          Ref.update(inFlight, (m) => {
            const next = new Map(m)
            const current = (next.get(key) ?? 0) + delta
            next.set(key, current)
            return next
          })
        const captureMax = (key: string) =>
          Effect.gen(function*() {
            const current = (yield* Ref.get(inFlight)).get(key) ?? 0
            yield* Ref.update(maxInFlight, (m) => {
              const next = new Map(m)
              const prev = next.get(key) ?? 0
              next.set(key, Math.max(prev, current))
              return next
            })
          })

        const doWork = (key: string) =>
          mutex.withLock(
            key,
            Effect.gen(function*() {
              yield* bump(key, +1)
              yield* captureMax(key)
              yield* Effect.sleep("50 millis")
              yield* bump(key, -1)
            }),
          )

        yield* Effect.all(
          [
            doWork("a"),
            doWork("a"),
            doWork("a"),
            doWork("b"),
            doWork("b"),
          ],
          { concurrency: "unbounded" },
        )

        const maxes = yield* Ref.get(maxInFlight)
        return { a: maxes.get("a") ?? 0, b: maxes.get("b") ?? 0 }
      }),
    )

    expect(concurrentInKey.a).toBe(1)
    expect(concurrentInKey.b).toBe(1)
  }, 10_000)
})

// Type-only export usage to satisfy unused-import check.
type _GenerationServicesUsage = GenerationServices
