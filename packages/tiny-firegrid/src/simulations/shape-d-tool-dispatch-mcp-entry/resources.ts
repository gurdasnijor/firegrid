// Shape D tool-dispatch MCP-entry sim — stub Shape D primitives.
//
// Models the workflow-machinery surfaces that the SDD type-boundary doc
// pins for Shape D subscribers (`runtime-pipeline-type-boundaries.md`
// §"Shape D"): `Workflow.make({ idempotencyKey })`, `.execute(payload)`,
// `.toLayer(handler)`, and a `WorkflowEngine` service that owns at-most-
// once memoization keyed by `idempotencyKey`. The stubs are deliberately
// minimal — the proof is about the CALL CHAIN SHAPE the host-sdk
// facade needs to invoke them, not about reproducing
// `@effect/workflow`'s implementation.
//
// In particular:
//
//   - The memo is a `Ref` keyed by `idempotencyKey(payload)` returning
//     the workflow's success type. Workflow-engine durability is modeled
//     as "memo survives the `runRestart` boundary; in-memory fiber state
//     does not." This mirrors what `Workflow.make({ idempotencyKey })`
//     gives over `WorkflowEngineTable`.
//
//   - No `RuntimeToolResultTable` / `RuntimeToolResultRow` /
//     `runtimeToolResultAtMostOnce` exists. The at-most-once boundary
//     comes from `Workflow.idempotencyKey` only — that is the C3 result
//     identity for the Shape D MCP-entry tool path. Adding a parallel
//     `tables/runtime-tool-result.ts` would be the #684 anti-pattern.
//
//   - No `RuntimeContextWorkflowRuntime`, `workflowRuntime.run`,
//     `supportLayer`, or `toolCallWorkflowSupportLayer` is needed. The
//     `WorkflowEngine` service + the per-workflow `toLayer(...)`
//     registration is sufficient to call `.execute(...)` from the
//     facade. That absence is the load-bearing falsifier for the
//     YELLOW plan's option (A).

import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect"

// ── Stub Workflow.make / WorkflowEngine ──────────────────────────────────

export interface WorkflowDefinition<
  Payload extends Schema.Schema.AnyNoContext,
  Success extends Schema.Schema.AnyNoContext,
> {
  readonly name: string
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly idempotencyKey: (payload: Schema.Schema.Type<Payload>) => string
}

export const makeWorkflow = <
  Payload extends Schema.Schema.AnyNoContext,
  Success extends Schema.Schema.AnyNoContext,
>(definition: WorkflowDefinition<Payload, Success>): WorkflowDefinition<Payload, Success> =>
  definition

/**
 * Workflow handler — the equivalent of `Workflow.toLayer(...)`. The
 * handler receives the decoded payload and returns the Success value.
 * Its `R` channel is whatever Effect capabilities the handler needs
 * (in production: `RuntimeToolUseExecutor`).
 */
export interface WorkflowHandler<
  Payload extends Schema.Schema.AnyNoContext,
  Success extends Schema.Schema.AnyNoContext,
  R,
> {
  readonly definition: WorkflowDefinition<Payload, Success>
  readonly run: (
    payload: Schema.Schema.Type<Payload>,
  ) => Effect.Effect<Schema.Schema.Type<Success>, unknown, R>
}

export const handleWorkflow = <
  Payload extends Schema.Schema.AnyNoContext,
  Success extends Schema.Schema.AnyNoContext,
  R,
>(
  definition: WorkflowDefinition<Payload, Success>,
  run: (
    payload: Schema.Schema.Type<Payload>,
  ) => Effect.Effect<Schema.Schema.Type<Success>, unknown, R>,
): WorkflowHandler<Payload, Success, R> => ({ definition, run })

// ── WorkflowEngine service ───────────────────────────────────────────────

interface WorkflowEngineService {
  /**
   * Register a workflow handler. Equivalent to `Workflow.toLayer(...)`
   * being installed alongside the engine. Repeated registration is
   * idempotent.
   */
  readonly register: <
    Payload extends Schema.Schema.AnyNoContext,
    Success extends Schema.Schema.AnyNoContext,
  >(
    handler: WorkflowHandler<Payload, Success, never>,
  ) => Effect.Effect<void>
  /**
   * `Workflow.execute(payload)` equivalent. Looks up the handler by
   * workflow name, decodes the payload, checks the memo by
   * idempotencyKey, runs the handler if absent, memoizes the result,
   * and returns the success value. Subsequent executions with the same
   * idempotency key return the memoized success without re-invoking
   * the handler.
   */
  readonly execute: <
    Payload extends Schema.Schema.AnyNoContext,
    Success extends Schema.Schema.AnyNoContext,
  >(
    workflow: WorkflowDefinition<Payload, Success>,
    payload: Schema.Schema.Type<Payload>,
  ) => Effect.Effect<Schema.Schema.Type<Success>, unknown>
  /**
   * Test-only: drop the in-memory handler registry (fiber/process
   * restart), but keep the durable memo. This is the closest we can
   * model in-memory of WorkflowEngineTable's "execution row persists,
   * in-memory handler registration must be re-applied at composition
   * time after restart". Re-call `register(...)` before `execute(...)`
   * after `restart()`.
   */
  readonly restart: Effect.Effect<void>
  /** Test-only instrumentation: how many times each idempotency key was actually executed. */
  readonly invocationCount: (idempotencyKey: string) => Effect.Effect<number>
}

