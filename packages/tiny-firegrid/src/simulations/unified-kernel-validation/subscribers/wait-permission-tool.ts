/**
 * P3 subscribers — three workflow bodies on the same kernel primitive,
 * proving the unified shape generalizes beyond RuntimeContext.
 *
 * 1. `WaitForFactWorkflow` — generic wait_for. Parks on a fact row by
 *    domain identity; kernel-write+arm wakes on arrival; predicate-match
 *    or timeout via `DurableClock.sleep` (the one allowed Shape D
 *    parked body).
 * 2. `PermissionRoundtripWorkflow` — observes a `permission-request` fact,
 *    waits for the paired `permission-response` input, returns the
 *    decision. Pure workflow body — no Shape C handler, no
 *    `eventAlreadyProcessed` gate.
 * 3. `ToolDispatchWorkflow` — MCP-entry tool path. Body executes the
 *    tool via `Activity.make` (memoized). `idempotencyKey: ({toolUseId})`
 *    so retry returns the same result without re-invoking the executor
 *    — at-most-once via WorkflowEngineTable, no separate
 *    runtime-tool-result table.
 *
 * All three reuse the kernel's `Workflow.suspend` + write+arm pattern.
 * None use `DurableDeferred.await` (the bridge debt being retired).
 */

import {
  Activity,
  DurableClock,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Duration, Effect, Option, Ref, Schema } from "effect"
import { UnifiedTable, permissionKey, toolKey } from "../tables.ts"

// ── 1. WaitForFactWorkflow ──────────────────────────────────────────────────

export const WaitForFactPayloadSchema = Schema.Struct({
  /** Channel target name the caller is observing (opaque to the workflow). */
  channelTarget: Schema.String,
  /**
   * Fact-identifier the body point-reads. The host computes this from
   * the (channelTarget, whereFields) and supplies it as the lookup key.
   */
  factKey: Schema.String,
  /**
   * Table the fact lives in. The workflow's R-channel reads from
   * UnifiedTable; per-fact-kind dispatch via this discriminator.
   */
  factTable: Schema.Literal("permissions", "toolResults", "peerEvents", "webhookFacts"),
  /** Caller-supplied timeout. */
  timeoutMs: Schema.Number,
  /** Unique key per wait invocation (one execution per logical wait). */
  waitId: Schema.String,
})
export type WaitForFactPayload = Schema.Schema.Type<typeof WaitForFactPayloadSchema>

export const WaitForFactResultSchema = Schema.Struct({
  matched: Schema.Boolean,
  factKey: Schema.optional(Schema.String),
  timedOut: Schema.Boolean,
})

export const WaitForFactWorkflow = Workflow.make({
  name: "unified.wait-for-fact",
  payload: WaitForFactPayloadSchema,
  success: WaitForFactResultSchema,
  idempotencyKey: (p) => p.waitId,
})

const waitForFactBody = (payload: WaitForFactPayload) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const table = yield* UnifiedTable
    // The bounded race: row arrival vs DurableClock timeout. Production
    // wait-for can use `DurableDeferred.raceAll([matchActivity,
    // DurableClock.sleep])` (the inv2-waitforworkflow shape) once the
    // engine combinator is available without a parked-body mailbox.
    //
    // For the simulation: single fixed-name DurableClock sleep for the
    // full timeout window, then check once. The kernel `kernelWriteArm`
    // path lets the caller wake the body early by writing the fact AND
    // resuming the execution (DurableClock.sleep returns early if
    // resume is called externally — that's the substrate's read-side
    // effect of `engine.resume`).
    const row1 = yield* pointReadFact(table, payload.factTable, payload.factKey)
    if (Option.isSome(row1)) {
      return {
        matched: true,
        factKey: payload.factKey,
        timedOut: false,
      }
    }
    yield* DurableClock.sleep({
      name: `unified.wait_for/${payload.waitId}`,
      duration: Duration.millis(payload.timeoutMs),
      inMemoryThreshold: Duration.zero,
    })
    const row2 = yield* pointReadFact(table, payload.factTable, payload.factKey)
    if (Option.isSome(row2)) {
      return {
        matched: true,
        factKey: payload.factKey,
        timedOut: false,
      }
    }
    void instance
    return { matched: false, timedOut: true }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof WaitForFactResultSchema>,
    never,
    WorkflowEngine.WorkflowInstance | UnifiedTable
  >

const pointReadFact = (
  table: UnifiedTable["Type"],
  factTable: WaitForFactPayload["factTable"],
  key: string,
): Effect.Effect<Option.Option<unknown>, never> => {
  switch (factTable) {
    case "permissions":
      return table.permissions.get(key).pipe(Effect.map(asUnknownOpt), Effect.orDie)
    case "toolResults":
      return table.toolResults.get(key).pipe(Effect.map(asUnknownOpt), Effect.orDie)
    case "peerEvents":
      return table.peerEvents.get(key).pipe(Effect.map(asUnknownOpt), Effect.orDie)
    case "webhookFacts":
      return table.webhookFacts.get(key).pipe(Effect.map(asUnknownOpt), Effect.orDie)
  }
}

const asUnknownOpt = <A>(opt: Option.Option<A>): Option.Option<unknown> =>
  opt as Option.Option<unknown>

