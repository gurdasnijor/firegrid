// Runtime side: route Live implementations.
//
// Per SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md §"Package Placement" the
// runtime owns route Live Layers and the dispatch interpreter. The host
// facade composes the routes; it does not implement them.
//
// Production-target alignment
// ---------------------------
// The seven targets in this sim use the SDD-pinned production target
// literals from `packages/protocol/src/channels/` so the proof binds to
// real router keys:
//
//   host.contexts.create           <- HostContextsCreateChannel
//                                     (packages/protocol/src/channels/host-control.ts)
//   host.prompt                    <- HostPromptChannel
//                                     (host-control.ts)
//   host.sessions.create_or_load   <- HostSessionsCreateOrLoadChannel
//                                     (packages/protocol/src/channels/host-sessions-create-or-load.ts)
//   host.sessions.start            <- HostSessionsStartChannel
//                                     (host-control.ts)
//   session.prompt                 <- SessionPromptChannel
//                                     (host-control.ts; per-session factory
//                                      in production, sessionId in input
//                                      schema here)
//   session.agent_output           <- SessionAgentOutputChannel
//                                     (packages/protocol/src/channels/session-agent-output.ts;
//                                      per-context factory; contextId +
//                                      afterSequence in input schema as in
//                                      production SessionAgentOutputRouteInputSchema)
//   host.permissions.respond       <- HostPermissionRespondChannel
//                                     (host-control.ts; host-scoped, contextId
//                                      in request — production client SDK
//                                      uses this for BOTH client.permissions
//                                      .respond and handle.permissions.respond)
//
// The Shape C per-event handler and the durable per-session state stubbed
// in this file represent the runtime EXECUTION substrate. They are NOT
// exported through `index.ts`. The host facade and client facade have no
// import path to them — asserted as negative shape guards in
// `probe.test.ts`.

import {
  Clock,
  Effect,
  Option,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import {
  type CallableChannel,
  ChannelTarget,
  type EgressChannel,
  type IngressChannel,
  RouteCompletionReceiptSchema,
  acknowledgementCompletion,
  callableRoute,
  egressRoute,
  ingressRoute,
  terminalCompletion,
  type ChannelRoute,
} from "./protocol.ts"

// ── Public schemas ────────────────────────────────────────────────────────

export const HostContextsCreateRequestSchema = Schema.Struct({
  contextId: Schema.String,
})
export type HostContextsCreateRequest = Schema.Schema.Type<typeof HostContextsCreateRequestSchema>

export const HostContextsCreateResponseSchema = Schema.Struct({
  contextId: Schema.String,
})
export type HostContextsCreateResponse = Schema.Schema.Type<typeof HostContextsCreateResponseSchema>

export const HostPromptRequestSchema = Schema.Struct({
  contextId: Schema.String,
  inputId: Schema.String,
  payload: Schema.String,
})
export type HostPromptRequest = Schema.Schema.Type<typeof HostPromptRequestSchema>

export const SessionCreateOrLoadInputSchema = Schema.Struct({
  externalKey: Schema.Struct({
    source: Schema.String,
    id: Schema.String,
  }),
})
export type SessionCreateOrLoadInput = Schema.Schema.Type<typeof SessionCreateOrLoadInputSchema>

export const SessionHandleReferenceSchema = Schema.Struct({
  sessionId: Schema.String,
  contextId: Schema.String,
})
export type SessionHandleReference = Schema.Schema.Type<typeof SessionHandleReferenceSchema>

export const SessionStartInputSchema = Schema.Struct({
  sessionId: Schema.String,
})
export type SessionStartInput = Schema.Schema.Type<typeof SessionStartInputSchema>

export const RuntimeStartRequestAckSchema = Schema.Struct({
  contextId: Schema.String,
  startedAt: Schema.String,
})
export type RuntimeStartRequestAck = Schema.Schema.Type<typeof RuntimeStartRequestAckSchema>

export const SessionPromptRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  inputId: Schema.String,
  payload: Schema.String,
})
export type SessionPromptRequest = Schema.Schema.Type<typeof SessionPromptRequestSchema>

export const RuntimeInputIntentRowSchema = Schema.Struct({
  intentId: Schema.String,
  contextId: Schema.String,
  acceptedAt: Schema.String,
})
export type RuntimeInputIntentRow = Schema.Schema.Type<typeof RuntimeInputIntentRowSchema>

