import { Prompt } from "@effect/ai"
import {
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeInputIntentRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect } from "effect"

// tf-5ose: authority-owned append for the durable scheduled-prompt timer
// (ScheduledPromptWorkflow). Lives under authorities/ so the
// RuntimeControlPlaneTable access stays in an authority-composition file rather
// than a workflow body (firegrid-runtime-no-table-service-yield-outside-providers).
// Idempotent on the intent key (`scheduleId`), so a replay/restart of the firing
// workflow appends the self-prompt exactly once.
interface ScheduledPromptAppendParams {
  readonly contextId: string
  readonly scheduleId: string
  readonly prompt: string
}

const scheduledPromptIngressRequest = (
  params: ScheduledPromptAppendParams,
): RuntimeIngressRequest => ({
  contextId: params.contextId,
  inputId: params.scheduleId,
  kind: "message",
  authoredBy: "workflow",
  payload: Prompt.userMessage({ content: [Prompt.textPart({ text: params.prompt })] }),
  idempotencyKey: params.scheduleId,
})

export const appendScheduledPromptIntent = (
  params: ScheduledPromptAppendParams,
): Effect.Effect<void, unknown, RuntimeControlPlaneTable> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable.layer leaks `any` through the table service R; RuntimeControlPlaneTable is the intended capability boundary.
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const intent = makeRuntimeInputIntentRow(scheduledPromptIngressRequest(params))
    yield* control.inputIntents.insertOrGet(intent)
  })
