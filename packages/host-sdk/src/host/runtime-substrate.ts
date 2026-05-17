import { Effect, Layer, Option, Stream } from "effect"
import { CurrentHostSession } from "@firegrid/protocol/launch"
import {
  RuntimeControlPlaneRecorderLive,
} from "@firegrid/runtime/host-substrate"
import {
  type DurableWaitCompletionRowLookup,
  type DurableWaitCompletionRowUpsert,
  type DurableWaitRowLookup,
  type DurableWaitRowUpsert,
} from "@firegrid/runtime/durable-tools"
import {
  RuntimeIngressDeliveryTrackerLayer,
} from "@firegrid/runtime/host-substrate"
import {
  RuntimeIngressInputStreamLayer,
} from "@firegrid/runtime/host-substrate"
import {
  RuntimeOutputJournalLayer,
  RuntimeAgentOutputAfterEvents,
} from "@firegrid/runtime/host-substrate"
import { RuntimeToolUseExecutor } from "@firegrid/runtime/host-substrate"
import {
  toolUseToEffect,
} from "../agent-tools/execution/tool-use-to-effect.ts"
import { ScheduledInputWorkflowLayer } from "../agent-tools/execution/scheduled-input-workflow.ts"
import { type AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import { HostOwnedDurableToolsWaitForLive } from "./host-owned-durable-tools.ts"
import { RuntimeHostConfig } from "./config.ts"
import {
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
} from "@firegrid/protocol/launch"
import { runtimeAgentOutputObservationFromRow } from "@firegrid/runtime/events"

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
    Layer.effect(
      RuntimeAgentOutputAfterEvents,
      Effect.gen(function*() {
        const hostConfig = yield* RuntimeHostConfig
        const hostSession = yield* CurrentHostSession
        return RuntimeAgentOutputAfterEvents.of({
          after: source => Stream.unwrapScoped(
            Effect.map(
              RuntimeOutputTable,
              table => table.events.rows().pipe(
                Stream.filterMap(runtimeAgentOutputObservationFromRow),
                Stream.filter((row) =>
                  row.contextId === source.contextId &&
                  row.activityAttempt === source.activityAttempt &&
                  row.sequence > source.afterSequence),
              ),
            ).pipe(
              Effect.provide(RuntimeOutputTable.layer({
              streamOptions: {
                url: runtimeContextOutputStreamUrl({
                  baseUrl: hostConfig.durableStreamsBaseUrl,
                  prefix: hostSession.streamPrefix,
                  contextId: source.contextId,
                }),
                contentType: "application/json",
                ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
              },
              })),
            ),
          ),
          initial: source =>
            Effect.map(
              RuntimeOutputTable,
              table => table.events.query((coll) =>
                coll.toArray
                  .map(runtimeAgentOutputObservationFromRow)
                  .flatMap(Option.match({
                    onNone: () => [],
                    onSome: row => [row],
                  }))
                  .filter((row) =>
                    row.contextId === source.contextId &&
                    row.activityAttempt === source.activityAttempt &&
                    row.sequence > source.afterSequence)
                  .sort((left, right) => left.sequence - right.sequence)[0]).pipe(
                Effect.map(Option.fromNullable),
              ),
            ).pipe(
              Effect.flatten,
              Effect.provide(RuntimeOutputTable.layer({
                streamOptions: {
                  url: runtimeContextOutputStreamUrl({
                    baseUrl: hostConfig.durableStreamsBaseUrl,
                    prefix: hostSession.streamPrefix,
                    contextId: source.contextId,
                  }),
                  contentType: "application/json",
                  ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
                },
              })),
            ),
        })
      }),
    ),
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