export const SessionAgentOutputRouteInputSchema = Schema.Struct({
  contextId: Schema.String,
  afterSequence: Schema.Number,
})
export type SessionAgentOutputRouteInput = Schema.Schema.Type<typeof SessionAgentOutputRouteInputSchema>

/**
 * The session-output observation union. PermissionRequest is part of the
 * same typed source — matches production: `waitForPermissionRequest` is
 * `forAgentOutput` filtered by `runtimePermissionRequestObservationFromAgentOutput`
 * in packages/client-sdk/src/firegrid.ts:743. No parallel
 * `session.permission_request` ingress route is needed.
 */
export const SessionAgentOutputObservationSchema = Schema.Union(
  Schema.TaggedStruct("TextChunk", {
    contextId: Schema.String,
    sequence: Schema.Number,
    text: Schema.String,
  }),
  Schema.TaggedStruct("PermissionRequest", {
    contextId: Schema.String,
    sequence: Schema.Number,
    permissionRequestId: Schema.String,
    toolUseId: Schema.String,
  }),
  Schema.TaggedStruct("Terminated", {
    contextId: Schema.String,
    sequence: Schema.Number,
    exitCode: Schema.Number,
  }),
)
export type SessionAgentOutputObservation = Schema.Schema.Type<typeof SessionAgentOutputObservationSchema>

export const PermissionDecisionSchema = Schema.Union(
  Schema.Literal("allow"),
  Schema.Literal("deny"),
)
export type PermissionDecision = Schema.Schema.Type<typeof PermissionDecisionSchema>

export const HostPermissionRespondRequestSchema = Schema.Struct({
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  decision: PermissionDecisionSchema,
})
export type HostPermissionRespondRequest = Schema.Schema.Type<typeof HostPermissionRespondRequestSchema>

export const HostPermissionRespondResponseSchema = Schema.Struct({
  appended: Schema.Boolean,
  permissionRequestId: Schema.String,
  decision: PermissionDecisionSchema,
})
export type HostPermissionRespondResponse = Schema.Schema.Type<typeof HostPermissionRespondResponseSchema>

// ── Channel targets (production literals) ────────────────────────────────

export const HostContextsCreateTarget = ChannelTarget("host.contexts.create")
export const HostPromptTarget = ChannelTarget("host.prompt")
export const HostSessionsCreateOrLoadTarget = ChannelTarget("host.sessions.create_or_load")
export const HostSessionsStartTarget = ChannelTarget("host.sessions.start")
export const SessionPromptTarget = ChannelTarget("session.prompt")
export const SessionAgentOutputTarget = ChannelTarget("session.agent_output")
export const HostPermissionRespondTarget = ChannelTarget("host.permissions.respond")

// ── Internal substrate: Shape C handler + state (NEVER exported up) ──────

interface RuntimeSessionState {
  readonly sessionId: string
  readonly contextId: string
  readonly started: boolean
  readonly processedInputIds: ReadonlyArray<string>
  readonly processedPermissionRequestIds: ReadonlyArray<string>
  readonly exitEvidence: Option.Option<{ readonly exitCode: number }>
}

interface InputIntentRow {
  readonly sessionId: string
  readonly inputId: string
  readonly payload: string
}

interface PermissionResponseRow {
  readonly contextId: string
  readonly permissionRequestId: string
  readonly decision: PermissionDecision
}

interface OutputRow {
  readonly contextId: string
  readonly sequence: number
  readonly observation: SessionAgentOutputObservation
}

const initialSessionState = (
  sessionId: string,
  contextId: string,
): RuntimeSessionState => ({
  sessionId,
  contextId,
  started: false,
  processedInputIds: [],
  processedPermissionRequestIds: [],
  exitEvidence: Option.none(),
})

interface RuntimeSubstrate {
  readonly inputIntents: SubscriptionRef.SubscriptionRef<ReadonlyArray<InputIntentRow>>
  readonly outputs: SubscriptionRef.SubscriptionRef<ReadonlyArray<OutputRow>>
  readonly permissionResponses: SubscriptionRef.SubscriptionRef<ReadonlyArray<PermissionResponseRow>>
  readonly states: Ref.Ref<ReadonlyMap<string, RuntimeSessionState>>
  readonly outputCounters: Ref.Ref<ReadonlyMap<string, number>>
  readonly externalKeyToSession: Ref.Ref<ReadonlyMap<string, string>>
  readonly stubAgent: StubAgent
}

