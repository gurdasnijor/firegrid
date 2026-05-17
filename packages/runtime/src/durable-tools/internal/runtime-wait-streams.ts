/**
 * Router-private bundle of the concrete runtime observation streams a typed
 * wait source can select.
 *
 * Implements:
 *  - firegrid-typed-wait-source-redesign.TYPED_SOURCES.2 — the router consumes
 *    concrete Stream capability tags through the Effect requirement channel
 *  - firegrid-typed-wait-source-redesign.WAIT_ROUTER.1 — no public service;
 *    a Layer-provided input to WaitRouterLive
 *  - firegrid-typed-wait-source-redesign.DESIGN.1/.2 — stock Effect surfaces
 *    only (Context.Tag + Layer + Stream); no source-registry wrapper family
 */

import { type RuntimeRunEventRow } from "@firegrid/protocol/launch"
import { type RuntimeIngressInputRow } from "@firegrid/protocol/runtime-ingress"
import type { DurableTableError } from "effect-durable-operators"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { RuntimeIngressInputStream } from "./runtime-ingress-input-stream.ts"
import {
  RuntimeAgentOutputAfterEvents,
  RuntimeAgentOutputEvents,
  type RuntimeAgentOutputObservation,
} from "../../agent-event-pipeline/authorities/runtime-output-journal.ts"
import { RuntimeRuns } from "../../authorities/runtime-control-plane-recorder.ts"
import type { RuntimeWaitSource } from "./types.ts"

interface RuntimeWaitStreamsService {
  readonly agentOutput: Stream.Stream<
    RuntimeAgentOutputObservation,
    DurableTableError
  >
  readonly agentOutputAfter: (
    source: Extract<RuntimeWaitSource, { readonly _tag: "AgentOutputAfter" }>,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly initialAgentOutputAfter: (
    source: Extract<RuntimeWaitSource, { readonly _tag: "AgentOutputAfter" }>,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>
  readonly runtimeRun: Stream.Stream<RuntimeRunEventRow, unknown>
  readonly runtimeIngressInput: Stream.Stream<RuntimeIngressInputRow, unknown>
}

export class RuntimeWaitStreams extends Context.Tag(
  "@firegrid/runtime/RuntimeWaitStreams",
)<RuntimeWaitStreams, RuntimeWaitStreamsService>() {}

/**
 * Built from the typed runtime observation tags. Adding a typed source is
 * localized: add one `RuntimeWaitSource` variant, one field here, and one
 * `Match.tag` arm in the router's `streamForSource`.
 */
export const RuntimeWaitStreamsLive = Layer.effect(
  RuntimeWaitStreams,
  Effect.gen(function*() {
    const agentOutput = yield* RuntimeAgentOutputEvents
    const agentOutputAfter = yield* Effect.serviceOption(RuntimeAgentOutputAfterEvents)
    const runtimeRun = yield* RuntimeRuns
    const runtimeIngressInput = yield* Effect.map(
      Effect.serviceOption(RuntimeIngressInputStream),
      Option.getOrElse(() => Stream.empty),
    )
    return {
      agentOutput,
      agentOutputAfter: source =>
        Option.match(agentOutputAfter, {
          onNone: () =>
            agentOutput.pipe(
              Stream.filter((row) =>
                row.contextId === source.contextId &&
                row.activityAttempt === source.activityAttempt &&
                row.sequence > source.afterSequence),
            ),
          onSome: service =>
            Stream.merge(
              Stream.fromEffect(service.initial(source)).pipe(
                Stream.filterMap(value => value),
              ),
              service.after(source),
            ),
        }),
      initialAgentOutputAfter: source =>
        Option.match(agentOutputAfter, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: service => service.initial(source),
        }),
      runtimeRun,
      runtimeIngressInput,
    }
  }),
)
