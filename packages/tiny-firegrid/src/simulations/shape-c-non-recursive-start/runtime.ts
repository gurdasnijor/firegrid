// Shape C Wave C — non-recursive public start facade (runtime side).
//
// Validates the existing-primitives split the SDD pins:
//
//   public start facade          (writes the start-request row + observes
//                                 session.agent_output via wait_for)
//                ↓ durable startRequests row
//   reconciler                   (drains startRequests; invokes internal
//                                 side-effect; never calls back into the
//                                 public facade)
//                ↓ invocation
//   internal host start side-effect
//                                (physically starts the per-context session
//                                 and emits session.agent_output observations
//                                 — Terminated/Error — onto the output stream)
//                ↓ durable outputs
//   public start facade unblocks (wait_for observes the terminal observation;
//                                 returns; NO second start-request written)
//
// CC1's blocker was the recursion variant: public start → write startRequest
// → reconciler → side-effect → call public start (recursion) → another
// startRequest → deadlock. The fix is the three-surface decomposition above,
// mirrored from the production split:
//
//   public         → `startRuntime`             (packages/host-sdk/src/host/commands.ts)
//   public route   → `HostSessionsStartChannel` (packages/protocol/src/channels/host-control.ts;
//                                                impl in `host-control-request.ts:143`)
//   durable row    → `RuntimeStartRequestRow`   (packages/protocol/src/launch/control-request.ts)
//   reconciler     → `reconcileRuntimeControlRequestsOnce`
//                                                (packages/runtime/src/control-plane/control-request-dispatcher.ts:683)
//   internal       → `RuntimeControlRequestSideEffects.start`
//                                                (packages/runtime/src/control-plane/control-request-dispatcher.ts:53-68)
//
// SDD anchors:
//   - docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md  (callable
//     channels lower to runtime substrate; the route does the durable write,
//     NOT the work)
//   - docs/architecture/host-sdk-runtime-boundary.md       (host-sdk is the
//     composition facade; durable/runtime execution lives below the
//     boundary; reconciler + side-effect are runtime-internal)
//   - docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY_IMPLEMENTATION.md
//     (session.start writes RuntimeStartRequestRow ack; reconciler
//     materializes the actual start; observation goes through the typed
//     session-output source)
//
// This file owns the runtime side: substrate, routes, reconciler, internal
// side-effect. The public facade lives in `public-facade.ts` and reaches
// the runtime side ONLY through the router (string-keyed dispatch).

