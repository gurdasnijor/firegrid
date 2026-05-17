import { Effect, Layer } from "effect"
import {
  RuntimeControlPlaneRecorderLive,
} from "../authorities/index.ts"
import {
  type DurableWaitCompletionRowLookup,
  type DurableWaitCompletionRowUpsert,
  type DurableWaitRowLookup,
  type DurableWaitRowUpsert,
} from "../durable-tools/index.ts"
import {
  RuntimeIngressDeliveryTrackerLayer,
} from "../agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts"
import {
  RuntimeIngressInputStreamLayer,
} from "../agent-event-pipeline/authorities/runtime-ingress-appender.ts"
import {
  RuntimeOutputJournalLayer,
} from "../agent-event-pipeline/authorities/runtime-output-journal.ts"
import { RuntimeToolUseExecutor } from "../agent-event-pipeline/subscribers/runtime-tool-use-executor.ts"
import {
  toolUseToEffect,
} from "../agent-tools/tool-use-to-effect.ts"
import { ScheduledInputWorkflowLayer } from "../agent-tools/scheduled-input-workflow.ts"
import { type AgentToolHost } from "../agent-tools/tool-host.ts"
import { HostOwnedDurableToolsWaitForLive } from "./host-owned-durable-tools.ts"

type RuntimeToolUseExecutorHostEnvironment =
  | DurableWaitRowLookup
  | DurableWaitRowUpsert
  | DurableWaitCompletionRowLookup
  | DurableWaitCompletionRowUpsert
  | AgentToolHost

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.2
// firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
// firegrid-typed-wait-source-redesign.REJECTION.2
// Shared host runtime observation substrate used by both host-scoped
// composition and codec-path tool lowering. The durable-tools wait router
// consumes the typed observation tags directly; there is no source-name
// registration layer.
export const HostRuntimeObservationSubstrateLive = HostOwnedDurableToolsWaitForLive.pipe(
  Layer.provideMerge(Layer.mergeAll(
    RuntimeOutputJournalLayer,
    RuntimeControlPlaneRecorderLive,
    RuntimeIngressInputStreamLayer,
    RuntimeIngressDeliveryTrackerLayer,
  )),
)

// firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2
// Temporary runtime-host live layer. The future host-sdk layer can provide the
// same runtime-owned tag after the agent-tool bindings move out of runtime.
export const RuntimeToolUseExecutorLive = Layer.effect(
  RuntimeToolUseExecutor,
  Effect.gen(function* () {
    const captured = yield* Effect.context<RuntimeToolUseExecutorHostEnvironment>()
    return RuntimeToolUseExecutor.of({
      execute: (context, event) =>
        toolUseToEffect(context, event).pipe(
          Effect.provide(ScheduledInputWorkflowLayer),
          Effect.provide(captured),
        ),
    })
  }),
)
