import {
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "@firegrid/runtime/workflow-engine"
import { type Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { DurableTable } from "effect-durable-operators"

// tf-c9r9 — kernel-owned write+arm (reference / target shape).
//
// The target rearch shape (NOT the retiring production DurableDeferred input
// mailbox): a runtime-context body parks on a workflow-owned TABLE input
// (Workflow.suspend, no deferred mailbox), and a single serialized
// host-kernel/controller owns the "write the input row + arm the owning
// execution" pair as one durable control step. The kernel records the write+arm
// as a fact IT owns; on restart it replays only its OWN pending facts and
// re-drives exactly those executions — never a generic resume-all sweep over
// arbitrary suspended workflows (which tf-12q9 proved unsound, because a
// DurableDeferred.await suspension is indistinguishable from a table-wait at the
// engine-row level).
//
// The "crash" / "restart" primitive is the engine's own lifecycle, exactly as
// the S1 sim used it: a generation is one DurableStreamsWorkflowEngine scope
// over a run-scoped Durable Streams server. Closing the scope drops the
// in-memory running/workflows maps (= process death); durable rows persist. A
// fresh engine layer over the SAME stream URLs is a faithful reconstruction.

const now = (): string => new Date().toISOString()

// ── Workflow-owned tables (the body reads these) ────────────────────────────

const InputRowSchema = Schema.Struct({
  key: Schema.String.pipe(DurableTable.primaryKey),
  value: Schema.String,
}).annotations({
  identifier: "firegrid.kwa.inputRow",
  title: "kwa workflow-owned input row",
})

const ProcessedRowSchema = Schema.Struct({
  key: Schema.String.pipe(DurableTable.primaryKey),
  value: Schema.String,
  processedAt: Schema.String,
}).annotations({
  identifier: "firegrid.kwa.processedRow",
  title: "kwa processed-input marker",
})

class KwaTable extends DurableTable("kwa.input", {
  inputs: InputRowSchema,
  processed: ProcessedRowSchema,
}) {}

// ── Kernel-owned control table (kernel-private; the body never reads this) ───
//
// One row per write+arm fact the kernel owns. Written FIRST as the durable
// record of intent ("deliver `inputValue` under `inputKey` to `executionId`").
// write-input + arm are the idempotent effects the kernel (re-)performs to
// satisfy the fact. status flips to "satisfied" once the body has a finalResult.

const WriteArmCommandRowSchema = Schema.Struct({
  commandKey: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  inputKey: Schema.String,
  inputValue: Schema.String,
  status: Schema.Literal("pending", "satisfied"),
}).annotations({
  identifier: "firegrid.kwa.writeArmCommand",
  title: "kwa kernel-owned write+arm command fact",
})

class KernelCommandTable extends DurableTable("kwa.kernel", {
  commands: WriteArmCommandRowSchema,
}) {}

// ── Workflow body: table-wait, NO deferred mailbox (tf-e5rf shape) ───────────

export const WakeWorkflow = Workflow.make({
  name: "kwa-wake-workflow",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: payload => payload.id,
})

const wakeBody = (payload: { readonly id: string }) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const table = yield* KwaTable
    const row = yield* table.inputs.get(payload.id).pipe(Effect.orDie)
    if (Option.isNone(row)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.kwa.body.decision": "suspend",
        "firegrid.kwa.input.key": payload.id,
      })
      // Table-wait: voluntary suspend, NO DurableDeferred mailbox.
      return yield* Workflow.suspend(instance)
    }
    yield* table.processed.insertOrGet({
      key: payload.id,
      value: row.value.value,
      processedAt: now(),
    }).pipe(Effect.orDie)
    yield* Effect.annotateCurrentSpan({
      "firegrid.kwa.body.decision": "process",
      "firegrid.kwa.input.key": payload.id,
      "firegrid.kwa.input.value": row.value.value,
    })
    return row.value.value
  }).pipe(
    Effect.withSpan("firegrid.kwa.wake_workflow.body", {
      kind: "consumer",
      attributes: { "firegrid.workflow.name": "kwa-wake-workflow" },
    }),
  )

// ── Deferred-await contrast workflow (soundness probe) ───────────────────────
//
// A body parked on a DurableDeferred. The kernel write+arm replay must NOT touch
// it (no command fact references it), proving the replay is bounded to owned
// facts — the exact property the generic engine sweep (tf-12q9) lacked.

const Gate = DurableDeferred.make("kwa-gate", { success: Schema.String })