import {
  Effect,
  Option,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"

// ── Channel route shapes (sim-local; mirror the SDD's typed channel
//    surface) ─────────────────────────────────────────────────────────────

export const SessionStartInputSchema = Schema.Struct({
  sessionId: Schema.String,
})
export type SessionStartInput = Schema.Schema.Type<typeof SessionStartInputSchema>

export const RuntimeStartRequestAckSchema = Schema.Struct({
  contextId: Schema.String,
  requestId: Schema.String,
  inserted: Schema.Boolean,
})
export type RuntimeStartRequestAck = Schema.Schema.Type<typeof RuntimeStartRequestAckSchema>

export const SessionAgentOutputRouteInputSchema = Schema.Struct({
  sessionId: Schema.String,
  afterSequence: Schema.Number,
})
export type SessionAgentOutputRouteInput = Schema.Schema.Type<typeof SessionAgentOutputRouteInputSchema>

export const SessionAgentOutputObservationSchema = Schema.Union(
  Schema.TaggedStruct("Terminated", {
    contextId: Schema.String,
    sequence: Schema.Number,
    exitCode: Schema.Number,
  }),
  Schema.TaggedStruct("Error", {
    contextId: Schema.String,
    sequence: Schema.Number,
    cause: Schema.Unknown,
    recoverable: Schema.Boolean,
  }),
)
export type SessionAgentOutputObservation = Schema.Schema.Type<typeof SessionAgentOutputObservationSchema>

// ── Durable substrate ────────────────────────────────────────────────────
//
// `startRequests` is the durable-write surface the HostSessionsStartChannel
// route appends to (mirror `control.startRequests.insertOrGet` from
// `packages/protocol/src/launch/host-control-request.ts:160`). `outputs` is
// the per-context observation stream the SessionAgentOutputChannel tails.
// Counters are observability tools the test uses to assert the
// non-recursive shape.

interface StartRequestRow {
  readonly requestId: string
  readonly contextId: string
  readonly status: "pending" | "completed"
}

interface OutputRow {
  readonly contextId: string
  readonly sequence: number
  readonly observation: SessionAgentOutputObservation
}

export interface Substrate {
  readonly startRequests: SubscriptionRef.SubscriptionRef<ReadonlyArray<StartRequestRow>>
  readonly outputs: SubscriptionRef.SubscriptionRef<ReadonlyArray<OutputRow>>
  readonly outputCounter: Ref.Ref<ReadonlyMap<string, number>>
  // Counters: observability only, used by the test's assertion harness.
  readonly startRequestWrites: Ref.Ref<number>
  readonly reconcilerDrains: Ref.Ref<number>
  readonly internalStartInvocations: Ref.Ref<number>
}

export const makeSubstrate = (): Effect.Effect<Substrate> =>
  Effect.gen(function*() {
    return {
      startRequests: yield* SubscriptionRef.make<ReadonlyArray<StartRequestRow>>([]),
      outputs: yield* SubscriptionRef.make<ReadonlyArray<OutputRow>>([]),
      outputCounter: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
      startRequestWrites: yield* Ref.make(0),
      reconcilerDrains: yield* Ref.make(0),
      internalStartInvocations: yield* Ref.make(0),
    }
  })

// ── Internal host start side-effect ──────────────────────────────────────
//
// Maps to production `RuntimeControlRequestSideEffects.start(request)`.
// THIS IS THE PRIVATE PATH. It physically starts the session by emitting
// observations onto the per-context output stream. It must not call the
// public start facade — the test's recursion guard asserts that file-text
// invariant.
//
// The "agent factory" is parameterized so the test can choose terminal or
// error outcomes. Production maps this to the runtime's actual session/body
// start primitive (sandbox spawn + codec init); the sim collapses that into
// the observation emission since the public-facade observation contract is
// what's being validated.

export type SessionStartAgent =
  | { readonly kind: "terminal"; readonly exitCode: number }
  | { readonly kind: "error"; readonly recoverable: boolean; readonly cause: unknown }

export interface InternalHostStartHooks {
  readonly agentFor: (request: { readonly contextId: string }) => SessionStartAgent
}

const allocateOutputSequence = (
  substrate: Substrate,
  contextId: string,
): Effect.Effect<number> =>
  Ref.modify(substrate.outputCounter, (counters) => {
    const next = (counters.get(contextId) ?? -1) + 1
    const updated = new Map(counters)
    updated.set(contextId, next)
    return [next, updated]
  })

const appendObservation = (
  substrate: Substrate,
  observation: SessionAgentOutputObservation,
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const sequence = yield* allocateOutputSequence(substrate, observation.contextId)
    const stamped: SessionAgentOutputObservation = { ...observation, sequence }
    yield* SubscriptionRef.update(substrate.outputs, (rows) => [
      ...rows,
      { contextId: stamped.contextId, sequence, observation: stamped },
    ])
  })

export const internalHostStart = (
  substrate: Substrate,
  hooks: InternalHostStartHooks,
) =>
(request: { readonly contextId: string; readonly requestId: string }): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* Ref.update(substrate.internalStartInvocations, (n) => n + 1)
    const agent = hooks.agentFor(request)
    // ────────────────────────────────────────────────────────────────────
    // NO CALL BACK INTO THE PUBLIC FACADE. The internal side-effect emits
    // observations directly onto the per-context output stream. This is
    // the non-recursive contract: the side-effect drives the session
    // worker; the public facade only observes the typed source.
    // ────────────────────────────────────────────────────────────────────
    if (agent.kind === "error") {
      yield* appendObservation(substrate, {
        _tag: "Error",
        contextId: request.contextId,
        sequence: -1,
        cause: agent.cause,
        recoverable: agent.recoverable,
      })
      yield* appendObservation(substrate, {
        _tag: "Terminated",
        contextId: request.contextId,
        sequence: -1,
        exitCode: 1,
      })
      return
    }
    yield* appendObservation(substrate, {
      _tag: "Terminated",
      contextId: request.contextId,
      sequence: -1,
      exitCode: agent.exitCode,
    })
  })

// ── Reconciler ───────────────────────────────────────────────────────────
//
// Production maps to `reconcileRuntimeControlRequestsOnce` in
// `packages/runtime/src/control-plane/control-request-dispatcher.ts:683`.
// The reconciler drains pending startRequests and invokes the internal
// side-effect for each. CRITICALLY, it does NOT call back into the public
// start facade — only the internal `internalHostStart` (mirroring
// production's `sideEffects.start(request)` at line 375).

