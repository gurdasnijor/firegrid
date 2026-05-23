// Shape C Wave C — terminal-completion ordering (runtime side).
//
// CC1's ordering blocker: public `startRuntime` observes
// `session.agent_output` `_tag: "Terminated"` and treats that as the
// terminal contract, but reads of the durable `runs.exited` row
// immediately after sometimes find it absent — the agent-output
// Terminated event lands ahead of the durable run-exited row.
//
// Cannon C7 (`docs/cannon/architecture/runtime-design-constraints.md`
// §"Route Completion"):
//
//     Immediate append/call receipts are router metadata. Terminal
//     prompt completion is durable runtime result state. Do not
//     synthesize terminal `Done` at the ACP edge over raw
//     `TurnComplete` observation. Bind terminal completion to the
//     state/result fact that the keyed handler owns.
//
// The keyed handler's terminal fact in production is the
// `RuntimeRunEventSchema` row with `status: "exited" | "failed"` written
// via `RuntimeRunAppendAndGet.recordExited` (see
// `packages/runtime/src/workflow-engine/workflows/runtime-context-run.ts:100`
// `"runtime-control-plane.runs.exited"`). It is exposed today as the
// per-session `SessionLifecycleChannel.forSession(sessionId)` ingress
// (`packages/protocol/src/channels/host-control.ts:180-191`) backed by
// `control.runs.rows().filter(row => row.contextId === sessionId)`
// (`packages/runtime/src/channels/host-control-routes.ts:99-107`).
//
// This sim models BOTH event surfaces against ONE substrate to prove:
//
//   - the ordering gap is real: an internal side-effect that emits
//     agent-output Terminated AHEAD of the durable runs.exited row
//     produces a window where the agent-output observation can fire and
//     a runs.exited read returns nothing;
//   - the lifecycle channel observation closes the gap: the route's
//     stream tails the durable runs table, so `wait_for` cannot
//     resolve before the row exists.
//
// Three-surface decomposition is reused from #706's
// `shape-c-non-recursive-start`: public facade → host.sessions.start
// (call) + observation route (wait_for); reconciler → internal
// side-effect → emit agent_output observations + write runs.exited.
// This sim adds the runs durable table + the lifecycle route.

import {
  Effect,
  Option,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"

// ── Channel route shapes (sim-local) ────────────────────────────────────

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

// Mirror production: agent-output union variants the codec emits. Only
// the variants relevant to terminal-ordering are modeled here.
export const SessionAgentOutputObservationSchema = Schema.Union(
  Schema.TaggedStruct("TextChunk", {
    contextId: Schema.String,
    sequence: Schema.Number,
    text: Schema.String,
  }),
  Schema.TaggedStruct("Terminated", {
    contextId: Schema.String,
    sequence: Schema.Number,
    exitCode: Schema.Number,
  }),
)
export type SessionAgentOutputObservation = Schema.Schema.Type<typeof SessionAgentOutputObservationSchema>

// Mirror production: `RuntimeRunEventSchema` (status started|exited|failed).
// The lifecycle observation source is `SessionLifecycleChannel.forSession`
// (`SessionLifecycleChannelTarget = "session.lifecycle"`), an
// IngressChannel<RuntimeRunEventSchema> that streams from
// `control.runs.rows()` filtered by contextId.
export const RuntimeRunEventSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
  at: Schema.String,
  exitCode: Schema.optional(Schema.Number),
})
export type RuntimeRunEvent = Schema.Schema.Type<typeof RuntimeRunEventSchema>

export const SessionLifecycleRouteInputSchema = Schema.Struct({
  sessionId: Schema.String,
  afterStatuses: Schema.optional(Schema.Array(Schema.String)),
})
export type SessionLifecycleRouteInput = Schema.Schema.Type<typeof SessionLifecycleRouteInputSchema>

// ── Substrate ───────────────────────────────────────────────────────────

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
  // host.sessions.start writes here (idempotent durable row).
  readonly startRequests: SubscriptionRef.SubscriptionRef<ReadonlyArray<StartRequestRow>>
  // session.agent_output streams from here (codec/sandbox raw observations).
  readonly outputs: SubscriptionRef.SubscriptionRef<ReadonlyArray<OutputRow>>
  // session.lifecycle streams from here (durable run-lifecycle events).
  // Production analogue: `RuntimeControlPlaneTable.runs` via
  // `RuntimeRunAppendAndGet.recordExited`.
  readonly runs: SubscriptionRef.SubscriptionRef<ReadonlyArray<RuntimeRunEvent>>
  readonly outputCounter: Ref.Ref<ReadonlyMap<string, number>>
  // Observability counters (the test asserts on these).
  readonly startRequestWrites: Ref.Ref<number>
  readonly reconcilerDrains: Ref.Ref<number>
  readonly internalStartInvocations: Ref.Ref<number>
}

export const makeSubstrate = (): Effect.Effect<Substrate> =>
  Effect.gen(function*() {
    return {
      startRequests: yield* SubscriptionRef.make<ReadonlyArray<StartRequestRow>>([]),
      outputs: yield* SubscriptionRef.make<ReadonlyArray<OutputRow>>([]),
      runs: yield* SubscriptionRef.make<ReadonlyArray<RuntimeRunEvent>>([]),
      outputCounter: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
      startRequestWrites: yield* Ref.make(0),
      reconcilerDrains: yield* Ref.make(0),
      internalStartInvocations: yield* Ref.make(0),
    }
  })