interface StubAgent {
  readonly onPrompt: (
    contextId: string,
    payload: string,
    fixture: StubAgentFixture,
  ) => Effect.Effect<void>
  readonly onPermissionResponse: (
    contextId: string,
    permissionRequestId: string,
    decision: PermissionDecision,
    fixture: StubAgentFixture,
  ) => Effect.Effect<void>
}

export interface StubAgentFixture {
  readonly append: (observation: SessionAgentOutputObservation) => Effect.Effect<void>
}

/** Default stub agent: each prompt yields one TextChunk + Terminated. */
const echoTerminalAgent: StubAgent = {
  onPrompt: (contextId, payload, fixture) =>
    Effect.gen(function*() {
      yield* fixture.append({
        _tag: "TextChunk",
        contextId,
        sequence: -1,
        text: `echo:${payload}`,
      })
      yield* fixture.append({
        _tag: "Terminated",
        contextId,
        sequence: -1,
        exitCode: 0,
      })
    }),
  onPermissionResponse: () => Effect.void,
}

const makeSubstrate = (stubAgent: StubAgent = echoTerminalAgent): Effect.Effect<RuntimeSubstrate> =>
  Effect.gen(function*() {
    return {
      inputIntents: yield* SubscriptionRef.make<ReadonlyArray<InputIntentRow>>([]),
      outputs: yield* SubscriptionRef.make<ReadonlyArray<OutputRow>>([]),
      permissionResponses: yield* SubscriptionRef.make<ReadonlyArray<PermissionResponseRow>>([]),
      states: yield* Ref.make<ReadonlyMap<string, RuntimeSessionState>>(new Map()),
      outputCounters: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
      externalKeyToSession: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
      stubAgent,
    }
  })

const allocateOutputSequence = (
  substrate: RuntimeSubstrate,
  contextId: string,
): Effect.Effect<number> =>
  Ref.modify(substrate.outputCounters, (counters) => {
    const next = (counters.get(contextId) ?? -1) + 1
    const updated = new Map(counters)
    updated.set(contextId, next)
    return [next, updated]
  })

const appendOutput = (
  substrate: RuntimeSubstrate,
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

const ensureSessionState = (
  substrate: RuntimeSubstrate,
  contextId: string,
  sessionId?: string,
): Effect.Effect<RuntimeSessionState> =>
  Effect.gen(function*() {
    const states = yield* Ref.get(substrate.states)
    const key = sessionId ?? contextId
    const current = states.get(key)
    if (current !== undefined) return current
    const fresh = initialSessionState(key, contextId)
    yield* Ref.update(substrate.states, (m) => {
      const next = new Map(m)
      next.set(key, fresh)
      return next
    })
    return fresh
  })

const fixtureFor = (substrate: RuntimeSubstrate): StubAgentFixture => ({
  append: (observation) => appendOutput(substrate, observation),
})

/**
 * Stubbed Shape C per-event handler.
 *
 * Reviewer test for C2 / C5 / Cannon §1: this function has no
 * WorkflowEngine / WorkflowInstance / Activity.make / DurableDeferred /
 * ambient AgentSession in its signature. It does load/save on durable
 * session state and dispatches a SessionCommand-equivalent (here:
 * invokes the stub agent producer). It is hidden inside the runtime
 * route module — the host facade and the client facade have no path to
 * call it directly.
 */
const handleShapeCEvent = (
  substrate: RuntimeSubstrate,
  event:
    | { readonly _tag: "Input"; readonly row: InputIntentRow }
    | { readonly _tag: "PermissionResponse"; readonly row: PermissionResponseRow }
    | { readonly _tag: "Output"; readonly observation: SessionAgentOutputObservation },
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const states = yield* Ref.get(substrate.states)
    switch (event._tag) {
      case "Input": {
        const current = states.get(event.row.sessionId)
        if (current === undefined) return
        if (current.processedInputIds.includes(event.row.inputId)) return
        const next: RuntimeSessionState = {
          ...current,
          processedInputIds: [...current.processedInputIds, event.row.inputId],
        }
        const updated = new Map(states)
        updated.set(event.row.sessionId, next)
        yield* Ref.set(substrate.states, updated)
        yield* substrate.stubAgent.onPrompt(
          current.contextId,
          event.row.payload,
          fixtureFor(substrate),
        )
        return
      }
      case "PermissionResponse": {
        const current = [...states.values()].find((s) => s.contextId === event.row.contextId)
        if (current === undefined) return
        if (current.processedPermissionRequestIds.includes(event.row.permissionRequestId)) return
        const next: RuntimeSessionState = {
          ...current,
          processedPermissionRequestIds: [
            ...current.processedPermissionRequestIds,
            event.row.permissionRequestId,
          ],
        }
        const updated = new Map(states)
        updated.set(current.sessionId, next)
        yield* Ref.set(substrate.states, updated)
        yield* substrate.stubAgent.onPermissionResponse(
          event.row.contextId,
          event.row.permissionRequestId,
          event.row.decision,
          fixtureFor(substrate),
        )
        return
      }
      case "Output": {
        if (event.observation._tag === "Terminated") {
          const current = [...states.values()].find((s) =>
            s.contextId === event.observation.contextId)
          if (current === undefined) return
          const next: RuntimeSessionState = {
            ...current,
            exitEvidence: Option.some({ exitCode: event.observation.exitCode }),
          }
          const updated = new Map(states)
          updated.set(current.sessionId, next)
          yield* Ref.set(substrate.states, updated)
        }
        return
      }
    }
  })

