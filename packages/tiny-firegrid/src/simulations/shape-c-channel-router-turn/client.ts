// Blackbox client facade — modeled on packages/client-sdk/src/firegrid.ts.
//
// This is the FULL client-shape compatibility boundary the Wave C
// dispatch contract has to preserve. Every method below mirrors a
// public method on the production `FiregridService` /
// `FiregridSessionsClient` / `FiregridSessionHandle` /
// `FiregridSessionPermissionsClient` / `FiregridPermissionsClient` /
// `FiregridSessionWaitClient` shapes.
//
// Mapping back to production channels (the Wave C dispatch contract):
//
//   client.launch                           → call("host.contexts.create")
//                                            HostContextsCreateChannel
//   client.prompt                           → send("host.prompt")
//                                            HostPromptChannel
//   client.sessions.createOrLoad            → call("host.sessions.create_or_load")
//                                            HostSessionsCreateOrLoadChannel
//   client.sessions.attach                  → (purely client-side handle
//                                              construction; no channel call —
//                                              matches production
//                                              client-sdk/firegrid.ts:attachSession)
//   client.open(contextId)                  → (purely client-side handle
//                                              construction over an existing
//                                              context id)
//   handle.start                            → call("host.sessions.start")
//                                            HostSessionsStartChannel
//   handle.prompt                           → send("session.prompt")
//                                            SessionPromptChannel
//                                            (per-session factory; sessionId
//                                             in input schema)
//   handle.wait.forAgentOutput              → waitFor("session.agent_output")
//                                            SessionAgentOutputChannel
//   handle.wait.forPermissionRequest        → waitFor("session.agent_output")
//                                            filtered for PermissionRequest
//                                            — matches production
//                                            client-sdk/firegrid.ts:743
//                                            waitForPermissionRequest, which
//                                            calls waitForAgentOutputObservation
//                                            with isPermissionRequest predicate.
//   handle.permissions.respond              → call("host.permissions.respond")
//                                            HostPermissionRespondChannel
//                                            (contextId baked from handle)
//   client.permissions.respond              → call("host.permissions.respond")
//                                            HostPermissionRespondChannel
//   client.watchContexts                    → OUT OF SCOPE for this sim;
//                                              production maps to
//                                              HostContextsChannel ingress
//                                              stream (`host.contexts`).
//                                              Adding it requires one more
//                                              route — see FINDING.md
//                                              "Out of scope".
//
// Internal rule: every method below lowers to ONLY
// `router.dispatch.{call, send, waitFor}` by string target. No direct
// route binding access, no handler/state imports, no
// `RuntimeObservationStreams` aggregator, no ambient `AgentSession`,
// no `WorkflowEngine`/`@effect/workflow`, no `@firegrid/runtime/kernel`
// equivalent. Asserted in `probe.test.ts`.

import { Chunk, Effect, Stream } from "effect"
import type { ChannelRouter } from "./router.ts"
import type {
  PermissionDecision,
  RuntimeRouteSet,
} from "./runtime-routes.ts"

// ── Router type the client facade accepts ────────────────────────────────

export type FiregridClientRouter = ChannelRouter<{
  readonly "host.contexts.create": RuntimeRouteSet["hostContextsCreate"]
  readonly "host.prompt": RuntimeRouteSet["hostPrompt"]
  readonly "host.sessions.create_or_load": RuntimeRouteSet["hostSessionsCreateOrLoad"]
  readonly "host.sessions.start": RuntimeRouteSet["hostSessionsStart"]
  readonly "session.prompt": RuntimeRouteSet["sessionPrompt"]
  readonly "session.agent_output": RuntimeRouteSet["sessionAgentOutput"]
  readonly "host.permissions.respond": RuntimeRouteSet["hostPermissionRespond"]
}>

// ── Public input/output types (modeled on firegrid.ts) ───────────────────

export interface PublicLaunchRequest {
  /**
   * Caller-allocated context id. Production calls `makeContextId()` if
   * the caller omits one (firegrid.ts:1023); the sim REQUIRES it
   * explicitly so the proof has no hidden randomness.
   */
  readonly contextId: string
}

export interface PublicPromptRequest {
  readonly contextId: string
  /** Deterministic input identity supplied by the caller. */
  readonly inputId: string
  readonly prompt: string
}

export interface SessionCreateOrLoadInput {
  readonly externalKey: { readonly source: string; readonly id: string }
}

export interface SessionAttachInput {
  readonly sessionId: string
}

export interface SessionHandlePromptInput {
  readonly inputId: string
  readonly prompt: string
}

export interface SessionAgentOutputWaitInput {
  readonly afterSequence?: number
}

export interface SessionPermissionRespondInput {
  readonly permissionRequestId: string
  readonly decision: PermissionDecision
}

