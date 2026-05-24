import {
  Activity,
  DurableClock,
  Workflow,
} from "@effect/workflow"
import type { WorkflowEngine } from "@effect/workflow"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

// tf-28b8 — Shape D workflow admission boundaries.
//
// Three target subscribers, each with a candidate Shape C arm (a keyed handler
// over DurableTable, no @effect/workflow body) and, where relevant, a Shape D
// arm (real @effect/workflow machinery over DurableStreamsWorkflowEngine). The
// probes classify which capability is genuinely load-bearing for Shape D:
//   - tool execution     -> Activity memoization / at-most-once external effect
//   - wait routing        -> durable race/timeout (DurableDeferred / DurableClock)
//   - scheduled prompt    -> DurableClock true-future delivery
//
// The "crash"/"restart" primitive is the engine's own lifecycle (S1 pattern):
// one engine scope == one generation; closing it drops in-memory maps and forked
// wakeup fibers while durable rows persist on the run-scoped server. A fresh
// engine/table layer over the SAME stream URL is a faithful reconstruction.

const now = (): string => new Date().toISOString()

// ── External side-effect witness ───────────────────────────────────────────
// A module-level counter standing in for a non-idempotent external effect (the
// thing at-most-once must protect). It survives engine scope close (same
// process), so it counts PHYSICAL executions across every generation — the
// witness that distinguishes "ran once" from "ran on each replay". This is a
// probe instrument, NOT durable runtime state, so the no-module-durable-cache
// rule does not apply: its whole job is to measure executions the durable rows
// are supposed to fence.
// eslint-disable-next-line local/no-module-durable-cache
let toolSideEffectCount = 0
export const resetToolSideEffectCount = (): void => {
  toolSideEffectCount = 0
}
export const toolSideEffectRuns = (): number => toolSideEffectCount
const runToolSideEffect = (toolUseId: string): string => {
  toolSideEffectCount += 1
  return `executed ${toolUseId} -> ok`
}

// ── Probe 1 Shape C: tool result identity over DurableTable ─────────────────
// At-most-once comes from a durable result row keyed by the tool-use idempotency
// identity (C3), not from replay memoization inside a workflow body.
const ToolResultRowSchema = Schema.Struct({
  toolResultKey: Schema.String.pipe(DurableTable.primaryKey),
  toolUseId: Schema.String,
  result: Schema.String,
  at: Schema.String,
}).annotations({ identifier: "firegrid.tf28b8.toolResultRow" })

class ToolResultTable extends DurableTable("tf28b8.toolResults", {
  results: ToolResultRowSchema,
}) {}

// ── Probe 2 Shape C: durable completion over DurableTable ───────────────────
// An async wait is a durable completion keyed by stable identity (C4): the
// producer resolves the row; the waiter reconstructs purely from the row after a
// crash, with NO in-memory waiter surviving. first-valid-terminal-wins.
const CompletionRowSchema = Schema.Struct({
  completionKey: Schema.String.pipe(DurableTable.primaryKey),
  status: Schema.Literal("pending", "resolved"),
  value: Schema.optional(Schema.String),
  at: Schema.String,
}).annotations({ identifier: "firegrid.tf28b8.completionRow" })

class CompletionTable extends DurableTable("tf28b8.completions", {
  completions: CompletionRowSchema,
}) {}

// ── Probe 3 Shape C: due-time row over DurableTable ─────────────────────────
// A scheduled prompt as plain durable state: a row carrying a future fireAt.
// Nothing in DurableTable fires it at wall-clock time — only an external poll
// can read it, which is exactly the polling/external-trigger outcome the target
// architecture wants to avoid.
const DueTimeRowSchema = Schema.Struct({
  dueKey: Schema.String.pipe(DurableTable.primaryKey),
  fireAtMs: Schema.Number,
  fired: Schema.Boolean,
  at: Schema.String,
}).annotations({ identifier: "firegrid.tf28b8.dueTimeRow" })