// ── Route Live implementations ───────────────────────────────────────────

const hostContextsCreateLive = (
  substrate: RuntimeSubstrate,
): CallableChannel<
  typeof HostContextsCreateRequestSchema,
  typeof HostContextsCreateResponseSchema
> => ({
  target: HostContextsCreateTarget,
  direction: "call",
  inputSchema: HostContextsCreateRequestSchema,
  responseSchema: HostContextsCreateResponseSchema,
  completion: terminalCompletion(HostContextsCreateResponseSchema),
  binding: {
    _tag: "CallTarget",
    // Client allocates the contextId (matches production
    // packages/client-sdk/src/firegrid.ts:1023 `makeContextId()` then
    // `hostContextsCreateChannel.binding.call({ contextId, runtime })`).
    call: (request) =>
      Effect.gen(function*() {
        yield* ensureSessionState(substrate, request.contextId, request.contextId)
        return { contextId: request.contextId }
      }),
  },
})

const hostPromptLive = (
  substrate: RuntimeSubstrate,
): EgressChannel<typeof HostPromptRequestSchema, RuntimeInputIntentRow> => ({
  target: HostPromptTarget,
  direction: "egress",
  inputSchema: HostPromptRequestSchema,
  responseSchema: RuntimeInputIntentRowSchema,
  completion: acknowledgementCompletion,
  binding: {
    _tag: "AppendTarget",
    append: (payload) =>
      Effect.gen(function*() {
        yield* ensureSessionState(substrate, payload.contextId, payload.contextId)
        const existing = (yield* SubscriptionRef.get(substrate.inputIntents))
          .find((row) =>
            row.sessionId === payload.contextId && row.inputId === payload.inputId)
        if (existing === undefined) {
          yield* SubscriptionRef.update(substrate.inputIntents, (rows) => [
            ...rows,
            {
              sessionId: payload.contextId,
              inputId: payload.inputId,
              payload: payload.payload,
            },
          ])
          yield* handleShapeCEvent(substrate, {
            _tag: "Input",
            row: {
              sessionId: payload.contextId,
              inputId: payload.inputId,
              payload: payload.payload,
            },
          })
        }
        const nowMs = yield* Clock.currentTimeMillis
        return {
          intentId: payload.inputId,
          contextId: payload.contextId,
          acceptedAt: new Date(nowMs).toISOString(),
        }
      }),
  },
})

const hostSessionsCreateOrLoadLive = (
  substrate: RuntimeSubstrate,
): CallableChannel<
  typeof SessionCreateOrLoadInputSchema,
  typeof SessionHandleReferenceSchema
> => ({
  target: HostSessionsCreateOrLoadTarget,
  direction: "call",
  inputSchema: SessionCreateOrLoadInputSchema,
  responseSchema: SessionHandleReferenceSchema,
  completion: terminalCompletion(SessionHandleReferenceSchema),
  binding: {
    _tag: "CallTarget",
    call: (request) =>
      Effect.gen(function*() {
        const externalKeyFingerprint =
          `${request.externalKey.source}:${request.externalKey.id}`
        const existing = (yield* Ref.get(substrate.externalKeyToSession))
          .get(externalKeyFingerprint)
        if (existing !== undefined) {
          // Idempotent on externalKey: mirrors production
          // HostSessionsCreateOrLoadChannel "create or load" semantics.
          return { sessionId: existing, contextId: existing }
        }
        const nowMs = yield* Clock.currentTimeMillis
        const sessionId = `sess_${externalKeyFingerprint}_${nowMs}`
        const contextId = sessionId
        yield* Ref.update(substrate.states, (states) => {
          const next = new Map(states)
          next.set(sessionId, initialSessionState(sessionId, contextId))
          return next
        })
        yield* Ref.update(substrate.externalKeyToSession, (map) => {
          const next = new Map(map)
          next.set(externalKeyFingerprint, sessionId)
          return next
        })
        return { sessionId, contextId }
      }),
  },
})