export const DeferredWorkflow = Workflow.make({
  name: "kwa-deferred-workflow",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: payload => payload.id,
})

const deferredBody = (_payload: { readonly id: string }) =>
  DurableDeferred.await(Gate).pipe(
    Effect.withSpan("firegrid.kwa.deferred_workflow.body", {
      kind: "consumer",
      attributes: { "firegrid.workflow.name": "kwa-deferred-workflow" },
    }),
  )

// ── Generation harness ───────────────────────────────────────────────────────

const kwaTableLayerFor = (url: string) =>
  KwaTable.layer({
    streamOptions: { url, contentType: "application/json" },
    txTimeoutMs: 2_000,
  })

const kernelTableLayerFor = (url: string) =>
  KernelCommandTable.layer({
    streamOptions: { url, contentType: "application/json" },
    txTimeoutMs: 2_000,
  })

const engineLayerFor = (url: string) =>
  DurableStreamsWorkflowEngine.layer({ streamUrl: url })

export interface GenerationUrls {
  readonly engineStreamUrl: string
  readonly inputStreamUrl: string
  readonly kernelStreamUrl: string
}

export interface KernelServices {
  readonly engineTable: WorkflowEngineTableService
  readonly inputTable: KwaTable["Type"]
  readonly commandTable: KernelCommandTable["Type"]
}

type WakeGenerationCtx =
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngineTable
  | KwaTable
  | KernelCommandTable

// Run one engine generation registered with BOTH workflows + the input and
// kernel tables, then run the kernel startup recovery (replay of owned pending
// write+arm facts) BEFORE handing control to `program`. Registration happens in
// the layer build, so by the time `program` (and the replay) run the execute
// fns exist — the kernel deterministically sequences register → replay, which
// is exactly why this is sound where an engine-construction-time sweep was not.
export const runKernelGeneration = <A>(
  urls: GenerationUrls,
  program: (services: KernelServices) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, unknown> => {
  const inputTableLayer = kwaTableLayerFor(urls.inputStreamUrl)
  const kernelTableLayer = kernelTableLayerFor(urls.kernelStreamUrl)
  const wakeLayer = WakeWorkflow.toLayer(wakeBody).pipe(Layer.provide(inputTableLayer))
  const deferredLayer = DeferredWorkflow.toLayer(deferredBody)
  const generationLayer = Layer.mergeAll(
    wakeLayer,
    deferredLayer,
    inputTableLayer,
    kernelTableLayer,
  ).pipe(Layer.provideMerge(engineLayerFor(urls.engineStreamUrl)))
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      const inputTable = yield* KwaTable
      const commandTable = yield* KernelCommandTable
      const services: KernelServices = { engineTable, inputTable, commandTable }
      // Kernel startup recovery: replay owned pending facts. No-op on the first
      // generation (no commands yet); recovers parked executions on restart.
      yield* replayPendingWriteArm(services)
      return yield* program(services)
    }).pipe(
      Effect.provide(generationLayer as Layer.Layer<WakeGenerationCtx, unknown, never>),
    ),
  ) as Effect.Effect<A, unknown>
}

// ── Kernel-owned write+arm controller ────────────────────────────────────────

const commandKeyFor = (executionId: string, inputKey: string): string =>
  `${executionId}|${inputKey}`

// Step 1+2 of the durable control step: record the owned fact, then write the
// workflow-owned input row. Both idempotent (insertOrGet). Modeling a crash
// between "write" and "arm" = calling this WITHOUT kernelArm.
export const kernelRecordAndWrite = (
  services: KernelServices,
  executionId: string,
  inputKey: string,
  inputValue: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    yield* services.commandTable.commands.insertOrGet({
      commandKey: commandKeyFor(executionId, inputKey),
      executionId,
      inputKey,
      inputValue,
      status: "pending",
    })
    yield* services.inputTable.inputs.insertOrGet({ key: inputKey, value: inputValue })
  }).pipe(
    Effect.asVoid,
    Effect.withSpan("firegrid.kwa.kernel.record_and_write", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.execution_id": executionId,
        "firegrid.kwa.input.key": inputKey,
      },
    }),
  )

// Step 3: arm the owning execution by re-driving its parked table-wait body.
const kernelArm = (
  executionId: string,
): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  WakeWorkflow.resume(executionId).pipe(
    Effect.withSpan("firegrid.kwa.kernel.arm", {
      kind: "internal",
      attributes: { "firegrid.workflow.execution_id": executionId },
    }),
  )

