import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Deferred, Effect, Layer, Stream, type Scope } from "effect"
import { AgentSession } from "../../codecs/contract.ts"
import { RuntimeAgentOutputAfterEvents } from "../../authorities/runtime-output-journal.ts"
import { RuntimeContextInputFacts } from "../../authorities/runtime-context-input-facts.ts"
import {
  isStateRelevantOutputObservation,
  RuntimeContextStateStore,
} from "../../../workflow-engine/runtime-context-state.ts"
import { RuntimeToolUseExecutor } from "../../../workflow-engine/tool-execution/runtime-tool-use-executor.ts"
import {
  runKeyedDispatch,
  type KeyedEvent,
} from "../../../runtime-keyed-subscriber/index.ts"
import type { RuntimeExitEvidence } from "../../../workflow-engine/workflows/runtime-context-run.ts"
import {
  handleRuntimeContextEvent,
  type RuntimeContextTargetEvent,
} from "./handler.ts"

// Shape C RuntimeContext subscriber composition.
//
// Drives the per-event handler from the two typed sources Wave 1 owns:
//   - input  : RuntimeContextInputFacts.forContext(contextId)
//              (#682 sidecar/shape-c-input-facts; replaces the per-sequence
//              DurableDeferred mailbox with a direct durable inputIntents tail)
//   - output : RuntimeAgentOutputAfterEvents.forContext(contextId) filtered
//              through isStateRelevantOutputObservation (#681 sparse output;
//              dense rows still flow to UI/telemetry through the existing
//              channel/router, only state-relevant facts reach the handler)
//
// Tool-result facts are NOT a separate source: the handler invokes the
// `RuntimeToolUseExecutor` inline when transitionOutputEvent yields a
// `RunToolUse` action and forwards the result via `AgentSession.send`. A
// distinct ToolResult stream would only be needed if a producer outside the
// handler write surface produced ToolResult facts; #684 is the slice that owns
// any such addition.
//
// Per tf-tvg1 Outcome B, the per-key mutex inside `runKeyedDispatch` is the
// only piece of in-process subscriber-runtime machinery beyond the substrate
// tail. In a per-context layer there is one key, so the mutex degenerates to
// a no-op serialiser; the API stays consistent for the host-wide composition
// a later wave will collapse to.
//
// R channel intentionally excludes `WorkflowEngine` and `WorkflowInstance`:
// this is a Shape C subscriber. If a future change pulls in workflow
// machinery, the tf-zchu semgrep guard (C2/C4) and the public-surface-
// boundary check will surface it.

export const ACTIVITY_ATTEMPT_SHAPE_C = 0 as const

// Terminal evidence the per-context Shape C subscriber observed at runtime. The
// host hold-effect awaits this to surface `activityAttempt`/`exitCode`/`signal`
// to its caller (where the OLD shape returned them from
// `executeRuntimeContextWorkflow`).
export interface RuntimeContextExitEvidenceObservation {
  readonly activityAttempt: number
  readonly exitCode: number
  readonly signal?: string
}

// Per-run Deferred filled by the subscriber when it observes the durable
// `exitEvidence` field on the state row (written by transitionOutputEvent on a
// `Terminated` observation). The host composition creates this Deferred at the
// `runtime.run({...})` call site and passes the SAME instance to both the
// subscriber (via `RuntimeContextSubscriberLive(context, exitSignal)`) and the
// hold effect (`runtimeContextHoldUntilExit(exitSignal)`), so signal +
// observation share one coordination primitive without needing the runtime
// kernel to flow supportLayer services into the run's effect channel.
export type RuntimeContextExitSignal =
  Deferred.Deferred<RuntimeContextExitEvidenceObservation>

const evidenceObservation = (
  activityAttempt: number,
  evidence: RuntimeExitEvidence,
): RuntimeContextExitEvidenceObservation => ({
  activityAttempt,
  exitCode: evidence.exitCode,
  ...(evidence.signal === undefined ? {} : { signal: evidence.signal }),
})

const inputEvents = (
  contextId: string,
): Effect.Effect<
  Stream.Stream<KeyedEvent<string, RuntimeContextTargetEvent>, unknown>,
  never,
  RuntimeContextInputFacts
> =>
  Effect.map(RuntimeContextInputFacts, facts =>
    facts.forContext(contextId).pipe(
      Stream.map((row): KeyedEvent<string, RuntimeContextTargetEvent> => ({
        key: contextId,
        event: { _tag: "Input", event: row },
      })),
    ))

const outputEvents = (
  context: RuntimeContext,
): Effect.Effect<
  Stream.Stream<KeyedEvent<string, RuntimeContextTargetEvent>, unknown>,
  never,
  RuntimeAgentOutputAfterEvents