const hostSessionsStartLive = (
  substrate: RuntimeSubstrate,
): CallableChannel<
  typeof SessionStartInputSchema,
  typeof RuntimeStartRequestAckSchema
> => ({
  target: HostSessionsStartTarget,
  direction: "call",
  inputSchema: SessionStartInputSchema,
  responseSchema: RuntimeStartRequestAckSchema,
  completion: terminalCompletion(RuntimeStartRequestAckSchema),
  binding: {
    _tag: "CallTarget",
    call: (request) =>
      Effect.gen(function*() {
        const states = yield* Ref.get(substrate.states)
        const current = states.get(request.sessionId)
        if (current === undefined) {
          return yield* Effect.fail(
            new Error(`session ${request.sessionId} not found`),
          )
        }
        const updated = new Map(states)
        updated.set(request.sessionId, { ...current, started: true })
        yield* Ref.set(substrate.states, updated)
        const nowMs = yield* Clock.currentTimeMillis
        return {
          contextId: current.contextId,
          startedAt: new Date(nowMs).toISOString(),
        }
      }),
  },
})

const sessionPromptLive = (
  substrate: RuntimeSubstrate,
): EgressChannel<typeof SessionPromptRequestSchema, RuntimeInputIntentRow> => ({
  target: SessionPromptTarget,
  direction: "egress",
  inputSchema: SessionPromptRequestSchema,
  responseSchema: RuntimeInputIntentRowSchema,
  completion: acknowledgementCompletion,
  binding: {
    _tag: "AppendTarget",
    append: (payload) =>
      Effect.gen(function*() {
        const existing = (yield* SubscriptionRef.get(substrate.inputIntents))
          .find((row) =>
            row.sessionId === payload.sessionId && row.inputId === payload.inputId)
        const states = yield* Ref.get(substrate.states)
        const session = states.get(payload.sessionId)
        if (session === undefined) {
          return yield* Effect.fail(
            new Error(`session ${payload.sessionId} not found for prompt`),
          )
        }
        if (existing === undefined) {
          yield* SubscriptionRef.update(substrate.inputIntents, (rows) => [
            ...rows,
            payload,
          ])
          yield* handleShapeCEvent(substrate, { _tag: "Input", row: payload })
        }
        const nowMs = yield* Clock.currentTimeMillis
        return {
          intentId: payload.inputId,
          contextId: session.contextId,
          acceptedAt: new Date(nowMs).toISOString(),
        }
      }),
  },
})

const sessionAgentOutputLive = (
  substrate: RuntimeSubstrate,
): IngressChannel<typeof SessionAgentOutputRouteInputSchema> => ({
  target: SessionAgentOutputTarget,
  direction: "ingress",
  inputSchema: SessionAgentOutputRouteInputSchema,
  observationSchema: SessionAgentOutputObservationSchema,
  completion: terminalCompletion(RouteCompletionReceiptSchema),
  binding: {
    _tag: "TypedStream",
    // Per C6: typed source identity + cursor + match. PermissionRequest
    // is part of THIS union — production client SDK's
    // `wait.forPermissionRequest` filters the same forAgentOutput stream
    // by predicate (firegrid.ts:743 implementation).
    stream: (input) =>
      substrate.outputs.changes.pipe(
        Stream.flatMap((rows) =>
          Stream.fromIterable(
            rows
              .filter((row) =>
                row.contextId === input.contextId &&
                row.sequence > input.afterSequence)
              .sort((a, b) => a.sequence - b.sequence)
              .map((row) => row.observation),
          ),
        ),
        Stream.tap((observation) =>
          handleShapeCEvent(substrate, { _tag: "Output", observation }),
        ),
      ),
  },
})

