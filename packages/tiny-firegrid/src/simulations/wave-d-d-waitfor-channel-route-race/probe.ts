// Wave D-D — migration probe: can `WaitForWorkflow`'s match `Activity` move
// from `Stream.runHead(streamForSource(...).filter(trigger))` over the legacy
// `RuntimeObservationStreams.{agentOutput,agentOutputAfter,runtimeRun,callerFact}`
// catalog to a `router.dispatch({ verb: "wait_for", target, payload })`
// cursor-advance loop, racing N such loops via `Effect.raceAll` inside ONE
// durable Activity, WITHOUT regressing the four Shape D invariants the
// existing wait-router guarantees?
//
//   1. Single-source filter correctness (advance cursor on non-match, settle
//      on first match).
//   2. N-source race correctness (`wait_for_any` returns the winning source's
//      observation + index; losing sources do not deliver duplicates).
//   3. Restart safety (Activity re-run after host crash re-finds the match;
//      snapshot-first + subscribe-after-cursor preserved; no missed match,
//      no stale duplicate).
//   4. Timeout race (`Effect.race(matchOnRoutes, Effect.sleep(...))` still
//      gives a deterministic Timeout outcome when no source matches).
//
// What this probe reuses unchanged:
//   - `sessionAgentOutputObservationRoute` (tf-1ymw)        @firegrid/runtime/channels
//   - `sessionLifecycleTerminalRoute` (#708 / Wave C)       @firegrid/runtime/channels
//   - `makeRuntimeChannelRouter` / `RuntimeChannelRouter`   @firegrid/runtime/channels
//   - `makeIngressChannel` + the protocol channel targets   @firegrid/protocol/channels
//
// What this probe is FORBIDDEN to import:
//   - `RuntimeObservationStreams` / `RuntimeObservationStreamsLive`
//   - `CallerFactObservationSourceSchema` / `CallerOwnedFactStreams`
//   - `@firegrid/runtime/streams` (the public package subpath we want to delete)
//   - `WaitForWorkflow` / `WaitForWorkflowLayer` (the migration target — the
//     probe stands in for it; we are testing what the rewrite would look like)
//
// Out of scope (separate probe, separate finding):
//   - Schema serialization of the rewritten `WaitForWorkflowSource` discriminant
//     through `@effect/workflow`. The probe runs the migration shape as a plain
//     `Effect.gen` (since `Activity.make` requires a workflow engine); the
//     Shape D justification is unchanged (durable race + timer), so the
//     production rewrite wraps the same body in `Activity.make` exactly as the
//     existing `matchOrTimeoutActivity` does.