export const buildWaitForFactLayer = () => WaitForFactWorkflow.toLayer(waitForFactBody)

// ── 2. PermissionRoundtripWorkflow ──────────────────────────────────────────

export const PermissionRoundtripPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
})
export type PermissionRoundtripPayload = Schema.Schema.Type<typeof PermissionRoundtripPayloadSchema>

export const PermissionRoundtripResultSchema = Schema.Struct({
  permissionRequestId: Schema.String,
  decision: Schema.Literal("allow", "deny", "cancelled"),
})

export const PermissionRoundtripWorkflow = Workflow.make({
  name: "unified.permission-roundtrip",
  payload: PermissionRoundtripPayloadSchema,
  success: PermissionRoundtripResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.permissionRequestId}`,
})

const permissionRoundtripBody = (payload: PermissionRoundtripPayload) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const table = yield* UnifiedTable
    const key = permissionKey(payload.contextId, payload.permissionRequestId)

    // Activity-memoized: record the request row (idempotent).
    yield* Activity.make({
      name: `unified.permission.request/${key}`,
      success: Schema.Void,
      execute: table.permissions.insertOrGet({
        permissionKey: key,
        contextId: payload.contextId,
        permissionRequestId: payload.permissionRequestId,
        toolUseId: payload.toolUseId,
        status: "pending",
        requestedAt: new Date().toISOString(),
      }).pipe(Effect.orDie, Effect.asVoid),
    })

    // Suspend loop: read the row; if status="responded" return the
    // decision; else suspend. Kernel write+arm wakes us when the
    // host updates the row to "responded".
    while (true) {
      const row = yield* table.permissions.get(key).pipe(Effect.orDie)
      if (Option.isSome(row) && row.value.status === "responded") {
        const decisionJson = row.value.decisionJson ?? "\"deny\""
        const decision = JSON.parse(decisionJson) as "allow" | "deny" | "cancelled"
        return {
          permissionRequestId: payload.permissionRequestId,
          decision,
        }
      }
      yield* Workflow.suspend(instance)
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof PermissionRoundtripResultSchema>,
    never,
    WorkflowEngine.WorkflowInstance | UnifiedTable
  >

export const buildPermissionRoundtripLayer = () =>
  PermissionRoundtripWorkflow.toLayer(permissionRoundtripBody)

// ── 3. ToolDispatchWorkflow ─────────────────────────────────────────────────

export const ToolDispatchPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  /** JSON-encoded tool input. The executor decodes per-tool. */
  inputJson: Schema.String,
})
export type ToolDispatchPayload = Schema.Schema.Type<typeof ToolDispatchPayloadSchema>

export const ToolDispatchResultSchema = Schema.Struct({
  toolUseId: Schema.String,
  resultJson: Schema.String,
})

export const ToolDispatchWorkflow = Workflow.make({
  name: "unified.tool-dispatch",
  payload: ToolDispatchPayloadSchema,
  success: ToolDispatchResultSchema,
  /**
   * At-most-once via WorkflowEngineTable: same toolUseId across
   * retries / reconstruction returns the same result without
   * re-invoking the executor. This is the shape-d-tool-dispatch-mcp-entry
   * finding: NO separate tables/runtime-tool-result.ts primitive needed.
   */
  idempotencyKey: (p) => p.toolUseId,
})

export interface ToolExecutorState {
  /** Increments on each genuine executor invocation. Asserted == 1. */
  readonly invocationCount: Ref.Ref<number>
}

export interface ToolExecutor {
  readonly state: ToolExecutorState
  readonly execute: (
    payload: ToolDispatchPayload,
  ) => Effect.Effect<string>
}

export const makeToolExecutor = (
  resultFn: (payload: ToolDispatchPayload) => string,
): Effect.Effect<ToolExecutor> =>
  Effect.gen(function*() {
    const invocationCount = yield* Ref.make(0)
    return {
      state: { invocationCount },
      execute: (payload) =>
        Effect.gen(function*() {
          yield* Ref.update(invocationCount, (n) => n + 1)
          return resultFn(payload)
        }),
    }
  })

const toolDispatchBody = (executor: ToolExecutor) =>
  (payload: ToolDispatchPayload) =>
    Effect.gen(function*() {
      const table = yield* UnifiedTable
      const key = toolKey(payload.contextId, payload.toolUseId)
      // Activity-memoized: first successful invocation persists; replays
      // see the existing activity row and return its result without
      // re-invoking the executor.
      const resultJson = yield* Activity.make({
        name: `unified.tool.execute/${key}`,
        success: Schema.String,
        execute: executor.execute(payload),
      })
      yield* table.toolResults.insertOrGet({
        toolKey: key,
        contextId: payload.contextId,
        toolUseId: payload.toolUseId,
        toolName: payload.toolName,
        resultJson,
        invocationCount: 1,
        recordedAt: new Date().toISOString(),
      }).pipe(Effect.orDie)
      return { toolUseId: payload.toolUseId, resultJson }
    }) as Effect.Effect<
      Schema.Schema.Type<typeof ToolDispatchResultSchema>,
      never,
      UnifiedTable
    >

export const buildToolDispatchLayer = (executor: ToolExecutor) =>
  ToolDispatchWorkflow.toLayer(toolDispatchBody(executor))
