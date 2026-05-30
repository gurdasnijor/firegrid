/**
 * Permission roundtrip + tool dispatch — two specialized workflow
 * bodies on the kernel primitive.
 *
 * Each subscriber is specialized to its concern. There is deliberately
 * NO generic "wait_for any fact" workflow in the simulation:
 *
 *   - String-dispatch over a fact-table name reconstructs the retired
 *     `SourceCollections` / `RuntimeObservationSourceNames` registry
 *     pattern, which the channel-target-indirection finding (lift #7
 *     in the audit) explicitly retired.
 *   - The unified model says "every subscriber is a workflow body that
 *     parks on the SPECIFIC fact it cares about." Each waiter knows
 *     its fact family, its predicate, and its idempotency key.
 *
 * Other specialized observers in the simulation:
 *
 *   - `subscribers/scheduled-webhook-peer.ts` →
 *     `WebhookFactObserverWorkflow` (waits on `webhookFacts`),
 *     `PeerEventObserverWorkflow` (waits on `peerEvents`).
 *   - `subscribers/runtime-context.ts` →
 *     `RuntimeContextSessionWorkflow` (waits on `inputs` cursor).
 */

import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Effect, Option, Ref, Schema } from "effect"
import { UnifiedTable, permissionKey, toolKey } from "../tables.ts"

// ── PermissionRoundtripWorkflow ─────────────────────────────────────────────

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

// ── ToolDispatchWorkflow ────────────────────────────────────────────────────

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