import { Response } from "@effect/ai"
import {
  makeIngressChannel,
  SessionAgentOutputChannelTarget,
  SessionLifecycleChannelTarget,
  type ChannelTarget,
  type SessionAgentOutputChannelService,
  type SessionLifecycleChannelService,
} from "@firegrid/protocol/channels"
import {
  RuntimeRunEventSchema,
  type RuntimeRunEvent,
} from "@firegrid/protocol/launch"
import {
  RuntimeAgentOutputObservationSchema,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import {
  makeRuntimeChannelRouter,
  sessionAgentOutputObservationRoute,
  sessionLifecycleTerminalRoute,
  type RuntimeChannelRouterService,
} from "@firegrid/runtime/channels"
import { Duration, Effect, PubSub, Ref, Stream } from "effect"

// ---------------------------------------------------------------------------
// The migration shape under test — what `WaitForWorkflow`'s match Activity
// would look like after the route migration. ONE source = one cursor-advance
// loop; race N of them with `Effect.raceAll`; optional timeout via
// `Effect.race(match, Effect.sleep(...))`. This is plain Effect; the
// production rewrite wraps the body in `Activity.make(...)` to inherit the
// existing Shape D durable-race justification.
// ---------------------------------------------------------------------------

/** One source the rewritten wait races. */
interface ChannelRouteSource {
  readonly target: ChannelTarget
  readonly payload: { readonly sessionId: string; readonly afterSequence: number }
  readonly trigger: {
    readonly fieldEquals: ReadonlyArray<{
      readonly key: string
      readonly value: string | number | boolean
    }>
  }
}

const resolveDottedPath = (
  row: Record<string, unknown>,
  key: string,
): unknown =>
  key.split(".").reduce<unknown>(
    (cursor, segment) =>
      typeof cursor === "object" && cursor !== null
        ? (cursor as Record<string, unknown>)[segment]
        : undefined,
    row,
  )

const evaluateFieldEquals = (
  trigger: ChannelRouteSource["trigger"],
  row: unknown,
): boolean => {
  if (typeof row !== "object" || row === null) return false
  const obj = row as Record<string, unknown>
  return trigger.fieldEquals.every(({ key, value }) =>
    resolveDottedPath(obj, key) === value)
}

const sequenceOf = (row: unknown, fallback: number): number => {
  if (typeof row !== "object" || row === null) return fallback + 1
  const seq = (row as { readonly sequence?: unknown }).sequence
  return typeof seq === "number" ? seq : fallback + 1
}

/**
 * One source loop: dispatch -> filter -> on match settle; on miss advance
 * cursor and dispatch again. The route's snapshot-first + subscribe-after-
 * cursor invariant (tf-22fo) guarantees the loop neither stalls at the
 * frontier nor returns a stale duplicate.
 */
export const matchOnRoute = (
  router: RuntimeChannelRouterService,
  source: ChannelRouteSource,
): Effect.Effect<unknown> =>
  Effect.gen(function*() {
    let cursor = source.payload.afterSequence
    for (;;) {
      const row = yield* router
        .dispatch({
          target: source.target,
          verb: "wait_for",
          payload: { ...source.payload, afterSequence: cursor },
        })
        .pipe(Effect.orDie)
      if (evaluateFieldEquals(source.trigger, row)) return row
      cursor = sequenceOf(row, cursor)
    }
  })

/**
 * Race N source loops + an optional timeout. Returns either the winning
 * observation + index, or a Timeout outcome.
 */
export type WaitForOutcome =
  | { readonly _tag: "Match"; readonly raw: unknown; readonly winnerIndex: number }
  | { readonly _tag: "Timeout" }

export const matchOrTimeoutOnRoutes = (
  router: RuntimeChannelRouterService,
  sources: ReadonlyArray<ChannelRouteSource>,
  timeoutMs?: number,
): Effect.Effect<WaitForOutcome> =>
  Effect.gen(function*() {
    const matches = sources.map((source, winnerIndex) =>
      matchOnRoute(router, source).pipe(
        Effect.map((raw): WaitForOutcome => ({
          _tag: "Match",
          raw,
          winnerIndex,
        })),
      ))
    const match = Effect.raceAll(matches)
    if (timeoutMs === undefined) return yield* match
    return yield* Effect.race(
      match,
      Effect.sleep(Duration.millis(timeoutMs)).pipe(
        Effect.as<WaitForOutcome>({ _tag: "Timeout" }),
      ),
    )
  })

// ---------------------------------------------------------------------------
// Clean-room per-session ingress channels matching the production durable
// shape (snapshot-first + subscribe-after-cursor live stream). Same harness
// shape as tf-22fo; verbatim across the two channels we exercise.
// ---------------------------------------------------------------------------

interface SessionState<Row> {
  readonly log: Ref.Ref<ReadonlyArray<Row>>
  readonly hub: PubSub.PubSub<Row>
}

const liveSessionStream = <Row extends { readonly sequence?: number }>(
  state: SessionState<Row> | undefined,
): Stream.Stream<Row> => {
  if (state === undefined) return Stream.empty
  return Stream.unwrapScoped(
    Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(state.hub)
      const snapshot = yield* Ref.get(state.log)
      const lastSnapshotSequence = snapshot.reduce(
        (max, row) => Math.max(max, row.sequence ?? -1),
        -1,
      )
      const live = Stream.fromQueue(subscription).pipe(
        Stream.filter(row => (row.sequence ?? -1) > lastSnapshotSequence),
      )
      return Stream.concat(Stream.fromIterable(snapshot), live)
    }),
  )
}

interface SequencedRunEvent {
  readonly sequence: number
  readonly event: RuntimeRunEvent
}

const makeLifecycleStream = (
  state: SessionState<SequencedRunEvent> | undefined,
): Stream.Stream<RuntimeRunEvent> =>
  liveSessionStream(state).pipe(Stream.map(seq => seq.event))

interface RouteHarness {
  readonly router: RuntimeChannelRouterService
  readonly emitAgentOutput: (
    sessionId: string,
    observation: RuntimeAgentOutputObservation,
  ) => Effect.Effect<void>
  readonly emitLifecycle: (
    sessionId: string,
    event: RuntimeRunEvent,
  ) => Effect.Effect<void>
}