const hostPermissionRespondLive = (
  substrate: RuntimeSubstrate,
): CallableChannel<
  typeof HostPermissionRespondRequestSchema,
  typeof HostPermissionRespondResponseSchema
> => ({
  target: HostPermissionRespondTarget,
  direction: "call",
  inputSchema: HostPermissionRespondRequestSchema,
  responseSchema: HostPermissionRespondResponseSchema,
  completion: terminalCompletion(HostPermissionRespondResponseSchema),
  binding: {
    _tag: "CallTarget",
    call: (request) =>
      Effect.gen(function*() {
        const existing = (yield* SubscriptionRef.get(substrate.permissionResponses))
          .find((row) =>
            row.contextId === request.contextId &&
            row.permissionRequestId === request.permissionRequestId)
        if (existing === undefined) {
          yield* SubscriptionRef.update(substrate.permissionResponses, (rows) => [
            ...rows,
            request,
          ])
          yield* handleShapeCEvent(substrate, {
            _tag: "PermissionResponse",
            row: request,
          })
        }
        return {
          appended: existing === undefined,
          permissionRequestId: request.permissionRequestId,
          decision: request.decision,
        }
      }),
  },
})

// ── Composition entry the host facade uses ───────────────────────────────

export interface RuntimeRouteSet {
  readonly hostContextsCreate: ChannelRoute<CallableChannel<
    typeof HostContextsCreateRequestSchema,
    typeof HostContextsCreateResponseSchema
  >>
  readonly hostPrompt: ChannelRoute<EgressChannel<
    typeof HostPromptRequestSchema,
    RuntimeInputIntentRow
  >>
  readonly hostSessionsCreateOrLoad: ChannelRoute<CallableChannel<
    typeof SessionCreateOrLoadInputSchema,
    typeof SessionHandleReferenceSchema
  >>
  readonly hostSessionsStart: ChannelRoute<CallableChannel<
    typeof SessionStartInputSchema,
    typeof RuntimeStartRequestAckSchema
  >>
  readonly sessionPrompt: ChannelRoute<EgressChannel<
    typeof SessionPromptRequestSchema,
    RuntimeInputIntentRow
  >>
  readonly sessionAgentOutput: ChannelRoute<IngressChannel<
    typeof SessionAgentOutputRouteInputSchema
  >>
  readonly hostPermissionRespond: ChannelRoute<CallableChannel<
    typeof HostPermissionRespondRequestSchema,
    typeof HostPermissionRespondResponseSchema
  >>
}

export interface RuntimeRouteHandle {
  readonly routes: RuntimeRouteSet
}

export const makeRuntimeRoutes = (
  stubAgent: StubAgent = echoTerminalAgent,
): Effect.Effect<RuntimeRouteHandle> =>
  Effect.gen(function*() {
    const substrate = yield* makeSubstrate(stubAgent)
    return {
      routes: {
        hostContextsCreate: callableRoute(
          hostContextsCreateLive(substrate),
          "Create a RuntimeContext at a caller-allocated contextId (Launch shape).",
        ),
        hostPrompt: egressRoute(
          hostPromptLive(substrate),
          "Append a durable input intent for a context-keyed prompt (Launch shape).",
        ),
        hostSessionsCreateOrLoad: callableRoute(
          hostSessionsCreateOrLoadLive(substrate),
          "Find-or-create a session by external key; returns SessionHandleReference.",
        ),
        hostSessionsStart: callableRoute(
          hostSessionsStartLive(substrate),
          "Start the runtime for an already-created session; returns RuntimeStartRequestAck.",
        ),
        sessionPrompt: egressRoute(
          sessionPromptLive(substrate),
          "Append a durable input intent for a session; receipt is the stored intent row.",
        ),
        sessionAgentOutput: ingressRoute(
          sessionAgentOutputLive(substrate),
          "Wait_for typed session output observations after a cursor; carries TextChunk / PermissionRequest / Terminated.",
        ),
        hostPermissionRespond: callableRoute(
          hostPermissionRespondLive(substrate),
          "Resolve a pending PermissionRequest by id (host-scoped; contextId in request).",
        ),
      },
    }
  })

export const makeStubAgent = (
  hooks: {
    readonly onPrompt: StubAgent["onPrompt"]
    readonly onPermissionResponse?: StubAgent["onPermissionResponse"]
  },
): StubAgent => ({
  onPrompt: hooks.onPrompt,
  onPermissionResponse: hooks.onPermissionResponse ?? (() => Effect.void),
})
