import { Response } from "@effect/ai"
import {
  makeIngressChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import { FiregridRuntimeObservationSourceNames } from "@firegrid/protocol/observations"
import {
  RuntimeAgentOutputObservationSchema,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import {
  makeRuntimeChannelRouter,
  sessionAgentOutputObservationRoute,
  type RuntimeChannelRouterService,
} from "@firegrid/runtime/channels"
import { Effect, PubSub, Ref, Stream } from "effect"

/**
 * tf-22fo — tiny-firegrid PROOF: delegated child output observation through the
 * EXISTING channel/router shape (no `session_read` protocol, no parallel
 * `ChildOutput*` schema, no source-specific event taxonomy).
 *
 * What this proves that the production unit test
 * (`packages/runtime/test/channels/session-agent-output-route.test.ts`) does
 * NOT: that production test feeds the route a *finite* `Stream.fromIterable`,
 * so it can only show "first row after cursor over a frozen snapshot". The C6
 * acceptance for delegated child output is a *live* observation:
 *
 *   source identity (child sessionId) + cursor (afterSequence) + optional match
 *
 * with snapshot-first / subscribe-after-cursor semantics over a child whose
 * output is still being produced. This probe wires the REAL production
 * primitives —
 *
 *   - `sessionAgentOutputObservationRoute` (tf-1ymw, the cursored ingress route)
 *   - `makeRuntimeChannelRouter` (the runtime channel router / dispatch surface)
 *   - `makeIngressChannel` + `SessionAgentOutputChannelTarget` (protocol channel)
 *   - `RuntimeAgentOutputObservationSchema` (the existing observation union)
 *
 * — over a clean-room child-output log that grows over time, exactly the way a
 * `session_new` / `session_prompt` child accrues `TextChunk` / terminal output.
 *
 * The proof asserts: a parent advancing its cursor (round-tripping the observed
 * `sequence` back as `afterSequence`) reads every child observation exactly
 * once, in order, through to terminal — with NO stale duplicate reads — and
 * that nothing here introduces a new schema or event tag. The observation type
 * stays the existing `AgentOutput*` union; the route input stays
 * `{ sessionId, afterSequence }`.
 *
 * Constraint source: runtime-design-constraints.md C6 ("Observations Are Typed
 * Source, Cursor, Match"; "Delegated Child Output").
 */

const observationSource = FiregridRuntimeObservationSourceNames.agentOutputEvents

const baseFields = (sessionId: string, sequence: number) => ({
  source: observationSource,
  sessionId: sessionId as RuntimeAgentOutputObservation["sessionId"],
  contextId: sessionId as RuntimeAgentOutputObservation["contextId"],
  activityAttempt: 1,
  sequence,
})

/** A child `TextChunk` observation — the existing union member, not a new tag. */
export const childTextChunk = (
  sessionId: string,
  sequence: number,
  delta: string,
): RuntimeAgentOutputObservation => ({
  ...baseFields(sessionId, sequence),
  _tag: "TextChunk",
  event: {
    _tag: "TextChunk",
    part: Response.textDeltaPart({ id: `p-${sequence}`, delta }),
  },
})

/** A child turn-terminal `TurnComplete` observation (prompt-turn terminal). */
export const childTurnComplete = (
  sessionId: string,
  sequence: number,
): RuntimeAgentOutputObservation => ({
  ...baseFields(sessionId, sequence),
  _tag: "TurnComplete",
  event: { _tag: "TurnComplete", finishReason: "stop" },
})

/** A child session-terminal `Terminated` observation (session-end terminal). */
export const childTerminated = (
  sessionId: string,
  sequence: number,
  exitCode = 0,
): RuntimeAgentOutputObservation => ({
  ...baseFields(sessionId, sequence),
  _tag: "Terminated",
  event: { _tag: "Terminated", exitCode },
})

interface SessionState {
  readonly log: Ref.Ref<ReadonlyArray<RuntimeAgentOutputObservation>>
  readonly hub: PubSub.PubSub<RuntimeAgentOutputObservation>
}

/**
 * Snapshot-first, subscribe-after-cursor live stream for one child session
 * (runtime-design-constraints.md C6; RFC `projections-and-channels.md` §10.4).
 *
 * Subscribe to the live hub BEFORE reading the durable snapshot so no append
 * can fall into the gap, then drop the live rows already covered by the
 * snapshot (`sequence > lastSnapshotSequence`). Per-session sequences are
 * strictly increasing, so that bound is the exact dedupe boundary. The stream
 * never self-completes, so the route's `runHead` returns immediately when a
 * matching row already exists (snapshot-first) and otherwise parks until the
 * producer appends one (subscribe-after-cursor) — never a stale re-read.
 */
const liveSessionStream = (
  state: SessionState | undefined,
): Stream.Stream<RuntimeAgentOutputObservation> => {
  if (state === undefined) {
    // Unknown / unauthorized session: nothing observable. Mirrors the route's
    // never-on-empty behavior (the observation parks rather than fabricating a
    // row). In production the `forContext` resolver is the authority boundary.
    return Stream.empty
  }
  return Stream.unwrapScoped(
    Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(state.hub)
      const snapshot = yield* Ref.get(state.log)
      const lastSnapshotSequence = snapshot.reduce(
        (max, row) => Math.max(max, row.sequence),
        -1,
      )
      const live = Stream.fromQueue(subscription).pipe(
        Stream.filter(row => row.sequence > lastSnapshotSequence),
      )
      return Stream.concat(Stream.fromIterable(snapshot), live)
    }),
  )
}