export const makeRouteHarness: Effect.Effect<RouteHarness> = Effect.sync(() => {
  const agentOutput = new Map<string, SessionState<RuntimeAgentOutputObservation>>()
  const lifecycle = new Map<string, SessionState<SequencedRunEvent>>()

  const ensureAgentOutput = (sessionId: string) =>
    Effect.gen(function*() {
      if (agentOutput.has(sessionId)) return
      const log = yield* Ref.make<ReadonlyArray<RuntimeAgentOutputObservation>>([])
      const hub = yield* PubSub.unbounded<RuntimeAgentOutputObservation>()
      agentOutput.set(sessionId, { log, hub })
    })

  const ensureLifecycle = (sessionId: string) =>
    Effect.gen(function*() {
      if (lifecycle.has(sessionId)) return
      const log = yield* Ref.make<ReadonlyArray<SequencedRunEvent>>([])
      const hub = yield* PubSub.unbounded<SequencedRunEvent>()
      lifecycle.set(sessionId, { log, hub })
    })

  const agentOutputChannel: SessionAgentOutputChannelService = {
    forContext: sessionId =>
      makeIngressChannel({
        target: SessionAgentOutputChannelTarget,
        schema: RuntimeAgentOutputObservationSchema,
        sourceClass: "static-source",
        stream: liveSessionStream(agentOutput.get(sessionId)),
      }),
  }

  const lifecycleChannel: SessionLifecycleChannelService = {
    forSession: sessionId =>
      makeIngressChannel({
        target: SessionLifecycleChannelTarget,
        schema: RuntimeRunEventSchema,
        sourceClass: "static-source",
        stream: makeLifecycleStream(lifecycle.get(sessionId)),
      }),
  }

  const router = makeRuntimeChannelRouter([
    sessionAgentOutputObservationRoute(agentOutputChannel),
    sessionLifecycleTerminalRoute(lifecycleChannel),
  ])

  return {
    router,
    emitAgentOutput: (sessionId, observation) =>
      Effect.gen(function*() {
        yield* ensureAgentOutput(sessionId)
        const state = agentOutput.get(sessionId)!
        yield* Ref.update(state.log, rows => [...rows, observation])
        yield* PubSub.publish(state.hub, observation)
      }),
    emitLifecycle: (sessionId, event) =>
      Effect.gen(function*() {
        yield* ensureLifecycle(sessionId)
        const state = lifecycle.get(sessionId)!
        const current = yield* Ref.get(state.log)
        const wrapped: SequencedRunEvent = { sequence: current.length, event }
        yield* Ref.update(state.log, rows => [...rows, wrapped])
        yield* PubSub.publish(state.hub, wrapped)
      }),
  }
})

// ---------------------------------------------------------------------------
// Test-side helpers.
// ---------------------------------------------------------------------------

export const textChunk = (
  sessionId: string,
  sequence: number,
  delta: string,
): RuntimeAgentOutputObservation => ({
  source: "agent-output-events" as RuntimeAgentOutputObservation["source"],
  sessionId: sessionId as RuntimeAgentOutputObservation["sessionId"],
  contextId: sessionId as RuntimeAgentOutputObservation["contextId"],
  activityAttempt: 0,
  sequence,
  _tag: "TextChunk",
  event: {
    _tag: "TextChunk",
    part: Response.textDeltaPart({ id: `p-${sequence}`, delta }),
  },
})

export const turnComplete = (
  sessionId: string,
  sequence: number,
): RuntimeAgentOutputObservation => ({
  source: "agent-output-events" as RuntimeAgentOutputObservation["source"],
  sessionId: sessionId as RuntimeAgentOutputObservation["sessionId"],
  contextId: sessionId as RuntimeAgentOutputObservation["contextId"],
  activityAttempt: 0,
  sequence,
  _tag: "TurnComplete",
  event: { _tag: "TurnComplete", finishReason: "stop" },
})

export const lifecycleStarted = (sessionId: string): RuntimeRunEvent => ({
  contextId: sessionId,
  activityAttempt: 0,
  status: "started",
  at: new Date(0).toISOString(),
  provider: "local-process",
  runEventId: { contextId: sessionId, activityAttempt: 0, status: "started" },
})

export const lifecycleExited = (
  sessionId: string,
  exitCode: number,
): RuntimeRunEvent => ({
  contextId: sessionId,
  activityAttempt: 0,
  status: "exited",
  at: new Date(1).toISOString(),
  provider: "local-process",
  runEventId: { contextId: sessionId, activityAttempt: 0, status: "exited" },
  exitCode,
})

export const sourceAgentOutputAfter = (
  sessionId: string,
  afterSequence: number,
  predicateTag: "TurnComplete" | "TextChunk",
): ChannelRouteSource => ({
  target: SessionAgentOutputChannelTarget,
  payload: { sessionId, afterSequence },
  trigger: { fieldEquals: [{ key: "_tag", value: predicateTag }] },
})

export const sourceLifecycle = (sessionId: string): ChannelRouteSource => ({
  target: SessionLifecycleChannelTarget,
  payload: { sessionId, afterSequence: -1 },
  trigger: { fieldEquals: [{ key: "status", value: "exited" }] },
})

// Lightweight narrowing helpers. Test assertions in the `.test.ts` file use
// `vitest`'s `expect` to bail on mismatch; these helpers are predicates +
// non-throwing accessors so the probe stays throw-free
// (firegrid-remediation-hardening.STATIC_QUALITY.10 — quality-metric ratchet).
export const isMatch = (
  outcome: WaitForOutcome,
): outcome is Extract<WaitForOutcome, { readonly _tag: "Match" }> =>
  outcome._tag === "Match"

export const isTimeout = (outcome: WaitForOutcome): boolean =>
  outcome._tag === "Timeout"

export const asObservation = (
  raw: unknown,
): RuntimeAgentOutputObservation | undefined =>
  typeof raw === "object" && raw !== null && "sequence" in raw
    ? (raw as RuntimeAgentOutputObservation)
    : undefined

export const asRunEvent = (raw: unknown): RuntimeRunEvent | undefined =>
  typeof raw === "object" && raw !== null && "status" in raw
    ? (raw as RuntimeRunEvent)
    : undefined