export const reconcileOnce = (
  substrate: Substrate,
  hooks: InternalHostStartHooks,
): Effect.Effect<{ readonly drained: number }> =>
  Effect.gen(function*() {
    yield* Ref.update(substrate.reconcilerDrains, (n) => n + 1)
    const pending = yield* SubscriptionRef.get(substrate.startRequests)
    const pendingOnly = pending.filter((row) => row.status === "pending")
    // Sequential traversal preserves the original loop's ordering and its
    // single-threaded drain semantics (the reconciler is the only writer of
    // these rows in this sim). `Effect.forEach` with default sequential
    // concurrency replaces the package-source for..of loop.
    yield* Effect.forEach(pendingOnly, (row) =>
      internalHostStart(substrate, hooks)({
        contextId: row.contextId,
        requestId: row.requestId,
      }),
    )
    const drainedIds = new Set(pendingOnly.map((row) => row.requestId))
    yield* SubscriptionRef.update(substrate.startRequests, (rows) =>
      rows.map((row) =>
        drainedIds.has(row.requestId)
          ? { ...row, status: "completed" as const }
          : row,
      ),
    )
    return { drained: pendingOnly.length }
  })

// ── Routes (the wire-edge of the substrate) ──────────────────────────────
//
// `hostSessionsStartRoute` is a callable route — writes a startRequest
// durable row and returns an ack. Maps to production
// `HostSessionsStartChannel` callable channel + its
// `control.startRequests.insertOrGet(stamped)` body
// (`packages/protocol/src/launch/host-control-request.ts:160`).
//
// `sessionAgentOutputRoute` is an ingress route — tails the per-context
// output stream strictly after a cursor. Maps to production
// `SessionAgentOutputChannel.forContext(contextId).binding.stream` +
// `sessionAgentOutputObservationRoute` registered on
// `HostPlaneChannelRouter` (#703).

export interface HostSessionsStartRoute {
  readonly target: "host.sessions.start"
  readonly direction: "call"
  readonly call: (input: SessionStartInput) => Effect.Effect<RuntimeStartRequestAck>
}

export interface SessionAgentOutputRoute {
  readonly target: "session.agent_output"
  readonly direction: "ingress"
  readonly waitFor: (
    input: SessionAgentOutputRouteInput,
  ) => Effect.Effect<SessionAgentOutputObservation, Error>
}

// Request-id derivation: read from the `startRequestWrites` counter the
// route already advances (atomic via `Ref.modify`). Avoids module-scope
// mutable state (`local/no-module-durable-cache`) — in production the
// requestId is itself derived from the durable row identity (cf.
// `makeRuntimeStartRequestRow` in `packages/protocol/src/launch/
// control-request.ts:251`), not from a module counter.
export const makeHostSessionsStartRoute = (
  substrate: Substrate,
): HostSessionsStartRoute => ({
  target: "host.sessions.start",
  direction: "call",
  call: (input) =>
    Effect.gen(function*() {
      const requestNumber = yield* Ref.modify(
        substrate.startRequestWrites,
        (n) => [n + 1, n + 1],
      )
      const requestId = `req_${requestNumber}`
      // Idempotent durable write — production uses `insertOrGet` keyed on
      // (contextId, requestedBy). The sim treats every public-facade call
      // as a new request to make the recursion counter assertion exact.
      yield* SubscriptionRef.update(substrate.startRequests, (rows) => [
        ...rows,
        { requestId, contextId: input.sessionId, status: "pending" as const },
      ])
      return { contextId: input.sessionId, requestId, inserted: true }
    }),
})

export const makeSessionAgentOutputRoute = (
  substrate: Substrate,
): SessionAgentOutputRoute => ({
  target: "session.agent_output",
  direction: "ingress",
  waitFor: (input) =>
    substrate.outputs.changes.pipe(
      Stream.filterMap((rows) => {
        const match = rows.find(
          (row) =>
            row.contextId === input.sessionId &&
            row.sequence > input.afterSequence,
        )
        return match === undefined
          ? Option.none()
          : Option.some(match.observation)
      }),
      Stream.take(1),
      Stream.runHead,
      Effect.flatMap((head) =>
        Option.isNone(head)
          ? Effect.fail(new Error("session.agent_output: stream ended"))
          : Effect.succeed(head.value),
      ),
    ),
})

// ── Router (string-keyed dispatch over the routes) ───────────────────────

export interface Router {
  readonly routes: {
    readonly "host.sessions.start": HostSessionsStartRoute
    readonly "session.agent_output": SessionAgentOutputRoute
  }
  readonly dispatch: {
    readonly call: (
      target: "host.sessions.start",
      input: SessionStartInput,
    ) => Effect.Effect<RuntimeStartRequestAck>
    readonly waitFor: (
      target: "session.agent_output",
      input: SessionAgentOutputRouteInput,
    ) => Effect.Effect<SessionAgentOutputObservation, Error>
  }
}

export const makeRouter = (substrate: Substrate): Router => {
  const routes = {
    "host.sessions.start": makeHostSessionsStartRoute(substrate),
    "session.agent_output": makeSessionAgentOutputRoute(substrate),
  } as const
  return {
    routes,
    dispatch: {
      call: (target, input) => routes[target].call(input),
      waitFor: (target, input) => routes[target].waitFor(input),
    },
  }
}
