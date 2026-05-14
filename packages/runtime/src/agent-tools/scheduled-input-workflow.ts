/**
 * `ScheduledInputWorkflow` — fire-and-forget background workflow that
 * powers `schedule_me`.
 *
 * Body: sleep until `dueAtMs`, then append a runtime-input row via the
 * host-provided `AgentToolHost.appendScheduledPrompt`. The agent's
 * *next* turn picks up the input through the normal ingress path.
 *
 * The `schedule_me` arm of `toolUseToEffect` starts this workflow with
 * `discard: true` and returns immediately with `{ scheduled: true,
 * scheduleId }`. The scheduled prompt does not need to wait for this
 * workflow to complete — it is observably already scheduled the moment
 * `Workflow.execute({ discard: true })` returns.
 *
 * Implements:
 *  - agent-codec-runtime-tools.md/agent-tool-layer-phase-2 §"`ScheduledInputWorkflow`"
 *  - firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.2
 *  - firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1
 *    (DurableClock.sleep is the durable suspension primitive)
 */

import { Workflow, DurableClock } from "@effect/workflow"
import { Clock, Duration, Effect, Schema } from "effect"
import { PromptContentSchema } from "../agent-io/index.ts"
import { AgentToolHost } from "./tool-host.ts"
import { ToolExecutionFailedError } from "./tool-error.ts"

export const ScheduledInputWorkflowPayload = Schema.Struct({
  contextId: Schema.String,
  dueAtMs: Schema.Number,
  promptContent: PromptContentSchema,
  inputId: Schema.String,
})
export type ScheduledInputWorkflowPayload = Schema.Schema.Type<
  typeof ScheduledInputWorkflowPayload
>

export const ScheduledInputWorkflow = Workflow.make({
  name: "firegrid.agent-tool.scheduled-input",
  payload: ScheduledInputWorkflowPayload,
  success: Schema.Void,
  error: ToolExecutionFailedError,
  idempotencyKey: ({ inputId }) => inputId,
})

export const ScheduledInputWorkflowLayer = ScheduledInputWorkflow.toLayer(
  ({ contextId, dueAtMs, promptContent, inputId }) =>
    Effect.gen(function* () {
      const host = yield* AgentToolHost
      const now = yield* Clock.currentTimeMillis
      yield* DurableClock.sleep({
        name: "scheduled-input.wait",
        duration: Duration.millis(Math.max(0, dueAtMs - now)),
        inMemoryThreshold: Duration.zero,
      })
      yield* host.appendScheduledPrompt({
        contextId,
        inputId,
        content: promptContent,
      })
    }),
)
