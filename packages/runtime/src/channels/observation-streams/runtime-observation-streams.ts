import type { DurableTableError } from "effect-durable-operators"
import { Context, Effect, Layer, Option, Stream } from "effect"
import {
  RuntimeAgentOutputAfterEvents,
  RuntimeAgentOutputEvents,
  type RuntimeAgentOutputObservation,
} from "../../tables/runtime-output.ts"
import type { RuntimeObservationSource } from "./sources.ts"

export interface RuntimeObservationStreamsService {
  readonly agentOutput: Stream.Stream<
    RuntimeAgentOutputObservation,
    DurableTableError
  >
  readonly agentOutputAfter: (
    source: Extract<RuntimeObservationSource, { readonly _tag: "AgentOutputAfter" }>,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly initialAgentOutputAfter: (
    source: Extract<RuntimeObservationSource, { readonly _tag: "AgentOutputAfter" }>,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>
  readonly agentOutputForContext: (
    contextId: string,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly callerFact: (
    stream: string,
  ) => Stream.Stream<unknown, unknown>
}

/**
 * Runtime-owned inversion seam for workflow definitions below the host-sdk
 * boundary. Host composition provides Live Layers that adapt host-authored
 * observation sources into this tag; see
 * `docs/architecture/host-sdk-runtime-boundary.md` § Risk Surfaces.
 */
export class RuntimeObservationStreams extends Context.Tag(
  "@firegrid/runtime/RuntimeObservationStreams",
)<RuntimeObservationStreams, RuntimeObservationStreamsService>() {}

/**
 * firegrid-typed-wait-source-redesign.CONTEXT.3
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.2
 *
 * Host-composition-provided resolver from a caller-owned durable fact
 * stream name to its concrete durable observation Stream. The runtime does
 * not own or enumerate app collections; the host that knows the app's
 * caller-owned `DurableTable` binds it here by name.
 */
export interface CallerOwnedFactStreamsService {
  readonly streamFor: (stream: string) => Stream.Stream<unknown, unknown>
}

export class CallerOwnedFactStreams extends Context.Tag(
  "@firegrid/runtime/CallerOwnedFactStreams",
)<CallerOwnedFactStreams, CallerOwnedFactStreamsService>() {}

/**
 * Built from the typed runtime observation tags. Adding a typed source is
 * localized: add one `RuntimeObservationSource` variant, one field here, and
 * one consumer dispatch arm.
 */
export const RuntimeObservationStreamsLive = Layer.effect(
  RuntimeObservationStreams,
  Effect.gen(function*() {
    const agentOutput = yield* RuntimeAgentOutputEvents
    const agentOutputAfter = yield* Effect.serviceOption(RuntimeAgentOutputAfterEvents)
    const callerOwnedFactStreams = yield* Effect.serviceOption(CallerOwnedFactStreams)

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
        }).pipe(
          Stream.withSpan("firegrid.runtime_observation_streams.agent_output_after", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": source.contextId,
              "firegrid.runtime.activity_attempt": source.activityAttempt,
              "firegrid.runtime.output.after_sequence": source.afterSequence,
            },
          }),
        ),
      initialAgentOutputAfter: source =>
        Option.match(agentOutputAfter, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: service => service.initial(source),
        }).pipe(
          Effect.withSpan("firegrid.runtime_observation_streams.agent_output_after.initial", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": source.contextId,
              "firegrid.runtime.activity_attempt": source.activityAttempt,
              "firegrid.runtime.output.after_sequence": source.afterSequence,
            },
          }),
        ),
      agentOutputForContext: contextId =>
        Option.match(agentOutputAfter, {
          onNone: () =>
            agentOutput.pipe(
              Stream.filter((row) => row.contextId === contextId),
            ),
          onSome: service => service.forContext(contextId),
        }).pipe(
          Stream.withSpan("firegrid.runtime_observation_streams.agent_output.for_context", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": contextId,
            },
          }),
        ),
      callerFact: stream =>
        Option.match(callerOwnedFactStreams, {
          onNone: () => Stream.empty,
          onSome: service => service.streamFor(stream),
        }).pipe(
          Stream.withSpan("firegrid.runtime_observation_streams.caller_fact", {
            kind: "internal",
            attributes: {
              "firegrid.observation.caller_fact_stream": stream,
            },
          }),
        ),
    }
  }),
)
