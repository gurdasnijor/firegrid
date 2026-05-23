import { DurableClock, Workflow } from "@effect/workflow"
import { Clock, Duration, Effect, Schema } from "effect"
import {
  appendScheduledPromptIntent,
} from "../../producers/ingress-writers/scheduled-prompt-append.ts"

// tf-5ose: replay-safe, non-blocking durable scheduler for `schedule_me`.
//
// `schedule_me` must return `{scheduled:true}` immediately while a future prompt
// is delivered later. The previous lowering awaited `DurableClock.sleep + append`
// inline in the tool-call workflow (runtime-agent-tool-execution.ts), so the tool
// — and the agent's whole turn — was held open until the scheduled time; any
// `when` beyond the ACP turn timeout timed the edge out (tf-uoga / #632).
//
// This workflow is the **owned durable-timer resource** for a scheduled prompt:
// one execution per `scheduleId` (idempotencyKey), it durably sleeps until `when`
// and then appends the prompt as a runtime input intent exactly once
// (`insertOrGet` is idempotent on the intent key). It is started fire-and-forget
// (`execute(..., { discard: true })`) so the calling tool returns immediately; a
// replay/restart re-runs the body but DurableClock persists the deadline and the
// intent insert dedups, so the prompt fires exactly once. NOT a forkDaemon /
// host-scope sleep (those re-fire on replay / are non-durable). Deliberately
// scoped to the current runtime: it appends through the existing
// RuntimeControlPlaneTable input-intent seam, NOT the Phase-0C cursor cutover.

const ScheduledPromptWorkflowPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  scheduleId: Schema.String,
  // Absolute wall-clock ms (the agent-supplied `when`).
  when: Schema.Number,
  prompt: Schema.String,
})

const scheduledPromptWorkflowExecutionId = (scheduleId: string): string =>
  `scheduled-prompt:${scheduleId}`

export const ScheduledPromptWorkflow = Workflow.make({
  name: "firegrid.agent_tools.schedule_me",
  payload: ScheduledPromptWorkflowPayloadSchema,
  success: Schema.Void,
  error: Schema.Never,
  idempotencyKey: ({ scheduleId }) => scheduledPromptWorkflowExecutionId(scheduleId),
})

export const ScheduledPromptWorkflowLayer = ScheduledPromptWorkflow.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      // DurableClock persists the deadline keyed by scheduleId, so the
      // recomputed duration on replay is harmless (the first deadline wins).
      yield* DurableClock.sleep({
        name: scheduledPromptWorkflowExecutionId(payload.scheduleId),
        duration: Duration.millis(Math.max(0, payload.when - now)),
        inMemoryThreshold: Duration.zero,
      })
      // Append the self-prompt exactly once (idempotent on scheduleId). Table
      // access lives in control-plane/, not this workflow body.
      yield* appendScheduledPromptIntent({
        contextId: payload.contextId,
        scheduleId: payload.scheduleId,
        prompt: payload.prompt,
      })
    }).pipe(
      Effect.orDie,
      Effect.withSpan("firegrid.agent_tools.schedule_me.workflow.fire", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": payload.contextId,
          "firegrid.agent_tools.schedule_id": payload.scheduleId,
        },
      }),
    ),
)