// The full serialized write+arm command (record + write + arm) as one step.
export const kernelWriteArm = (
  services: KernelServices,
  executionId: string,
  inputKey: string,
  inputValue: string,
): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    yield* kernelRecordAndWrite(services, executionId, inputKey, inputValue)
    yield* kernelArm(executionId)
  }).pipe(
    Effect.withSpan("firegrid.kwa.kernel.write_arm", {
      kind: "internal",
      attributes: { "firegrid.workflow.execution_id": executionId },
    }),
  )

// Kernel startup recovery: replay ONLY the kernel's own pending write+arm facts.
// For each pending command whose execution has not completed, re-write the input
// (idempotent) and re-arm. Bounded to owned facts — never scans engine.executions
// for arbitrary suspended workflows, so deferred-await suspensions are untouched.
const replayPendingWriteArm = (
  services: KernelServices,
): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const pending = yield* services.commandTable.commands.query(coll =>
      coll.toArray.filter(row => row.status === "pending"))
    let index = 0
    while (index < pending.length) {
      const cmd = pending[index]!
      const exec = yield* services.engineTable.executions.get(cmd.executionId).pipe(
        Effect.map(Option.getOrUndefined),
      )
      if (exec?.finalResult === undefined) {
        yield* services.inputTable.inputs.insertOrGet({ key: cmd.inputKey, value: cmd.inputValue })
        yield* kernelArm(cmd.executionId)
      }
      index += 1
    }
  }).pipe(
    Effect.withSpan("firegrid.kwa.kernel.replay_pending", {
      kind: "internal",
      attributes: { "firegrid.kwa.kernel.pending_count_span": "see logs" },
    }),
  )

// ── Observation helpers (passive — never drive the body) ─────────────────────

export interface WakeObservation {
  readonly executionExists: boolean
  readonly suspended: boolean | undefined
  readonly hasFinalResult: boolean
  readonly deferredCount: number
  readonly processed: boolean
  readonly processedValue: string | undefined
}

export const observeWake = (
  engineTable: WorkflowEngineTableService,
  inputTable: KwaTable["Type"],
  executionId: string,
  inputKey: string,
): Effect.Effect<WakeObservation, unknown> =>
  Effect.gen(function*() {
    const exec = yield* engineTable.executions.get(executionId).pipe(
      Effect.map(Option.getOrUndefined),
    )
    const deferreds = yield* engineTable.deferreds.query(coll =>
      coll.toArray.filter(row => row.executionId === executionId))
    const processed = yield* inputTable.processed.get(inputKey).pipe(
      Effect.map(Option.getOrUndefined),
    )
    return {
      executionExists: exec !== undefined,
      suspended: exec?.suspended,
      hasFinalResult: exec?.finalResult !== undefined,
      deferredCount: deferreds.length,
      processed: processed !== undefined,
      processedValue: processed?.value,
    }
  })

export const isSuspended = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
): Effect.Effect<boolean, unknown> =>
  engineTable.executions.get(executionId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.map(exec => exec?.suspended === true),
  )

export const hasFinalResult = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
): Effect.Effect<boolean, unknown> =>
  engineTable.executions.get(executionId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.map(exec => exec?.finalResult !== undefined),
  )

// Bounded passive wait for an execution to gain a finalResult, driven off the
// table's live row subscription (not a fixed poll). Used to await the kernel's
// auto-recovery without driving the body from the test.
export const awaitFinalResult = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
  timeout: Duration.DurationInput,
): Effect.Effect<boolean, unknown> =>
  engineTable.executions.get(executionId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.flatMap(exec =>
      exec?.finalResult !== undefined
        ? Effect.succeed(true)
        : engineTable.executions.rows().pipe(
          Stream.filter(row =>
            row.executionId === executionId && row.finalResult !== undefined),
          Stream.runHead,
          Effect.map(Option.isSome),
          Effect.timeoutTo({
            duration: timeout,
            onTimeout: () => false,
            onSuccess: found => found,
          }),
        ),
    ),
  )

// Resolve the deferred-contrast Gate via the engine's own deferred completion
// (its recovery path, independent of the kernel write+arm replay). Mirrors how
// deferred-done-idempotency.test.ts completes a deferred from outside a body.
export const resolveGate = (
  value: string,
): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const executionId = yield* DeferredWorkflow.executionId({ id: "d" })
    yield* engine.deferredDone(Gate, {
      workflowName: DeferredWorkflow.name,
      executionId,
      deferredName: "kwa-gate",
      exit: Exit.succeed(value),
    })
  }).pipe(Effect.asVoid)
