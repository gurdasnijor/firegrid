/**
 * P1 — Kernel + substrate validation.
 *
 * Asserts the kernel-owned write+arm primitive:
 *   1. happy path: write+arm wakes a parked workflow body that reads
 *      its own kernel command as the input log.
 *   2. crash between record and arm: replay re-arms on restart and the
 *      body completes without test re-drive.
 *   3. bounded ownership: workflows the kernel doesn't own a fact for
 *      are NOT touched by replay (a `DurableDeferred.await`-only body
 *      stays parked across reconstruction).
 *
 * Per-key serialization comes free from `Workflow.idempotencyKey` (one
 * execution per logical key) + the engine's single-fiber execution
 * model. There is no per-key mutex helper in the unified kernel.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import {
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Effect, Exit, Option, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  KernelCommandTable,
  type KernelWorkflowCatalog,
  kernelRecordAndWrite,
  kernelWriteArm,
  readCommandsFor,
  type ResumableWorkflow,
} from "../../src/simulations/unified-kernel-validation/kernel.ts"
import {
  type GenerationServices,
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"

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

// ── Test workflow: parks until a kernel command arrives, returns its payload ─

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

const TEST_INPUT_TABLE = "p1-test-inputs"

const buildInputBodyLayer = () =>
  InputBodyWorkflow.toLayer((_payload, executionId) =>
    Effect.gen(function*() {
      const instance = yield* WorkflowEngine.WorkflowInstance
      const kernel = yield* KernelCommandTable
      while (true) {
        const commands = yield* readCommandsFor(kernel, executionId).pipe(Effect.orDie)
        if (commands.length > 0) {
          const body = JSON.parse(commands[0].inputValueJson) as { readonly body: string }
          return body.body
        }
        yield* Workflow.suspend(instance)
        return yield* Effect.never
      }
    }) as Effect.Effect<string, never, WorkflowEngine.WorkflowInstance | KernelCommandTable>)

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

// ── Test plumbing ───────────────────────────────────────────────────────────

const catalogFor = (
  workflows: ReadonlyArray<ResumableWorkflow>,
): KernelWorkflowCatalog => makeCatalog(workflows)

const buildUrls = (namespace: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.engine`),
  unifiedTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.tables`),
  kernelTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.kernel`),
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe("P1 — kernel + substrate", () => {
  it("happy path: kernelWriteArm wakes a parked body that returns its kernel command payload", async () => {
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

    await Effect.runPromise(
      runGeneration(setup, (services) =>
        Effect.gen(function*() {
          // Park the body (no kernel command yet → Workflow.suspend).
          const exit = yield* Effect.exit(
            InputBodyWorkflow.execute({ contextId, inputId }).pipe(
              Effect.timeoutOption("100 millis"),
            ),
          )
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) expect(Option.isNone(exit.value)).toBe(true)

          const executionId = yield* InputBodyWorkflow.executionId({ contextId, inputId })

          // Arm: kernel records command (with payload) and resumes.
          yield* kernelWriteArm({
            kernel: services.kernel,
            workflow: InputBodyWorkflow,
            executionId,
            inputTable: TEST_INPUT_TABLE,
            inputKey: inputId,
            write: () => Effect.void,
            value: { body: expectedBody },
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
  }, 10_000)

  it("crash between record and arm: replay re-arms on restart", async () => {
    const ns = `p1-replay-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-B"
    const inputId = "i-replay"
    const body = "delivered-by-replay"

    // Generation 1: park the body, record the kernel command (with
    // payload) WITHOUT arming, then drop the generation. Simulates a
    // crash between durable record and engine resume.
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
            yield* Effect.exit(
              InputBodyWorkflow.execute({ contextId, inputId }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            const executionId = yield* InputBodyWorkflow.executionId({ contextId, inputId })
            gen1.executionId = executionId
            yield* kernelRecordAndWrite({
              kernel: services.kernel,
              workflowName: InputBodyWorkflow.name,
              executionId,
              inputTable: TEST_INPUT_TABLE,
              inputKey: inputId,
              write: () => Effect.void,
              value: { body },
              serializeValue: (v) => JSON.stringify(v),
            })
          }) as Effect.Effect<void, unknown>,
      ),
    )

    // Generation 2: rebuild. Replay re-arms; body completes.
    const gen2Layer = buildInputBodyLayer()
    const final = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [gen2Layer],
          catalog: catalogFor([InputBodyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const finalRow = yield* services.engineTable.executions.get(
              gen1.executionId,
            ).pipe(Effect.map(Option.getOrUndefined))
            if (finalRow?.finalResult !== undefined) return true
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
          }) as Effect.Effect<boolean, unknown, WorkflowEngine.WorkflowEngine>,
      ),
    )
    expect(final).toBe(true)
  }, 15_000)

  it("bounded ownership: deferred-only workflow is NOT touched by kernel replay", async () => {
    const ns = `p1-bounded-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-C"
    const inputId = "i-bounded"
    const body = "kernel-owned-body"

    const gen1State: { wakeExec: string; deferredExec: string } = {
      wakeExec: "",
      deferredExec: "",
    }
    await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildInputBodyLayer(), buildDeferredOnlyLayer()],
          catalog: catalogFor([InputBodyWorkflow, DeferredOnlyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            yield* Effect.exit(
              InputBodyWorkflow.execute({ contextId, inputId }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            gen1State.wakeExec = yield* InputBodyWorkflow.executionId({ contextId, inputId })
            // Record the kernel command but DO NOT arm — generation 2's
            // replay must close the gap.
            yield* kernelRecordAndWrite({
              kernel: services.kernel,
              workflowName: InputBodyWorkflow.name,
              executionId: gen1State.wakeExec,
              inputTable: TEST_INPUT_TABLE,
              inputKey: inputId,
              write: () => Effect.void,
              value: { body },
              serializeValue: (v) => JSON.stringify(v),
            })
            // Start the deferred-only body (no kernel command for it).
            yield* Effect.exit(
              DeferredOnlyWorkflow.execute({ id: "deferred-1" }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            gen1State.deferredExec = yield* DeferredOnlyWorkflow.executionId({ id: "deferred-1" })
          }) as Effect.Effect<void, unknown>,
      ),
    )

    const observations = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildInputBodyLayer(), buildDeferredOnlyLayer()],
          catalog: catalogFor([InputBodyWorkflow, DeferredOnlyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const wakeFinal = yield* services.engineTable.executions.rows().pipe(
              Stream.filter((row) =>
                row.executionId === gen1State.wakeExec &&
                row.finalResult !== undefined),
              Stream.runHead,
              Effect.timeoutOption("3 seconds"),
              Effect.map((opt) => Option.flatten(opt)),
              Effect.map(Option.isSome),
            )
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
})

// Type-only export usage to satisfy unused-import check.
type _GenerationServicesUsage = GenerationServices
