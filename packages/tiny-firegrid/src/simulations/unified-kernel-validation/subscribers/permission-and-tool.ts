/**
 * Permission roundtrip + tool dispatch — two specialized workflow
 * bodies on the kernel primitive.
 *
 * Each subscriber is specialized to its concern. There is deliberately
 * NO generic "wait_for any fact" workflow — string-dispatch over a
 * fact-table name reconstructs the retired SourceCollections /
 * RuntimeObservationSourceNames registry pattern.
 *
 * State minimalism: neither body keeps a parallel result table. The
 * engine activity table memoizes activity returns; the engine
 * execution table records each body's final result. The `permissions`
 * row holds only what the UI needs to render an open request — no
 * lifecycle status flag, no responder fields.
 */

import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Effect, Ref, Schema } from "effect"
import { KernelCommandTable, readCommandsFor } from "../kernel.ts"
import { UnifiedTable, permissionKey } from "../tables.ts"

// ── PermissionRoundtripWorkflow ─────────────────────────────────────────────

export const PermissionRoundtripPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
})
export type PermissionRoundtripPayload = Schema.Schema.Type<typeof PermissionRoundtripPayloadSchema>

export const PermissionDecisionSchema = Schema.Literal("allow", "deny", "cancelled")
export type PermissionDecision = Schema.Schema.Type<typeof PermissionDecisionSchema>

export const PermissionRoundtripResultSchema = Schema.Struct({
  permissionRequestId: Schema.String,
  decision: PermissionDecisionSchema,
})

export const PermissionRoundtripWorkflow = Workflow.make({
  name: "unified.permission-roundtrip",
  payload: PermissionRoundtripPayloadSchema,
  success: PermissionRoundtripResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.permissionRequestId}`,
})

export const PERMISSION_DECISION_TABLE = "permission-decision"

/** Payload shape the responder delivers via kernelWriteArm. */
export const PermissionDecisionPayloadSchema = Schema.Struct({
  decision: PermissionDecisionSchema,
})
export type PermissionDecisionPayload = Schema.Schema.Type<typeof PermissionDecisionPayloadSchema>

const permissionRoundtripBody = (
  payload: PermissionRoundtripPayload,
  executionId: string,
) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const kernel = yield* KernelCommandTable
    const table = yield* UnifiedTable
    const key = permissionKey(payload.contextId, payload.permissionRequestId)

    // Activity-memoized: record the open request row so the host UI
    // can render the pending decision. The row holds no lifecycle
    // status — the decision flows via the kernel command payload.
    yield* Activity.make({
      name: `unified.permission.request/${key}`,
      success: Schema.Void,
      execute: table.permissions.insertOrGet({
        permissionKey: key,
        contextId: payload.contextId,
        permissionRequestId: payload.permissionRequestId,
        toolUseId: payload.toolUseId,
        requestedAt: new Date().toISOString(),
      }).pipe(Effect.orDie, Effect.asVoid),
    })

    // Park until the responder delivers a decision via kernelWriteArm.
    // On wake, the kernel command's inputValueJson holds the payload.
    while (true) {
      const commands = yield* readCommandsFor(kernel, executionId).pipe(Effect.orDie)
      if (commands.length > 0) {
        const decisionPayload = JSON.parse(commands[0]!.inputValueJson) as PermissionDecisionPayload
        return {
          permissionRequestId: payload.permissionRequestId,
          decision: decisionPayload.decision,
        }
      }
      yield* Workflow.suspend(instance)
      return yield* Effect.never
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof PermissionRoundtripResultSchema>,
    never,
    WorkflowEngine.WorkflowInstance | KernelCommandTable | UnifiedTable
  >

export const buildPermissionRoundtripLayer = () =>
  PermissionRoundtripWorkflow.toLayer(permissionRoundtripBody)

// ── ToolDispatchWorkflow ────────────────────────────────────────────────────
//
// At-most-once via `Workflow.idempotencyKey` (one execution per toolUseId)
// + `Activity.make` memoization (one executor invocation per execution).
// No `toolResults` table — the engine activity record IS the durable
// result, and the workflow execution's `finalResult` is the durable
// return value.

export const ToolDispatchPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
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
      const resultJson = yield* Activity.make({
        name: `unified.tool.execute/${payload.toolUseId}`,
        success: Schema.String,
        execute: executor.execute(payload),
      })
      return { toolUseId: payload.toolUseId, resultJson }
    }) as Effect.Effect<
      Schema.Schema.Type<typeof ToolDispatchResultSchema>,
      never,
      never
    >

export const buildToolDispatchLayer = (executor: ToolExecutor) =>
  ToolDispatchWorkflow.toLayer(toolDispatchBody(executor))