interface ChildOutputProof {
  /**
   * The runtime channel router with the REAL `sessionAgentOutputObservationRoute`
   * mounted on `session.agent_output`. Parents observe children only through
   * `router.dispatch({ verb: "wait_for", payload: { sessionId, afterSequence }})`.
   */
  readonly router: RuntimeChannelRouterService
  /** Register a fresh child session (its durable output log). `session_new`. */
  readonly sessionNew: (sessionId: string) => Effect.Effect<void>
  /** Append one child output observation (producer side of `session_prompt`). */
  readonly emit: (
    observation: RuntimeAgentOutputObservation,
  ) => Effect.Effect<void>
}

/**
 * Build the proof harness. Each call gets independent in-memory child state, so
 * tests are isolated. The channel service `forContext` is the only ingress
 * doorway and reuses `makeIngressChannel` + the existing observation schema.
 */
export const makeChildOutputProof: Effect.Effect<ChildOutputProof> = Effect.sync(
  () => {
    const sessions = new Map<string, SessionState>()

    const channel: SessionAgentOutputChannelService = {
      forContext: sessionId =>
        makeIngressChannel({
          target: SessionAgentOutputChannelTarget,
          schema: RuntimeAgentOutputObservationSchema,
          sourceClass: "static-source",
          stream: liveSessionStream(sessions.get(sessionId)),
        }),
    }

    const router = makeRuntimeChannelRouter([
      sessionAgentOutputObservationRoute(channel),
    ])

    const sessionNew = (sessionId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (sessions.has(sessionId)) return
        const log = yield* Ref.make<ReadonlyArray<RuntimeAgentOutputObservation>>(
          [],
        )
        const hub = yield* PubSub.unbounded<RuntimeAgentOutputObservation>()
        sessions.set(sessionId, { log, hub })
      })

    const emit = (
      observation: RuntimeAgentOutputObservation,
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const state = sessions.get(observation.sessionId)
        if (state === undefined) {
          return yield* Effect.dieMessage(
            `emit before session_new for ${observation.sessionId}`,
          )
        }
        // Durable write first, then live notify — a subscriber that snapshots
        // after the write sees it in the snapshot; one that subscribed earlier
        // sees it on the hub. No loss, no duplicate.
        yield* Ref.update(state.log, rows => [...rows, observation])
        yield* PubSub.publish(state.hub, observation)
      })

    return { router, sessionNew, emit }
  },
)

/**
 * Parent-side single observation: dispatch the existing ingress `wait_for`
 * route with `{ sessionId, afterSequence }` and decode the result back through
 * the EXISTING `RuntimeAgentOutputObservationSchema` (proving no parallel
 * schema is involved).
 */
export const observeAfter = (
  proof: ChildOutputProof,
  sessionId: string,
  afterSequence: number,
): Effect.Effect<RuntimeAgentOutputObservation> =>
  proof.router
    .dispatch({
      target: SessionAgentOutputChannelTarget,
      verb: "wait_for",
      payload: { sessionId, afterSequence },
    })
    .pipe(
      // The dispatch result IS a `RuntimeAgentOutputObservation` (the existing
      // ingress observation type), not a bespoke read response — the route
      // returns the channel row as-is. Tests assert membership of the existing
      // union via `Schema.is` rather than re-decoding the already-decoded row.
      Effect.map(result => result as RuntimeAgentOutputObservation),
      Effect.orDie,
    )

/**
 * Parent cursored read loop: round-trip the observed `sequence` back as the
 * next `afterSequence` (exactly the discipline the route doc prescribes to
 * avoid stale re-reads) and collect through the first observation matching
 * `isTerminal`.
 */
export const collectThroughTerminal = (
  proof: ChildOutputProof,
  sessionId: string,
  isTerminal: (observation: RuntimeAgentOutputObservation) => boolean,
  startCursor = -1,
): Effect.Effect<ReadonlyArray<RuntimeAgentOutputObservation>> =>
  Effect.gen(function*() {
    const collected: Array<RuntimeAgentOutputObservation> = []
    let cursor = startCursor
    for (;;) {
      const observation = yield* observeAfter(proof, sessionId, cursor)
      collected.push(observation)
      cursor = observation.sequence
      if (isTerminal(observation)) break
    }
    return collected
  })

/**
 * Anti-pattern reference: a reader that never advances its cursor (always reads
 * "from the start") re-reads the same first row every time — the stale
 * duplicate that the cursor exists to prevent. Used to make "without stale
 * duplicate reads" an empirical contrast, not just an assertion.
 */
export const naiveReadFromStart = (
  proof: ChildOutputProof,
  sessionId: string,
  times: number,
): Effect.Effect<ReadonlyArray<RuntimeAgentOutputObservation>> =>
  Effect.forEach(Array.from({ length: times }, (_, i) => i), () =>
    observeAfter(proof, sessionId, -1))
