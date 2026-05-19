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
import type { DurableTableError } from "effect-durable-operators"
import { Context, Effect, Layer, Option, Stream } from "effect"
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
  readonly agentOutputForContext: (
    contextId: string,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly runtimeRun: Stream.Stream<RuntimeRunEventRow, unknown>
  /**
   * firegrid-typed-wait-source-redesign.CONTEXT.3
   *
   * Caller-owned durable fact stream selected by app-chosen name. Empty
   * when no host composition has bound caller-owned fact streams (the
   * CallerFact wait then simply times out rather than crashing the
   * router — the same optional-capability posture as `agentOutputAfter`).
   */
  readonly callerFact: (
    stream: string,
  ) => Stream.Stream<unknown, unknown>
}

export class RuntimeWaitStreams extends Context.Tag(
  "@firegrid/runtime/RuntimeWaitStreams",
)<RuntimeWaitStreams, RuntimeWaitStreamsService>() {}

/**
 * firegrid-typed-wait-source-redesign.CONTEXT.3
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.2
 *
 * Host-composition-provided resolver from a caller-owned durable fact
 * stream name to its concrete durable observation Stream. The runtime does
 * not own or enumerate app collections; the host that knows the app's
 * caller-owned `DurableTable` binds it here by name. Consumed by the wait
 * router through the Effect requirement channel; never exposed on the
 * agent wait-source expression (TYPED_SOURCES.4 — the agent passes only a
 * name string, never a table facade).
 */
export interface CallerOwnedFactStreamsService {
  readonly streamFor: (stream: string) => Stream.Stream<unknown, unknown>
}

export class CallerOwnedFactStreams extends Context.Tag(
  "@firegrid/runtime/CallerOwnedFactStreams",
)<CallerOwnedFactStreams, CallerOwnedFactStreamsService>() {}

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
    // CONTEXT.3: caller-owned fact streams are an optional host-composition
    // capability. Absent => CallerFact waits observe an empty stream and
    // time out (never crash the router).
    const callerOwnedFactStreams = yield* Effect.serviceOption(CallerOwnedFactStreams)

    // firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
    //
    // THE `onNone` BRANCHES BELOW ARE DEAD IN PRODUCTION — DO NOT DEEPEN.
    //
    // They filter the host-prefixed whole-table `agentOutput` stream
    // (`RuntimeAgentOutputEvents` → the ambient `RuntimeOutputTable`,
    // `…firegrid.host.{hostId}.runtimeOutput`). Post-#315 nothing writes
    // that stream: runtime output is sharded per-context by
    // `PerContextRuntimeOutputWriter`, and the production host
    // composition always provides `PerContextRuntimeAgentOutputAfterEventsLive`
    // (see `runtime-substrate.ts`), so `agentOutputAfter` is always
    // `Some` and the `onSome` (per-context) branch is taken. The
    // `onNone` arms exist only to keep this layer constructible when the
    // per-context service is absent (non-production / unit harnesses).
    // They are intentionally a thin, contextId/attempt filter over an
    // empty stream — adding logic here would be reviving the
    // host-as-runtime-owner output model the per-context reshape
    // removed. See docs/research/host-vs-context-boundary-audit.md
    // §A4 (the ambient host-prefixed `RuntimeOutputTable` is flagged
    // for Cycle 1 cleanup once `RuntimeAgentOutputEvents`'s structural
    // dependency is reshaped).
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
          Stream.withSpan("firegrid.runtime_wait_streams.agent_output_after", {
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
          Effect.withSpan("firegrid.runtime_wait_streams.agent_output_after.initial", {
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
          Stream.withSpan("firegrid.runtime_wait_streams.agent_output.for_context", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": contextId,
            },
          }),
        ),
      runtimeRun,
      callerFact: stream =>
        Option.match(callerOwnedFactStreams, {
          onNone: () => Stream.empty,
          onSome: service => service.streamFor(stream),
        }).pipe(
          Stream.withSpan("firegrid.runtime_wait_streams.caller_fact", {
            kind: "internal",
            attributes: {
              "firegrid.wait.caller_fact_stream": stream,
            },
          }),
        ),
    }
  }),
)