> =>
  Effect.map(RuntimeAgentOutputAfterEvents, observations =>
    observations.forContext(context.contextId).pipe(
      Stream.filter(observation =>
        isStateRelevantOutputObservation(context, observation)),
      Stream.map((observation): KeyedEvent<string, RuntimeContextTargetEvent> => ({
        key: context.contextId,
        event: { _tag: "Output", event: observation },
      })),
    ))

// After every successful per-event handle, check whether the durable state row
// now carries terminal `exitEvidence`. The handler writes it inside the same
// `save` that closes the per-event state transition, so a single point-read
// after the handler returns is sufficient — no separate polling loop. First
// observation wins; subsequent invocations are idempotent (Deferred.succeed
// returns false on re-attempt).
const signalExitIfTerminal = (
  context: RuntimeContext,
  activityAttempt: number,
  store: RuntimeContextStateStore["Type"],
  exitSignal: RuntimeContextExitSignal,
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const state = yield* store.load(context, activityAttempt)
    if (state.exitEvidence === undefined) return
    yield* Deferred.succeed(
      exitSignal,
      evidenceObservation(activityAttempt, state.exitEvidence),
    )
  })

const runRuntimeContextSubscriber = (
  context: RuntimeContext,
  activityAttempt: number,
  exitSignal: RuntimeContextExitSignal,
): Effect.Effect<
  void,
  unknown,
  | Scope.Scope
  | RuntimeContextInputFacts
  | RuntimeAgentOutputAfterEvents
  | RuntimeContextStateStore
  | AgentSession
  | RuntimeToolUseExecutor
> =>
  Effect.gen(function*() {
    const store = yield* RuntimeContextStateStore
    const inputs = yield* inputEvents(context.contextId)
    const outputs = yield* outputEvents(context)
    const source = Stream.merge(inputs, outputs)
    yield* runKeyedDispatch({
      source,
      handle: (_key, event) =>
        handleRuntimeContextEvent(context, activityAttempt, event).pipe(
          Effect.tap(() =>
            signalExitIfTerminal(context, activityAttempt, store, exitSignal)),
          // Individual handler failures must not tear down the whole
          // subscriber: log + continue. Stream-level errors (source failure)
          // still propagate and end the subscriber, which closes its scope.
          Effect.catchAllCause(cause =>
            Effect.logError(
              "Shape C RuntimeContext handler failure (continuing)",
              cause,
            )),
        ),
    })
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.subscriber.run", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "RuntimeContextSubscriber",
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

// Layer factory: forks the subscriber into the layer's scope so it lives
// exactly as long as the host composition that provides this layer. When the
// scope closes (context deregister / host shutdown), the subscriber and all
// its forked per-event materializations are interrupted; the passed-in
// `exitSignal` Deferred remains unfilled (the run caller then sees the run's
// own interrupt, not an exit-evidence result).
//
// The caller owns the Deferred and shares it with `runtimeContextHoldUntilExit`
// so signal + observation share one coordination primitive (see
// `RuntimeContextExitSignal` doc).
export const RuntimeContextSubscriberLive = (
  context: RuntimeContext,
  exitSignal: RuntimeContextExitSignal,
): Layer.Layer<
  never,
  unknown,
  | RuntimeContextInputFacts
  | RuntimeAgentOutputAfterEvents
  | RuntimeContextStateStore
  | AgentSession
  | RuntimeToolUseExecutor
> =>
  Layer.scopedDiscard(
    runRuntimeContextSubscriber(context, ACTIVITY_ATTEMPT_SHAPE_C, exitSignal).pipe(
      Effect.catchAllCause(cause =>
        Effect.logError(
          "Shape C RuntimeContext subscriber stream ended with error",
          cause,
        )),
      Effect.forkScoped,
    ),
  )

// Awaits the per-run exit signal and returns the durable terminal evidence.
// Caller passes the SAME Deferred it gave to `RuntimeContextSubscriberLive`.
export const runtimeContextAwaitExit = (
  exitSignal: RuntimeContextExitSignal,
): Effect.Effect<RuntimeContextExitEvidenceObservation> =>
  Deferred.await(exitSignal).pipe(
    Effect.withSpan("firegrid.host.runtime_context.subscriber.await_exit", {
      kind: "internal",
    }),
  )

// Create a fresh per-run exit signal. Caller scopes the Deferred to its own
// effect (it dies with the surrounding fiber if the run never observes exit
// evidence — which is what we want; nothing else holds onto the Deferred).
export const makeRuntimeContextExitSignal: Effect.Effect<RuntimeContextExitSignal> =
  Deferred.make<RuntimeContextExitEvidenceObservation>()
