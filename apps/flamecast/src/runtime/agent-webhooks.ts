import { Activity, Workflow } from "@effect/workflow"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/durable-streams"
import { Context, Effect, Schema } from "effect"
import {
  pendingAgentsWebhooks,
  type FlamecastDb,
} from "../shared/db.ts"
import { FlamecastAgentsWebhook } from "../shared/state.ts"

const FlamecastDbService = Context.GenericTag<FlamecastDb>(
  "flamecast/FlamecastDb",
)

const CurrentAgentsWebhook = Context.GenericTag<FlamecastAgentsWebhook>(
  "flamecast/CurrentAgentsWebhook",
)

const FlamecastAgentsWebhookWorkflow = Workflow.make({
  name: "flamecast-agents-webhook",
  payload: FlamecastAgentsWebhook,
  success: Schema.Void,
  error: Schema.Unknown,
  idempotencyKey: (webhook) => webhook.webhookId,
})

const CompleteFlamecastAgentsWebhook = Activity.make({
  name: "complete-flamecast-agents-webhook",
  success: Schema.Void,
  error: Schema.Unknown,
  execute: Effect.gen(function* () {
    // stream-webhook-workflows.WORKFLOW_PROCESSING.2
    const db = yield* FlamecastDbService
    const webhook = yield* CurrentAgentsWebhook
    yield* Effect.tryPromise({
      try: () => db.actions.completeAgentsWebhook({ webhook }).isPersisted.promise,
      catch: (cause) => cause,
    })
  }),
})

const FlamecastAgentsWebhookWorkflowLayer =
  FlamecastAgentsWebhookWorkflow.toLayer((webhook) =>
    CompleteFlamecastAgentsWebhook.pipe(
      Effect.provideService(CurrentAgentsWebhook, webhook),
    ),
  )

export const processAcceptedAgentsWebhooks = (
  streamUrl: string,
  db: FlamecastDb,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    // stream-webhook-workflows.WORKFLOW_PROCESSING.1
    yield* Effect.tryPromise({
      try: () => db.preload(),
      catch: (cause) => cause,
    })
    for (const webhook of pendingAgentsWebhooks(db)) {
      yield* FlamecastAgentsWebhookWorkflow.execute(webhook).pipe(
        Effect.provide(FlamecastAgentsWebhookWorkflowLayer),
        Effect.provideService(FlamecastDbService, db),
        Effect.provide(DurableStreamsWorkflowEngine.layer({ streamUrl })),
        Effect.scoped,
      )
    }
  })
