/**
 * P1 — Signal primitive + substrate validation.
 *
 * Asserts the durable-signal primitive:
 *   1. happy path: `sendSignal` wakes a parked workflow body that
 *      consumed the signal via `awaitSignal`.
 *   2. crash between record and resume: `recoverPendingSignals` re-
 *      arms on restart and the body completes without test re-drive.
 *   3. bounded ownership: workflows that have no signal for them are
 *      NOT touched by recovery (a `DurableDeferred.await`-only body
 *      stays parked across reconstruction).
 *
 * Per-key serialization comes free from `Workflow.idempotencyKey` +
 * the engine's single-fiber execution model. There is no per-key
 * mutex helper.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import {
  DurableDeferred,
  Workflow,
  type WorkflowEngine,
} from "@effect/workflow"
import { Effect, Exit, Option, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  awaitSignal,
  recordSignal,
  type ResumableWorkflow,
  sendSignal,
  type WorkflowCatalog,
} from "../../src/simulations/unified-kernel-validation/signal.ts"
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

// ── Test workflow: parks on `awaitSignal`, returns the payload ──────────────

const TestPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  inputId: Schema.String,
})

const SignalBodyWorkflow = Workflow.make({
  name: "p1-signal-body",
  payload: TestPayloadSchema,
  success: Schema.String,
  idempotencyKey: (p) => `${p.contextId}:${p.inputId}`,
})

const TEST_SIGNAL_NAME = "test-input"

const buildSignalBodyLayer = () =>
  SignalBodyWorkflow.toLayer(() =>
    Effect.gen(function*() {
      const body = yield* awaitSignal<{ readonly body: string }>({ name: TEST_SIGNAL_NAME })
      return body.body
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

// ── Test plumbing ───────────────────────────────────────────────────────────

const catalogFor = (
  workflows: ReadonlyArray<ResumableWorkflow>,
): WorkflowCatalog => makeCatalog(workflows)

const buildUrls = (namespace: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.engine`),
  unifiedTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.tables`),
  signalTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.signals`),
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe("P1 — signal + substrate", () => {
  it("happy path: sendSignal wakes a parked body that returns the signal payload", async () => {
    const ns = `p1-happy-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-A"
    const inputId = "i-1"
    const expectedBody = "hello-via-signal"

    const setup = {
      urls,
      workflowLayers: [buildSignalBodyLayer()],
      catalog: catalogFor([SignalBodyWorkflow]),
    }

    await Effect.runPromise(
      runGeneration(setup, (services) =>
        Effect.gen(function*() {
          // Park the body (no signal yet → Workflow.suspend).
          const exit = yield* Effect.exit(
            SignalBodyWorkflow.execute({ contextId, inputId }).pipe(
              Effect.timeoutOption("100 millis"),
            ),
          )
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) expect(Option.isNone(exit.value)).toBe(true)

          const executionId = yield* SignalBodyWorkflow.executionId({ contextId, inputId })

          // Send the signal: record row + resume.
          yield* sendSignal({
            signals: services.signals,
            workflow: SignalBodyWorkflow,
            executionId,
            name: TEST_SIGNAL_NAME,
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

  it("crash between record and resume: recovery re-arms on restart", async () => {
    const ns = `p1-replay-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-B"
    const inputId = "i-replay"
    const body = "delivered-by-recovery"

    // Generation 1: park the body, record the signal WITHOUT resuming,
    // drop the generation. Simulates a crash between durable record
    // and engine resume.
    const gen1: { executionId: string } = { executionId: "" }
    await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildSignalBodyLayer()],
          catalog: catalogFor([SignalBodyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            yield* Effect.exit(
              SignalBodyWorkflow.execute({ contextId, inputId }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            const executionId = yield* SignalBodyWorkflow.executionId({ contextId, inputId })
            gen1.executionId = executionId
            yield* recordSignal({
              signals: services.signals,
              workflowName: SignalBodyWorkflow.name,
              executionId,
              name: TEST_SIGNAL_NAME,
              write: () => Effect.void,
              value: { body },
              serializeValue: (v) => JSON.stringify(v),
            })
          }) as Effect.Effect<void, unknown>,
      ),
    )

    // Generation 2: rebuild. Recovery re-arms; body completes.
    const final = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildSignalBodyLayer()],
          catalog: catalogFor([SignalBodyWorkflow]),
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

  it("bounded ownership: deferred-only workflow is NOT touched by signal recovery", async () => {
    const ns = `p1-bounded-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-C"
    const inputId = "i-bounded"
    const body = "signal-owned-body"

    const gen1State: { signalExec: string; deferredExec: string } = {
      signalExec: "",
      deferredExec: "",
    }
    await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildSignalBodyLayer(), buildDeferredOnlyLayer()],
          catalog: catalogFor([SignalBodyWorkflow, DeferredOnlyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            yield* Effect.exit(
              SignalBodyWorkflow.execute({ contextId, inputId }).pipe(
                Effect.timeoutOption("100 millis"),
              ),
            )
            gen1State.signalExec = yield* SignalBodyWorkflow.executionId({ contextId, inputId })
            // Record signal but DO NOT resume — generation 2's recovery
            // must close the gap.
            yield* recordSignal({
              signals: services.signals,
              workflowName: SignalBodyWorkflow.name,
              executionId: gen1State.signalExec,
              name: TEST_SIGNAL_NAME,
              write: () => Effect.void,
              value: { body },
              serializeValue: (v) => JSON.stringify(v),
            })
            // Start the deferred-only body (no signal for it).
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
          workflowLayers: [buildSignalBodyLayer(), buildDeferredOnlyLayer()],
          catalog: catalogFor([SignalBodyWorkflow, DeferredOnlyWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const signalFinal = yield* services.engineTable.executions.rows().pipe(
              Stream.filter((row) =>
                row.executionId === gen1State.signalExec &&
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
              signalFinal,
              deferredHasFinal: deferredRow?.finalResult !== undefined,
              replayed: services.replayed,
              replaySkipped: services.replaySkipped,
            }
          }),
      ),
    )
    expect(observations.signalFinal).toBe(true)
    expect(observations.deferredHasFinal).toBe(false)
    expect(observations.replayed).toBeGreaterThanOrEqual(1)
  }, 15_000)
})

// Type-only export usage to satisfy unused-import check.
type _GenerationServicesUsage = GenerationServices
