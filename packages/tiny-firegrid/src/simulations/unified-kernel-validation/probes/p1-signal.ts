/**
 * P1 — Signal primitive runtime probes.
 *
 *   - probeP1A: happy path. Park body, send signal, body wakes and
 *     returns the signal payload. Body's finalResult lands.
 *   - probeP1B: crash between record and resume. Gen-1 records the
 *     signal without resuming, drops the generation. Gen-2 recovery
 *     re-arms; body completes without test re-drive.
 *   - probeP1C: bounded ownership. A `DurableDeferred.await`-only
 *     workflow with no signal for it stays parked across
 *     reconstruction; the kernel-owned execution recovers normally.
 */

import {
  DurableDeferred,
  Workflow,
  type WorkflowEngine,
} from "@effect/workflow"
import { Duration, Effect, Exit, Option, Schema } from "effect"
import {
  awaitSignal,
  recordSignal,
  type ResumableWorkflow,
  sendSignal,
  type WorkflowCatalog,
} from "../signal.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../substrate.ts"
import { awaitFinalLanded } from "./_helpers.ts"

const TestPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  inputId: Schema.String,
})

export const SignalBodyWorkflow = Workflow.make({
  name: "p1-signal-body",
  payload: TestPayloadSchema,
  success: Schema.String,
  idempotencyKey: (p) => `${p.contextId}:${p.inputId}`,
})

const TEST_SIGNAL_NAME = "test-input"

export const buildSignalBodyLayer = () =>
  SignalBodyWorkflow.toLayer(() =>
    Effect.gen(function*() {
      const body = yield* awaitSignal<{ readonly body: string }>({ name: TEST_SIGNAL_NAME })
      return body.body
    }))

const Gate = DurableDeferred.make("p1-gate", { success: Schema.String })

export const DeferredOnlyWorkflow = Workflow.make({
  name: "p1-deferred-only",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: (p) => p.id,
})

export const buildDeferredOnlyLayer = () =>
  DeferredOnlyWorkflow.toLayer(() => DurableDeferred.await(Gate))

const catalogFor = (workflows: ReadonlyArray<ResumableWorkflow>): WorkflowCatalog =>
  makeCatalog(workflows)

export interface ProbeP1AResult {
  readonly parked: boolean
  readonly finalLanded: boolean
}

export const probeP1A = (urls: GenerationUrls): Effect.Effect<ProbeP1AResult, unknown> =>
  runGeneration(
    {
      urls,
      workflowLayers: [buildSignalBodyLayer()],
      catalog: catalogFor([SignalBodyWorkflow]),
    },
    (services) =>
      Effect.gen(function*() {
        const contextId = "ctx-A"
        const inputId = "i-1"
        const exit = yield* Effect.exit(
          SignalBodyWorkflow.execute({ contextId, inputId }).pipe(
            Effect.timeoutOption("100 millis"),
          ),
        )
        const parked = Exit.isSuccess(exit) && Option.isNone(exit.value)

        const executionId = yield* SignalBodyWorkflow.executionId({ contextId, inputId })
        yield* sendSignal({
          signals: services.signals,
          workflow: SignalBodyWorkflow,
          executionId,
          name: TEST_SIGNAL_NAME,
          write: () => Effect.void,
          value: { body: "delivered-by-A" },
          serializeValue: (v) => JSON.stringify(v),
        })

        const finalLanded = yield* awaitFinalLanded(services.engineTable, executionId)
        return { parked, finalLanded } satisfies ProbeP1AResult
      }) as Effect.Effect<ProbeP1AResult, unknown, WorkflowEngine.WorkflowEngine>,
  )

export interface ProbeP1BResult {
  readonly gen1Recorded: boolean
  readonly autoRecovered: boolean
  readonly replayed: number
}

export const probeP1B = (urls: GenerationUrls): Effect.Effect<ProbeP1BResult, unknown> =>
  Effect.gen(function*() {
    const contextId = "ctx-B"
    const inputId = "i-replay"

    let executionId = ""
    yield* runGeneration(
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
          executionId = yield* SignalBodyWorkflow.executionId({ contextId, inputId })
          yield* recordSignal({
            signals: services.signals,
            workflowName: SignalBodyWorkflow.name,
            executionId,
            name: TEST_SIGNAL_NAME,
            write: () => Effect.void,
            value: { body: "delivered-by-recovery" },
            serializeValue: (v) => JSON.stringify(v),
          })
        }),
    )

    const recovery = yield* runGeneration(
      {
        urls,
        workflowLayers: [buildSignalBodyLayer()],
        catalog: catalogFor([SignalBodyWorkflow]),
      },
      (services) =>
        Effect.gen(function*() {
          const autoRecovered = yield* awaitFinalLanded(
            services.engineTable,
            executionId,
            Duration.seconds(5),
          )
          return { autoRecovered, replayed: services.replayed }
        }),
    )

    return {
      gen1Recorded: executionId !== "",
      autoRecovered: recovery.autoRecovered,
      replayed: recovery.replayed,
    } satisfies ProbeP1BResult
  })

export interface ProbeP1CResult {
  readonly signalExecRecovered: boolean
  readonly deferredExecUntouched: boolean
  readonly replayed: number
}

export const probeP1C = (urls: GenerationUrls): Effect.Effect<ProbeP1CResult, unknown> =>
  Effect.gen(function*() {
    const contextId = "ctx-C"
    const inputId = "i-bounded"

    let signalExec = ""
    let deferredExec = ""
    yield* runGeneration(
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
          signalExec = yield* SignalBodyWorkflow.executionId({ contextId, inputId })
          yield* recordSignal({
            signals: services.signals,
            workflowName: SignalBodyWorkflow.name,
            executionId: signalExec,
            name: TEST_SIGNAL_NAME,
            write: () => Effect.void,
            value: { body: "signal-owned-body" },
            serializeValue: (v) => JSON.stringify(v),
          })
          yield* Effect.exit(
            DeferredOnlyWorkflow.execute({ id: "deferred-1" }).pipe(
              Effect.timeoutOption("100 millis"),
            ),
          )
          deferredExec = yield* DeferredOnlyWorkflow.executionId({ id: "deferred-1" })
        }),
    )

    const observations = yield* runGeneration(
      {
        urls,
        workflowLayers: [buildSignalBodyLayer(), buildDeferredOnlyLayer()],
        catalog: catalogFor([SignalBodyWorkflow, DeferredOnlyWorkflow]),
      },
      (services) =>
        Effect.gen(function*() {
          const signalRecovered = yield* awaitFinalLanded(
            services.engineTable,
            signalExec,
            Duration.seconds(5),
          )
          const deferredRow = yield* services.engineTable.executions.get(deferredExec).pipe(
            Effect.map(Option.getOrUndefined),
          )
          return {
            signalRecovered,
            deferredUntouched: deferredRow?.finalResult === undefined,
            replayed: services.replayed,
          }
        }),
    )

    return {
      signalExecRecovered: observations.signalRecovered,
      deferredExecUntouched: observations.deferredUntouched,
      replayed: observations.replayed,
    } satisfies ProbeP1CResult
  })