class DueTimeTable extends DurableTable("tf28b8.dueTimes", {
  dueTimes: DueTimeRowSchema,
}) {}

// ── DurableTable layer helpers (Shape C arms — no engine) ───────────────────
const tableStreamOptions = (env: TinyFiregridHostEnv, name: string) => ({
  url: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.tf28b8.${env.runId}.${name}`,
  ),
  contentType: "application/json" as const,
})

const tableOptions = (
  env: TinyFiregridHostEnv,
  name: string,
): DurableTableLayerOptions => ({
  streamOptions: tableStreamOptions(env, name),
  txTimeoutMs: 2_000,
})

const toolResultTableLayer = (env: TinyFiregridHostEnv) =>
  ToolResultTable.layer(tableOptions(env, "tool-results"))
const completionTableLayer = (env: TinyFiregridHostEnv) =>
  CompletionTable.layer(tableOptions(env, "completions"))
const dueTimeTableLayer = (env: TinyFiregridHostEnv) =>
  DueTimeTable.layer(tableOptions(env, "due-times"))

// Run a Shape C handler against a freshly-provided table layer. Each call is a
// fresh handler materialization over the durable rows — the Shape C model
// ("materialize for an event, apply transition, return").
export const provideToolResultTable = <A>(
  env: TinyFiregridHostEnv,
  program: (table: ToolResultTable["Type"]) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.scoped(
    Effect.flatMap(ToolResultTable, program).pipe(
      Effect.provide(toolResultTableLayer(env)),
    ),
  )

export const provideCompletionTable = <A>(
  env: TinyFiregridHostEnv,
  program: (table: CompletionTable["Type"]) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.scoped(
    Effect.flatMap(CompletionTable, program).pipe(
      Effect.provide(completionTableLayer(env)),
    ),
  )

export const provideDueTimeTable = <A>(
  env: TinyFiregridHostEnv,
  program: (table: DueTimeTable["Type"]) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.scoped(
    Effect.flatMap(DueTimeTable, program).pipe(
      Effect.provide(dueTimeTableLayer(env)),
    ),
  )

// Idempotent tool execution over the durable result row (Shape C). insertOrGet on
// the toolUseId-keyed row is the at-most-once fence: a re-delivery or replay finds
// the existing row instead of re-running the external effect.
export const executeToolShapeC = (
  table: ToolResultTable["Type"],
  toolUseId: string,
): Effect.Effect<{ readonly result: string; readonly genuinelyExecuted: boolean }, unknown> =>
  Effect.gen(function*() {
    const existing = yield* table.results.get(`tool/${toolUseId}`)
    if (existing._tag === "Some") {
      return { result: existing.value.result, genuinelyExecuted: false }
    }
    // Side effect runs, THEN the durable result row is written. insertOrGet keeps
    // a concurrent/retried writer from inserting a second row: on `Found` the
    // existing row's result wins, so the side effect's value is discarded.
    const result = runToolSideEffect(toolUseId)
    const written = yield* table.results.insertOrGet({
      toolResultKey: `tool/${toolUseId}`,
      toolUseId,
      result,
      at: now(),
    })
    return written._tag === "Inserted"
      ? { result, genuinelyExecuted: true }
      : { result: written.row.result, genuinelyExecuted: false }
  }).pipe(
    Effect.withSpan("firegrid.tf28b8.tool.shape_c.execute", {
      kind: "producer",
      attributes: { "firegrid.tf28b8.tool_use_id": toolUseId },
    }),
  )

// ── Probe 1 Shape D: tool execution as an Activity inside a Workflow ─────────
export const ToolWorkflow = Workflow.make({
  name: "tf28b8-tool-workflow",
  payload: Schema.Struct({ toolUseId: Schema.String }),
  success: Schema.String,
  idempotencyKey: payload => payload.toolUseId,
})

const toolWorkflowBody = (payload: { readonly toolUseId: string }) =>
  Activity.make({
    name: `tf28b8-tool-activity/${payload.toolUseId}`,
    success: Schema.String,
    error: Schema.Never,
    execute: Effect.sync(() => runToolSideEffect(payload.toolUseId)).pipe(
      Effect.withSpan("firegrid.tf28b8.tool.shape_d.activity", {
        kind: "internal",
        attributes: { "firegrid.tf28b8.tool_use_id": payload.toolUseId },
      }),
    ),
  })

// ── Probe 3 Shape D: scheduled prompt as a DurableClock-parked body ──────────
export const ClockWorkflow = Workflow.make({
  name: "tf28b8-clock-workflow",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: payload => payload.id,
})

const clockWorkflowBody = (_payload: { readonly id: string }) =>
  Effect.gen(function*() {
    yield* DurableClock.sleep({
      name: "tf28b8-clock-wake",
      duration: Duration.millis(400),
      inMemoryThreshold: Duration.zero,
    })
    return "scheduled-prompt-fired"
  }).pipe(
    Effect.withSpan("firegrid.tf28b8.scheduled.shape_d.clock_body", {
      kind: "consumer",
      attributes: { "firegrid.workflow.name": "tf28b8-clock-workflow" },
    }),
  )

// ── Engine generation harness (Shape D arms) ────────────────────────────────
const engineLayerFor = (engineStreamUrl: string) =>
  DurableStreamsWorkflowEngine.layer({ streamUrl: engineStreamUrl })

export const engineStreamUrlFor = (
  env: TinyFiregridHostEnv,
  name: string,
): string =>
  durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.tf28b8.${env.runId}.${name}.engine`,
  )

// Run one engine generation registered with the ToolWorkflow. Scope close ==
// crash; the engine stream URL persists.
export const runToolGeneration = <A>(
  engineStreamUrl: string,
  program: (
    engineTable: WorkflowEngineTableService,
  ) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, unknown> => {
  const generationLayer = ToolWorkflow.toLayer(toolWorkflowBody).pipe(
    Layer.provideMerge(engineLayerFor(engineStreamUrl)),
  )
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      return yield* program(engineTable)
    }).pipe(
      Effect.provide(
        generationLayer as Layer.Layer<
          WorkflowEngine.WorkflowEngine | WorkflowEngineTable,
          unknown,
          never
        >,
      ),
    ),
  ) as Effect.Effect<A, unknown>
}

