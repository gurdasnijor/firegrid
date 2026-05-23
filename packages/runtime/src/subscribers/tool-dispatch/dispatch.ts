/**
 * Runtime-owned facade over `ToolCallWorkflow.execute(...)`.
 *
 * SHAPE: D — Activity memoization (see `./README.md`).
 *
 * This module is the narrow seam host-sdk consumes for MCP-entry tool
 * dispatch. The Tag is the only thing host-sdk imports; the underlying
 * `@effect/workflow` machinery (`WorkflowEngine`, `ToolCallWorkflow`,
 * `Workflow.toLayer`) stays inside this folder — justified by the
 * folder's Shape D rationale (`runtime-design-constraints.md` §SDD Gate;
 * `host-sdk-runtime-boundary.md` Cannon §3).
 *
 * Wave D-B contract (per `2026-05-22-shape-c-cutover-roadmap.md` §Wave D
 * "Tool call and result correlation"):
 *
 *   - `ToolDispatch.call({ contextId, toolUseId, toolName, input })` →
 *     `Effect<ToolResultEvent, ToolDispatchFailure>`
 *   - At-most-once is `Workflow.idempotencyKey: ({ toolUseId }) => toolUseId`
 *     over `WorkflowEngineTable` (#713 GREEN tiny-firegrid finding).
 *   - The handler is registered ONCE per host on the host-scoped
 *     `WorkflowEngine` via `ToolDispatchLive` (no per-call support layer).
 *
 * Replaces the retired per-call kernel-runtime bridge that previously
 * threaded host-sdk through a per-call workflow runtime + per-call
 * handler-install support layer + a vestigial provideRuntimeContext
 * (no consumer in the workflow handler or the executor — verified by
 * trace from `runtime-tool-call-workflow.ts` through
 * `runtime-tool-use-executor.ts`).
 */

import { WorkflowEngine } from "@effect/workflow"
import { Context, Effect, Layer } from "effect"
import type { ToolResultEvent } from "../../events/contract.ts"
import { ScheduledPromptWorkflowLayer } from "../../workflow-engine/workflows/scheduled-prompt.ts"
import { ToolCallWorkflow } from "../../workflow-engine/workflows/tool-call.ts"
import { RuntimeToolCallWorkflowLayer } from "./runtime-tool-call-workflow.ts"

/** Tool-dispatch input. Mirrors `ToolCallWorkflow` payload one-for-one. */
export interface ToolDispatchInput {
  readonly contextId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
}

/**
 * Narrow failure for the facade. Host-sdk maps this to its own MCP-facing
 * failure schema; the runtime side stays decoupled from any host-sdk type.
 */
export interface ToolDispatchFailure {
  readonly _tag: "ToolDispatchFailure"
  readonly toolUseId: string
  readonly toolName: string
  readonly cause: unknown
}

export interface ToolDispatchService {
  readonly call: (
    input: ToolDispatchInput,
  ) => Effect.Effect<ToolResultEvent, ToolDispatchFailure>
}

export class ToolDispatch extends Context.Tag(
  "@firegrid/runtime/subscribers/tool-dispatch/ToolDispatch",
)<ToolDispatch, ToolDispatchService>() {}

/**
 * Host-scope install of the tool-dispatch facade.
 *
 * Composition:
 *
 *   1. Co-installs `RuntimeToolCallWorkflowLayer` + `ScheduledPromptWorkflowLayer`
 *      on the host-scoped `WorkflowEngine` (handler registration is a
 *      `Workflow.toLayer` side effect at build time; handlers outlive any
 *      per-call scope and survive engine reconstruction by design).
 *   2. Provides the `ToolDispatch` Tag. `ToolDispatch.call(...)` closes over
 *      the resolved `WorkflowEngine` and re-provides it into the
 *      `ToolCallWorkflow.execute(...)` effect, so callers can resolve the
 *      Tag from any scope (host-sdk's MCP toolkit handler, for instance)
 *      without re-resolving the engine themselves.
 *
 * Required services left on the R-channel (composer of this Layer wires
 * them — for production that is `FiregridRuntimeHostLive`; for
 * `@effect/vitest` it is whatever test layer the suite assembles):
 *
 *   - `WorkflowEngine.WorkflowEngine` + `WorkflowEngine.WorkflowEngineTable`
 *     — typically built by `DurableStreamsWorkflowEngine.layer({...})` once
 *     per host. This module does NOT care where the engine comes from; it
 *     resolves the Tag like any other Effect service.
 *   - `RuntimeToolUseExecutor` — the runtime-owned validated-executor Tag.
 *   - `Clock` / `DurableClock` / `RuntimeControlPlaneTable` — for the
 *     scheduled-prompt workflow handler.
 */
export const ToolDispatchLive = Layer.merge(
  Layer.merge(RuntimeToolCallWorkflowLayer, ScheduledPromptWorkflowLayer),
  Layer.effect(
    ToolDispatch,
    Effect.gen(function*() {
      const engine = yield* WorkflowEngine.WorkflowEngine
      return ToolDispatch.of({
        call: ({ contextId, toolUseId, toolName, input }) =>
          ToolCallWorkflow.execute({ contextId, toolUseId, toolName, input }).pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            Effect.mapError((cause): ToolDispatchFailure => ({
              _tag: "ToolDispatchFailure",
              toolUseId,
              toolName,
              cause,
            })),
          ),
      })
    }),
  ),
).pipe(
  Layer.withSpan("firegrid.runtime.tool_dispatch.host_install.layer", {
    kind: "internal",
  }),
)