// ── Internal host start side-effect ─────────────────────────────────────
//
// The side-effect emits agent_output observations (the codec/sandbox feed)
// AND writes the durable runs.exited row when the session terminates.
// Production maps to `RuntimeControlRequestSideEffects.start(request)` —
// the runtime-internal start primitive that drives the session worker.
//
// The ordering is modeled with an injectable delay between the agent_output
// Terminated emit and the runs.exited write so the gap is reproducible.

export interface InternalHostStartHooks {
  readonly exitCode: number
  // Milliseconds between emitting agent_output Terminated and writing
  // runs.exited. Production has this gap by physics (the codec's
  // Terminated event is observed before the host journals + writes the
  // run-exit row). The sim sets it explicitly to reproduce the race.
  readonly settlementDelayMs: number
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

const writeRunsExited = (
  substrate: Substrate,
  contextId: string,
  exitCode: number,
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const at = new Date(yield* Effect.clockWith((c) => c.currentTimeMillis)).toISOString()
    yield* SubscriptionRef.update(substrate.runs, (rows) => [
      ...rows,
      { contextId, activityAttempt: 1, status: "exited" as const, at, exitCode },
    ])
  })

export const internalHostStart = (
  substrate: Substrate,
  hooks: InternalHostStartHooks,
) =>
(request: { readonly contextId: string; readonly requestId: string }): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* Ref.update(substrate.internalStartInvocations, (n) => n + 1)
    // 1. Codec emits raw agent-output Terminated (TurnComplete-shaped).
    yield* appendObservation(substrate, {
      _tag: "Terminated",
      contextId: request.contextId,
      sequence: -1,
      exitCode: hooks.exitCode,
    })
    // 2. Settlement window — the gap CC1 hit. Production has this
    //    interval because the host journals the codec event before it
    //    writes the durable run-exit row. Any consumer that treats the
    //    agent-output Terminated as the terminal contract races with
    //    the durable settlement.
    if (hooks.settlementDelayMs > 0) {
      yield* Effect.sleep(`${hooks.settlementDelayMs} millis`)
    }
    // 3. Durable terminal fact lands. Production analogue:
    //    `RuntimeRunAppendAndGet.recordExited(context, attempt, exit)`.
    yield* writeRunsExited(substrate, request.contextId, hooks.exitCode)
  })

// ── Reconciler ──────────────────────────────────────────────────────────

export const reconcileOnce = (
  substrate: Substrate,
  hooks: InternalHostStartHooks,
): Effect.Effect<{ readonly drained: number }> =>
  Effect.gen(function*() {
    yield* Ref.update(substrate.reconcilerDrains, (n) => n + 1)
    const pending = yield* SubscriptionRef.get(substrate.startRequests)
    const pendingOnly = pending.filter((row) => row.status === "pending")
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

// ── Routes ──────────────────────────────────────────────────────────────

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

export interface SessionLifecycleRoute {
  readonly target: "session.lifecycle"
  readonly direction: "ingress"
  // Mirror production: per-session ingress that tails durable run-event
  // rows. The filter on `status` is the predicate-on-typed-source pattern
  // production already uses for `wait.forPermissionRequest` (the same
  // filter shape Wave C #702/#705 validates).
  readonly waitFor: (
    input: SessionLifecycleRouteInput,
  ) => Effect.Effect<RuntimeRunEvent, Error>
}

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

export const makeSessionLifecycleRoute = (
  substrate: Substrate,
): SessionLifecycleRoute => ({
  target: "session.lifecycle",
  direction: "ingress",
  waitFor: (input) => {
    const wanted =
      input.afterStatuses === undefined
        ? new Set<string>(["exited", "failed"])
        : new Set<string>(input.afterStatuses)
    return substrate.runs.changes.pipe(
      Stream.filterMap((rows) => {
        const match = rows.find(
          (row) => row.contextId === input.sessionId && wanted.has(row.status),
        )
        return match === undefined ? Option.none() : Option.some(match)
      }),
      Stream.take(1),
      Stream.runHead,
      Effect.flatMap((head) =>
        Option.isNone(head)
          ? Effect.fail(new Error("session.lifecycle: stream ended"))
          : Effect.succeed(head.value),
      ),
    )
  },
})

// ── Router ──────────────────────────────────────────────────────────────

export interface Router {
  readonly routes: {
    readonly "host.sessions.start": HostSessionsStartRoute
    readonly "session.agent_output": SessionAgentOutputRoute
    readonly "session.lifecycle": SessionLifecycleRoute
  }
  readonly dispatch: {
    readonly call: (
      target: "host.sessions.start",
      input: SessionStartInput,
    ) => Effect.Effect<RuntimeStartRequestAck>
    readonly waitForAgentOutput: (
      input: SessionAgentOutputRouteInput,
    ) => Effect.Effect<SessionAgentOutputObservation, Error>
    readonly waitForLifecycle: (
      input: SessionLifecycleRouteInput,
    ) => Effect.Effect<RuntimeRunEvent, Error>
  }
}

export const makeRouter = (substrate: Substrate): Router => {
  const routes = {
    "host.sessions.start": makeHostSessionsStartRoute(substrate),
    "session.agent_output": makeSessionAgentOutputRoute(substrate),
    "session.lifecycle": makeSessionLifecycleRoute(substrate),
  } as const
  return {
    routes,
    dispatch: {
      call: (target, input) => routes[target].call(input),
      waitForAgentOutput: (input) => routes["session.agent_output"].waitFor(input),
      waitForLifecycle: (input) => routes["session.lifecycle"].waitFor(input),
    },
  }
}