// ── Clock execution observation (Shape D scheduled-prompt probe) ────────────
export const isSuspended = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
): Effect.Effect<boolean, unknown> =>
  engineTable.executions.get(executionId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.map(exec => exec?.suspended === true),
  )

export const pendingClockWakeups = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
): Effect.Effect<number, unknown> =>
  engineTable.clockWakeups.query(coll =>
    coll.toArray.filter(row =>
      row.executionId === executionId && row.status === "pending"),
  ).pipe(Effect.map(rows => rows.length))

// Bounded wait for an execution row to gain a finalResult, driven off the
// table's live row subscription. The clock wakeup that auto-rearms on
// reconstruction completes the body asynchronously.
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

// Run one engine generation registered with the ClockWorkflow.
export const runClockGeneration = <A>(
  engineStreamUrl: string,
  program: (
    engineTable: WorkflowEngineTableService,
  ) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, unknown> => {
  const generationLayer = ClockWorkflow.toLayer(clockWorkflowBody).pipe(
    Layer.provideMerge(engineLayerFor(engineStreamUrl)),
  )
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      return yield* program(engineTable)
    }).pipe(
      Effect.provide(
        generationLayer as Layer.Layer<
          WorkflowEngine.WorkflowEngine | WorkflowEngineTable,
          unknown,
          never
        >,
      ),
    ),
  ) as Effect.Effect<A, unknown>
}