export interface PermissionRespondInput {
  readonly contextId: string
  readonly permissionRequestId: string
  readonly decision: PermissionDecision
}

export interface RuntimeContextSnapshot {
  readonly contextId: string
}

export interface RuntimeContextHandle {
  readonly contextId: string
  readonly snapshot: Effect.Effect<RuntimeContextSnapshot, unknown>
  readonly prompt: (
    request: SessionHandlePromptInput,
  ) => Effect.Effect<unknown, unknown>
  readonly wait: FiregridSessionWaitClient
  readonly permissions: FiregridSessionPermissionsClient
}

export interface FiregridSessionWaitClient {
  readonly forAgentOutput: (
    request?: SessionAgentOutputWaitInput,
  ) => Effect.Effect<unknown, unknown>
  readonly forPermissionRequest: (
    request?: SessionAgentOutputWaitInput,
  ) => Effect.Effect<
    { readonly _tag: "PermissionRequest"; readonly permissionRequestId: string; readonly contextId: string; readonly sequence: number; readonly toolUseId: string },
    unknown
  >
}

export interface FiregridSessionPermissionsClient {
  readonly respond: (
    request: SessionPermissionRespondInput,
  ) => Effect.Effect<unknown, unknown>
}

export interface FiregridSessionHandle {
  readonly sessionId: string
  readonly contextId: string
  readonly start: () => Effect.Effect<
    { readonly contextId: string; readonly startedAt: string },
    unknown
  >
  readonly prompt: (
    request: SessionHandlePromptInput,
  ) => Effect.Effect<
    { readonly intentId: string; readonly contextId: string; readonly acceptedAt: string },
    unknown
  >
  readonly wait: FiregridSessionWaitClient
  readonly permissions: FiregridSessionPermissionsClient
  /**
   * Convenience driver: drives the full Sessions-shape turn through the
   * router. Equivalent to: start (if not yet started) → prompt → wait
   * through Terminated. Mirrors the per-turn shape a real client driver
   * would follow.
   */
  readonly runTurn: (
    request: SessionHandlePromptInput,
  ) => Effect.Effect<
    {
      readonly contextId: string
      readonly observations: ReadonlyArray<unknown>
      readonly terminalExitCode: number
    },
    unknown
  >
}

export interface FiregridSessionsClient {
  readonly createOrLoad: (
    request: SessionCreateOrLoadInput,
  ) => Effect.Effect<FiregridSessionHandle, unknown>
  readonly attach: (
    request: SessionAttachInput,
  ) => Effect.Effect<FiregridSessionHandle, unknown>
}

export interface FiregridPermissionsClient {
  readonly respond: (
    request: PermissionRespondInput,
  ) => Effect.Effect<unknown, unknown>
}

export interface FiregridClient {
  readonly launch: (
    request: PublicLaunchRequest,
  ) => Effect.Effect<RuntimeContextHandle, unknown>
  readonly prompt: (
    request: PublicPromptRequest,
  ) => Effect.Effect<unknown, unknown>
  readonly sessions: FiregridSessionsClient
  readonly permissions: FiregridPermissionsClient
  readonly open: (contextId: string) => RuntimeContextHandle
}

// ── Construction ─────────────────────────────────────────────────────────