export class WorkflowEngine extends Context.Tag(
  "@tiny/shape-d-tool-dispatch/WorkflowEngine",
)<WorkflowEngine, WorkflowEngineService>() {}

interface MemoEntry {
  readonly workflowName: string
  readonly idempotencyKey: string
  readonly success: unknown
}

const makeWorkflowEngineService: Effect.Effect<WorkflowEngineService> = Effect.gen(function*() {
  // Durable memo — survives `restart`.
  const memo = yield* Ref.make<ReadonlyMap<string, MemoEntry>>(new Map())
  // In-memory handler registry — dropped on `restart`.
  const handlers = yield* Ref.make<ReadonlyMap<string, WorkflowHandler<Schema.Schema.AnyNoContext, Schema.Schema.AnyNoContext, never>>>(
    new Map(),
  )
  // Instrumentation.
  const invocations = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

  const memoKey = (workflowName: string, idempotencyKey: string): string =>
    `${workflowName}:${idempotencyKey}`

  const bumpInvocation = (key: string): Effect.Effect<void> =>
    Ref.update(invocations, (m) => {
      const next = new Map(m)
      next.set(key, (next.get(key) ?? 0) + 1)
      return next
    })

  return {
    register: (handler) =>
      Ref.update(handlers, (m) => {
        const next = new Map(m)
        next.set(handler.definition.name, handler)
        return next
      }),
    execute: (workflow, payload) =>
      Effect.gen(function*() {
        const key = workflow.idempotencyKey(payload)
        const mk = memoKey(workflow.name, key)
        const existing = (yield* Ref.get(memo)).get(mk)
        if (existing !== undefined) {
          // First-valid-terminal-wins: return memoized success without
          // re-invoking the handler. This is the C3 at-most-once
          // boundary the YELLOW plan needs to validate.
          return existing.success as Schema.Schema.Type<typeof workflow.successSchema>
        }
        const handler = (yield* Ref.get(handlers)).get(workflow.name)
        if (handler === undefined) {
          return yield* Effect.failCause(Cause.die(
            new Error(`WorkflowEngine: no handler registered for ${workflow.name}`),
          ))
        }
        yield* bumpInvocation(key)
        const success = yield* (handler.run(payload) as Effect.Effect<unknown, unknown, never>)
        yield* Ref.update(memo, (m) => {
          const next = new Map(m)
          next.set(mk, { workflowName: workflow.name, idempotencyKey: key, success })
          return next
        })
        return success as Schema.Schema.Type<typeof workflow.successSchema>
      }),
    restart: Ref.set(handlers, new Map()),
    invocationCount: (idempotencyKey) =>
      Effect.map(Ref.get(invocations), (m) => m.get(idempotencyKey) ?? 0),
  }
})

export const WorkflowEngineLive: Layer.Layer<WorkflowEngine> =
  Layer.effect(WorkflowEngine, makeWorkflowEngineService)

// ── ToolCallWorkflow + RuntimeToolUseExecutor (production-mirrored stubs) ──

export const ToolCallPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  input: Schema.String,
})
export type ToolCallPayload = Schema.Schema.Type<typeof ToolCallPayloadSchema>

export const ToolResultSchema = Schema.Struct({
  toolUseId: Schema.String,
  output: Schema.String,
})
export type ToolResult = Schema.Schema.Type<typeof ToolResultSchema>

/**
 * Mirror of production `ToolCallWorkflow = Workflow.make({ ... ,
 * idempotencyKey: ({ toolUseId }) => toolUseId })`. The `toolUseId` IS
 * the C3 durable result identity for the MCP-entry tool path; no
 * additional `RuntimeToolResultTable` is required.
 */
export const ToolCallWorkflow = makeWorkflow({
  name: "firegrid.agent-tool-call",
  payloadSchema: ToolCallPayloadSchema,
  successSchema: ToolResultSchema,
  idempotencyKey: ({ toolUseId }) => toolUseId,
})

interface RuntimeToolUseExecutorService {
  readonly execute: (input: ToolCallPayload) => Effect.Effect<ToolResult, unknown>
  readonly invocations: Effect.Effect<number>
}

export class RuntimeToolUseExecutor extends Context.Tag(
  "@tiny/shape-d-tool-dispatch/RuntimeToolUseExecutor",
)<RuntimeToolUseExecutor, RuntimeToolUseExecutorService>() {}

/**
 * Default echo executor; supports a failing variant for negative paths.
 */
export const makeRuntimeToolUseExecutor = (
  options?: {
    readonly failFor?: (input: ToolCallPayload) => Option.Option<unknown>
  },
): Effect.Effect<RuntimeToolUseExecutorService> =>
  Effect.gen(function*() {
    const invocations = yield* Ref.make(0)
    return {
      execute: (input) =>
        Effect.gen(function*() {
          yield* Ref.update(invocations, (n) => n + 1)
          if (options?.failFor !== undefined) {
            const failure = options.failFor(input)
            if (Option.isSome(failure)) {
              return yield* Effect.fail(failure.value)
            }
          }
          return {
            toolUseId: input.toolUseId,
            output: `${input.toolName}:${input.input}`,
          }
        }),
      invocations: Ref.get(invocations),
    }
  })

export const RuntimeToolUseExecutorLive = (
  options?: Parameters<typeof makeRuntimeToolUseExecutor>[0],
): Layer.Layer<RuntimeToolUseExecutor> =>
  Layer.effect(
    RuntimeToolUseExecutor,
    options === undefined
      ? makeRuntimeToolUseExecutor()
      : makeRuntimeToolUseExecutor(options),
  )