export const makeFiregridClient = (
  router: FiregridClientRouter,
): FiregridClient => {
  // The seven dispatch primitives — every public method below lowers to
  // one of these. No other capability is closed over.
  const callHostContextsCreate = (req: PublicLaunchRequest) =>
    router.dispatch.call("host.contexts.create", { contextId: req.contextId })

  const sendHostPrompt = (req: PublicPromptRequest) =>
    // Translate the public field name (`prompt`) to the durable input
    // schema field name (`payload`). Production does the same at the
    // append site — public PublicPromptRequest -> durable input intent
    // row.
    router.dispatch.send("host.prompt", {
      contextId: req.contextId,
      inputId: req.inputId,
      payload: req.prompt,
    })

  const callSessionsCreateOrLoad = (req: SessionCreateOrLoadInput) =>
    router.dispatch.call("host.sessions.create_or_load", req)

  const callSessionsStart = (sessionId: string) =>
    router.dispatch.call("host.sessions.start", { sessionId })

  const sendSessionPrompt = (sessionId: string, req: SessionHandlePromptInput) =>
    router.dispatch.send("session.prompt", {
      sessionId,
      inputId: req.inputId,
      payload: req.prompt,
    })

  const waitForSessionAgentOutput = (contextId: string, afterSequence: number) =>
    router.dispatch.waitFor("session.agent_output", {
      contextId,
      afterSequence,
    })

  const callPermissionRespond = (req: PermissionRespondInput) =>
    router.dispatch.call("host.permissions.respond", req)

  const open = (contextId: string): RuntimeContextHandle => ({
    contextId,
    // Snapshot is reduced — production reads runtime tables (out of
    // scope: tables/* observation paths) and aggregates events / runs /
    // logs / agentOutputs. Sim returns the contextId only; the
    // observation path uses wait.forAgentOutput via the typed ingress
    // channel.
    snapshot: Effect.succeed({ contextId }),
    prompt: (request) =>
      sendSessionPrompt(contextId, request),
    wait: makeWaitClient(contextId),
    permissions: makeHandlePermissions(contextId),
  })

  const makeWaitClient = (contextId: string): FiregridSessionWaitClient => ({
    forAgentOutput: (request) =>
      waitForSessionAgentOutput(contextId, request?.afterSequence ?? -1).pipe(
        Stream.runHead,
        Effect.flatMap((opt) =>
          opt._tag === "Some"
            ? Effect.succeed(opt.value)
            : Effect.fail(new Error("wait.forAgentOutput: stream ended without observation"))),
      ),
    forPermissionRequest: (request) =>
      waitForSessionAgentOutput(contextId, request?.afterSequence ?? -1).pipe(
        // Filter the typed source by predicate — mirrors production
        // firegrid.ts:743 `waitForPermissionRequest`.
        Stream.filter((observation) =>
          (observation as { _tag: string })._tag === "PermissionRequest"),
        Stream.runHead,
        Effect.flatMap((opt) =>
          opt._tag === "Some"
            ? Effect.succeed(opt.value as {
                readonly _tag: "PermissionRequest"
                readonly permissionRequestId: string
                readonly contextId: string
                readonly sequence: number
                readonly toolUseId: string
              })
            : Effect.fail(new Error("wait.forPermissionRequest: stream ended without observation"))),
      ),
  })

  const makeHandlePermissions = (
    contextId: string,
  ): FiregridSessionPermissionsClient => ({
    respond: (request) =>
      callPermissionRespond({
        contextId,
        permissionRequestId: request.permissionRequestId,
        decision: request.decision,
      }),
  })

  const makeSessionHandle = (
    handle: { readonly sessionId: string; readonly contextId: string },
  ): FiregridSessionHandle => {
    const start: FiregridSessionHandle["start"] = () =>
      Effect.map(
        callSessionsStart(handle.sessionId),
        (ack) => ack as { readonly contextId: string; readonly startedAt: string },
      )

    const prompt: FiregridSessionHandle["prompt"] = (request) =>
      Effect.map(
        sendSessionPrompt(handle.sessionId, request),
        (receipt) => receipt as {
          readonly intentId: string
          readonly contextId: string
          readonly acceptedAt: string
        },
      )

    const wait = makeWaitClient(handle.contextId)
    const permissions = makeHandlePermissions(handle.contextId)

    const runTurn: FiregridSessionHandle["runTurn"] = (request) =>
      Effect.gen(function*() {
        yield* start()
        yield* prompt(request)
        const observations = yield* waitForSessionAgentOutput(handle.contextId, -1).pipe(
          Stream.takeUntil((observation) =>
            (observation as { _tag: string })._tag === "Terminated"),
          Stream.runCollect,
          Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
        )
        const terminal = observations.at(-1) as
          | { _tag: "Terminated"; exitCode: number }
          | undefined
        if (terminal === undefined || terminal._tag !== "Terminated") {
          return yield* Effect.fail(
            new Error("handle.runTurn: stream ended without Terminated observation"),
          )
        }
        return {
          contextId: handle.contextId,
          observations,
          terminalExitCode: terminal.exitCode,
        }
      })

    return {
      sessionId: handle.sessionId,
      contextId: handle.contextId,
      start,
      prompt,
      wait,
      permissions,
      runTurn,
    }
  }

  return {
    launch: (request) =>
      Effect.gen(function*() {
        // Mirrors firegrid.ts:1023: client allocates contextId, calls
        // host.contexts.create, then returns a handle over it.
        yield* callHostContextsCreate(request)
        return open(request.contextId)
      }),
    prompt: (request) => sendHostPrompt(request),
    sessions: {
      createOrLoad: (request) =>
        Effect.gen(function*() {
          const response = (yield* callSessionsCreateOrLoad(request)) as {
            sessionId: string
            contextId: string
          }
          return makeSessionHandle(response)
        }),
      // Pure client-side: no channel call. Production
      // (firegrid.ts:attachSession) wraps a known sessionId. Caller
      // promises the session/context already exists.
      attach: (request) =>
        Effect.succeed(makeSessionHandle({
          sessionId: request.sessionId,
          contextId: request.sessionId,
        })),
    },
    permissions: {
      respond: (request) => callPermissionRespond(request),
    },
    open,
  }
}
