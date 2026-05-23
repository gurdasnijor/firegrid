// Shape C Wave C — channel/router thesis probe (blackbox client).
//
// Validates the existing-docs design:
//
//   - SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md
//   - docs/cannon/architecture/runtime-pipeline-type-boundaries.md
//   - docs/cannon/architecture/runtime-design-constraints.md
//   - docs/architecture/host-sdk-runtime-boundary.md
//
// The blackbox driving the turn is `client.ts`, a tiny facade modeled
// on `packages/client-sdk/src/firegrid.ts`. The facade exposes the full
// client compatibility boundary (launch, prompt, sessions.createOrLoad,
// sessions.attach, open, session.start, session.prompt, session.wait.*,
// session.permissions.respond, permissions.respond) and dispatches
// every method through `router.dispatch.{call, send, waitFor}` by
// string target only.
//
// Production target mapping (PRODUCTION CHANNEL → ROUTER VERB):
//
//   client.launch                       → call("host.contexts.create")
//   client.prompt                       → send("host.prompt")
//   client.sessions.createOrLoad        → call("host.sessions.create_or_load")
//   client.sessions.attach              → (purely client-side handle)
//   handle.start                        → call("host.sessions.start")
//   handle.prompt                       → send("session.prompt")
//   handle.wait.forAgentOutput          → waitFor("session.agent_output")
//   handle.wait.forPermissionRequest    → waitFor("session.agent_output")
//                                         filtered for PermissionRequest
//   handle.permissions.respond          → call("host.permissions.respond")
//   client.permissions.respond          → call("host.permissions.respond")
//   client.watchContexts                → OUT OF SCOPE (would add host.contexts
//                                         ingress; see FINDING.md)

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  composeFiregridHost,
} from "../../src/simulations/shape-c-channel-router-turn/host-facade.ts"
import {
  makeFiregridClient,
} from "../../src/simulations/shape-c-channel-router-turn/client.ts"
import {
  runEdgeTurn,
} from "../../src/simulations/shape-c-channel-router-turn/edge.ts"
import {
  HostContextsCreateRequestSchema,
  HostContextsCreateResponseSchema,
  HostContextsCreateTarget,
  HostPermissionRespondRequestSchema,
  HostPermissionRespondResponseSchema,
  HostPermissionRespondTarget,
  HostPromptRequestSchema,
  HostPromptTarget,
  HostSessionsCreateOrLoadTarget,
  HostSessionsStartTarget,
  makeRuntimeRoutes,
  makeStubAgent,
  SessionAgentOutputTarget,
  SessionPromptTarget,
} from "../../src/simulations/shape-c-channel-router-turn/runtime-routes.ts"
import { channelRouter } from "../../src/simulations/shape-c-channel-router-turn/router.ts"

// ── File text under inspection for the negative guards ─────────────────

const simDir = resolve(
  import.meta.dirname,
  "../../src/simulations/shape-c-channel-router-turn",
)

const hostFacadeSource = readFileSync(resolve(simDir, "host-facade.ts"), "utf8")
const edgeSource = readFileSync(resolve(simDir, "edge.ts"), "utf8")
const clientSource = readFileSync(resolve(simDir, "client.ts"), "utf8")
const runtimeRoutesSource = readFileSync(resolve(simDir, "runtime-routes.ts"), "utf8")
const indexSource = readFileSync(resolve(simDir, "index.ts"), "utf8")

const importLines = (source: string): string => {
  const start = source.indexOf("\nimport ")
  if (start < 0) return ""
  const end = source.lastIndexOf("\nimport ")
  const lastImportEnd = source.indexOf("\n", end + 1)
  return source.slice(start, lastImportEnd < 0 ? source.length : lastImportEnd)
}

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

const hostFacadeImports = importLines(hostFacadeSource)
const hostFacadeBody = stripComments(hostFacadeSource)
const edgeImports = importLines(edgeSource)
const edgeBody = stripComments(edgeSource)
const clientImports = importLines(clientSource)
const clientBody = stripComments(clientSource)
const runtimeRoutesBody = stripComments(runtimeRoutesSource)
const indexBody = stripComments(indexSource)

// ── POSITIVE: blackbox client turn proofs ─────────────────────────────

describe("shape-c-channel-router-turn: positive turn proof (Launch + prompt shape)", () => {
  it("client.launch → client.prompt → handle.wait.forAgentOutput drives a public turn through the router", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        const client = makeFiregridClient(router)
        const handle = yield* client.launch({ contextId: "ctx_launch_turn_1" })
        yield* client.prompt({
          contextId: handle.contextId,
          inputId: "input_launch_turn_1",
          prompt: "hello-launch",
        })
        return yield* handle.wait.forAgentOutput({ afterSequence: -1 })
      }),
    )
    // First observation is the TextChunk; client iterates forward via
    // afterSequence in a real driver. Here one wait_for call returns
    // the head observation.
    expect((result as { _tag: string })._tag).toBe("TextChunk")
  })

  it("Launch + prompt: full drive through Terminated using afterSequence loop", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        const client = makeFiregridClient(router)
        const handle = yield* client.launch({ contextId: "ctx_launch_turn_2" })
        yield* client.prompt({
          contextId: handle.contextId,
          inputId: "input_launch_turn_2",
          prompt: "hello-launch",
        })
        const collected: Array<{ _tag: string; sequence: number }> = []
        let cursor = -1
        for (let step = 0; step < 8; step += 1) {
          const obs = (yield* handle.wait.forAgentOutput({ afterSequence: cursor })) as {
            _tag: string
            sequence: number
          }
          collected.push(obs)
          cursor = obs.sequence
          if (obs._tag === "Terminated") break
        }
        return collected
      }),
    )
    expect(result.map((r) => r._tag)).toEqual(["TextChunk", "Terminated"])
  })
})

describe("shape-c-channel-router-turn: positive turn proof (Sessions shape)", () => {
  it("client.sessions.createOrLoad → handle.start → handle.prompt → handle.wait drives a public turn through the router", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        const client = makeFiregridClient(router)
        const handle = yield* client.sessions.createOrLoad({
          externalKey: { source: "test", id: "sessions-shape-1" },
        })
        return yield* handle.runTurn({
          inputId: "input_sessions_turn_1",
          prompt: "hello",
        })
      }),
    )
    expect(result.observations).toHaveLength(2)
    expect((result.observations[0] as { _tag: string })._tag).toBe("TextChunk")
    expect((result.observations[1] as { _tag: string })._tag).toBe("Terminated")
    expect(result.terminalExitCode).toBe(0)
  })

  it("client.sessions.createOrLoad is idempotent on externalKey", async () => {
    const handles = await Effect.runPromise(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        const client = makeFiregridClient(router)
        const first = yield* client.sessions.createOrLoad({
          externalKey: { source: "test", id: "idempotent-key" },
        })
        const second = yield* client.sessions.createOrLoad({
          externalKey: { source: "test", id: "idempotent-key" },
        })
        return { first, second }
      }),
    )
    expect(handles.first.sessionId).toBe(handles.second.sessionId)
    expect(handles.first.contextId).toBe(handles.second.contextId)
  })

  it("client.sessions.attach is purely client-side (returns a handle without channel calls)", async () => {
    const handle = await Effect.runPromise(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        const client = makeFiregridClient(router)
        return yield* client.sessions.attach({ sessionId: "sess_attach_1" })
      }),
    )
    expect(handle.sessionId).toBe("sess_attach_1")
    expect(handle.contextId).toBe("sess_attach_1")
  })

  it("client.open returns a handle for an existing contextId", async () => {
    const router = await Effect.runPromise(composeFiregridHost)
    const client = makeFiregridClient(router)
    const handle = client.open("ctx_pre_existing_42")
    expect(handle.contextId).toBe("ctx_pre_existing_42")
  })
})

// ── PERMISSION ROUND-TRIP ──────────────────────────────────────────────

describe("shape-c-channel-router-turn: permission round-trip", () => {
  it("handle.wait.forPermissionRequest → handle.permissions.respond → continuation through router (no new route)", async () => {
    // Stub agent: first prompt emits a PermissionRequest (no Terminated
    // yet); when the matching permission response arrives, emit
    // TextChunk + Terminated.
    const stubAgent = makeStubAgent({
      onPrompt: (contextId, _payload, fixture) =>
        fixture.append({
          _tag: "PermissionRequest",
          contextId,
          sequence: -1,
          permissionRequestId: "pr_42",
          toolUseId: "tu_42",
        }),
      onPermissionResponse: (contextId, _permissionRequestId, decision, fixture) =>
        Effect.gen(function*() {
          if (decision !== "allow") return
          yield* fixture.append({
            _tag: "TextChunk",
            contextId,
            sequence: -1,
            text: "approved-continuation",
          })
          yield* fixture.append({
            _tag: "Terminated",
            contextId,
            sequence: -1,
            exitCode: 0,
          })
        }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* makeRuntimeRoutes(stubAgent)
        const router = channelRouter({
          "host.contexts.create": runtime.routes.hostContextsCreate,
          "host.prompt": runtime.routes.hostPrompt,
          "host.sessions.create_or_load": runtime.routes.hostSessionsCreateOrLoad,
          "host.sessions.start": runtime.routes.hostSessionsStart,
          "session.prompt": runtime.routes.sessionPrompt,
          "session.agent_output": runtime.routes.sessionAgentOutput,
          "host.permissions.respond": runtime.routes.hostPermissionRespond,
        })
        const client = makeFiregridClient(router)
        const handle = yield* client.sessions.createOrLoad({
          externalKey: { source: "test", id: "perm-round-trip-1" },
        })
        yield* handle.start()
        yield* handle.prompt({
          inputId: "input_perm_turn_1",
          prompt: "trigger-permission",
        })

        // Wait for the PermissionRequest observation (filtered from
        // session.agent_output).
        const permissionRequest = yield* handle.wait.forPermissionRequest({
          afterSequence: -1,
        })

        // Respond via the session-scoped permissions client (which
        // lowers to host.permissions.respond with contextId from the
        // handle).
        yield* handle.permissions.respond({
          permissionRequestId: permissionRequest.permissionRequestId,
          decision: "allow",
        })

        // Continuation: collect observations strictly after the
        // PermissionRequest until Terminated.
        const collected: Array<{ _tag: string; sequence: number }> = []
        let cursor = permissionRequest.sequence
        for (let step = 0; step < 8; step += 1) {
          const obs = (yield* handle.wait.forAgentOutput({ afterSequence: cursor })) as {
            _tag: string
            sequence: number
          }
          collected.push(obs)
          cursor = obs.sequence
          if (obs._tag === "Terminated") break
        }
        return { permissionRequest, continuation: collected }
      }),
    )

    expect(result.permissionRequest._tag).toBe("PermissionRequest")
    expect(result.permissionRequest.permissionRequestId).toBe("pr_42")
    expect(result.continuation.map((o) => o._tag))
      .toEqual(["TextChunk", "Terminated"])
  })

  it("client.permissions.respond (top-level) also resolves the request via host.permissions.respond", async () => {
    const stubAgent = makeStubAgent({
      onPrompt: (contextId, _payload, fixture) =>
        fixture.append({
          _tag: "PermissionRequest",
          contextId,
          sequence: -1,
          permissionRequestId: "pr_top_level",
          toolUseId: "tu_top_level",
        }),
      onPermissionResponse: (contextId, _permissionRequestId, _decision, fixture) =>
        fixture.append({
          _tag: "Terminated",
          contextId,
          sequence: -1,
          exitCode: 0,
        }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* makeRuntimeRoutes(stubAgent)
        const router = channelRouter({
          "host.contexts.create": runtime.routes.hostContextsCreate,
          "host.prompt": runtime.routes.hostPrompt,
          "host.sessions.create_or_load": runtime.routes.hostSessionsCreateOrLoad,
          "host.sessions.start": runtime.routes.hostSessionsStart,
          "session.prompt": runtime.routes.sessionPrompt,
          "session.agent_output": runtime.routes.sessionAgentOutput,
          "host.permissions.respond": runtime.routes.hostPermissionRespond,
        })
        const client = makeFiregridClient(router)
        const handle = yield* client.launch({ contextId: "ctx_perm_top_1" })
        yield* client.prompt({
          contextId: handle.contextId,
          inputId: "input_perm_top_1",
          prompt: "trigger",
        })
        const permissionRequest = yield* handle.wait.forPermissionRequest({
          afterSequence: -1,
        })
        yield* client.permissions.respond({
          contextId: handle.contextId,
          permissionRequestId: permissionRequest.permissionRequestId,
          decision: "allow",
        })
        return yield* handle.wait.forAgentOutput({
          afterSequence: permissionRequest.sequence,
        })
      }),
    )
    expect((result as { _tag: string })._tag).toBe("Terminated")
  })
})

// ── ERROR OBSERVATION ──────────────────────────────────────────────────
//
// The body-side error question CC1 was blocked on: can a client-shaped host
// facade observe a runtime/agent error through the existing channel-router
// path using `session.agent_output` `wait_for` / typed observation, without
// direct handler calls, a runtime observation stream, a new router surface,
// or the workflow body driver?
//
// Production already encodes this shape:
//   - `AgentErrorEventSchema` is a variant of `AgentOutputEvent`
//     (`packages/protocol/src/agent-output/schema.ts:` — `_tag: "Error"`,
//     `cause: Unknown`, `recoverable: Boolean`).
//   - `RuntimeAgentOutputObservationSchema` is a tagged union over those
//     variants, including `_tag: "Error"` (`packages/protocol/src/
//     session-facade/schema.ts:319-322`).
//   - Production runtime codecs already emit recoverable Error events into
//     the per-context output stream — see `recoverableError` in
//     `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:42`
//     and `.../codecs/acp/index.ts:123`.
//   - `SessionAgentOutputChannel.forContext(contextId)` projects that
//     stream as an `IngressChannel`; the `session.agent_output` route on
//     `HostPlaneChannelRouter` exposes the corresponding `wait_for` verb
//     (#703 landed the last mapping).
//
// The error case is therefore the same "filtered typed source" production
// already uses for `PermissionRequest` (see `firegrid.ts:743`
// `waitForPermissionRequest`). The SDD's stance is C6: typed source +
// cursor + match. No `session.error` route, no separate body-side error
// channel, no mailbox.

describe("shape-c-channel-router-turn: error observation", () => {
  it("agent error reaches the client through session.agent_output filtered for _tag === \"Error\" (no new route)", async () => {
    // Stub agent: prompt yields a recoverable Error observation, then
    // Terminated with a non-zero exit code. Mirrors what production codecs
    // do for a transient agent failure (cf. `recoverableError` in
    // `packages/runtime/src/agent-event-pipeline/codecs/{stdio-jsonl,acp}/index.ts`).
    const stubAgent = makeStubAgent({
      onPrompt: (contextId, _payload, fixture) =>
        Effect.gen(function*() {
          yield* fixture.append({
            _tag: "Error",
            contextId,
            sequence: -1,
            cause: { message: "agent transport failed", code: "EAGENT" },
            recoverable: true,
          })
          yield* fixture.append({
            _tag: "Terminated",
            contextId,
            sequence: -1,
            exitCode: 1,
          })
        }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* makeRuntimeRoutes(stubAgent)
        const router = channelRouter({
          "host.contexts.create": runtime.routes.hostContextsCreate,
          "host.prompt": runtime.routes.hostPrompt,
          "host.sessions.create_or_load": runtime.routes.hostSessionsCreateOrLoad,
          "host.sessions.start": runtime.routes.hostSessionsStart,
          "session.prompt": runtime.routes.sessionPrompt,
          "session.agent_output": runtime.routes.sessionAgentOutput,
          "host.permissions.respond": runtime.routes.hostPermissionRespond,
        })
        const client = makeFiregridClient(router)
        const handle = yield* client.sessions.createOrLoad({
          externalKey: { source: "test", id: "error-observation-1" },
        })
        yield* handle.start()
        yield* handle.prompt({
          inputId: "input_error_turn_1",
          prompt: "trigger-failure",
        })

        // Filter-by-_tag mirrors production's `forPermissionRequest`
        // (`firegrid.ts:743`): drive `forAgentOutput`, check the union
        // tag, advance the cursor. No `forAgentError` method is needed
        // on the client surface; the typed source carries the variant.
        const collected: Array<{ _tag: string; sequence: number }> = []
        let cursor = -1
        let errorObservation: {
          readonly _tag: "Error"
          readonly contextId: string
          readonly sequence: number
          readonly cause: unknown
          readonly recoverable: boolean
        } | undefined
        for (let step = 0; step < 8; step += 1) {
          const obs = (yield* handle.wait.forAgentOutput({ afterSequence: cursor })) as {
            _tag: string
            sequence: number
          }
          collected.push(obs)
          if (obs._tag === "Error") {
            errorObservation = obs as typeof errorObservation
          }
          cursor = obs.sequence
          if (obs._tag === "Terminated") break
        }
        return { collected, errorObservation }
      }),
    )

    // Existing typed source carries the Error variant — proves the
    // body-side error behavior is observable through `session.agent_output`
    // with no new route, no observation-stream surface, no workflow body.
    expect(result.collected.map((o) => o._tag)).toEqual(["Error", "Terminated"])
    expect(result.errorObservation).toBeDefined()
    expect(result.errorObservation?._tag).toBe("Error")
    expect(result.errorObservation?.recoverable).toBe(true)
    expect(result.errorObservation?.cause).toEqual({
      message: "agent transport failed",
      code: "EAGENT",
    })
  })

  it("error observation is dispatched ONLY through the existing session.agent_output route (no parallel error route)", async () => {
    // Structural assertion: when the agent emits an Error event, the client
    // observes it via `wait_for("session.agent_output")` and the router
    // exposes EXACTLY the same 7 targets it already exposes. No "session.error"
    // / "session.error_output" / "session.runtime_error" route is registered.
    const stubAgent = makeStubAgent({
      onPrompt: (contextId, _payload, fixture) =>
        fixture.append({
          _tag: "Error",
          contextId,
          sequence: -1,
          cause: { message: "non-recoverable" },
          recoverable: false,
        }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* makeRuntimeRoutes(stubAgent)
        const router = channelRouter({
          "host.contexts.create": runtime.routes.hostContextsCreate,
          "host.prompt": runtime.routes.hostPrompt,
          "host.sessions.create_or_load": runtime.routes.hostSessionsCreateOrLoad,
          "host.sessions.start": runtime.routes.hostSessionsStart,
          "session.prompt": runtime.routes.sessionPrompt,
          "session.agent_output": runtime.routes.sessionAgentOutput,
          "host.permissions.respond": runtime.routes.hostPermissionRespond,
        })
        // Catalog the routes — proves the router's exposed surface is
        // unchanged when the Error variant joins the typed source.
        const exposedTargets = Object.keys(router.routes).sort()
        const client = makeFiregridClient(router)
        const handle = yield* client.sessions.createOrLoad({
          externalKey: { source: "test", id: "error-observation-2" },
        })
        yield* handle.start()
        yield* handle.prompt({
          inputId: "input_error_turn_2",
          prompt: "trigger-failure",
        })
        const observation = (yield* handle.wait.forAgentOutput({
          afterSequence: -1,
        })) as {
          _tag: string
          sequence: number
          recoverable?: boolean
        }
        return { exposedTargets, observation }
      }),
    )

    // No new error-specific route was introduced.
    expect(result.exposedTargets).toEqual([
      "host.contexts.create",
      "host.permissions.respond",
      "host.prompt",
      "host.sessions.create_or_load",
      "host.sessions.start",
      "session.agent_output",
      "session.prompt",
    ])
    expect(result.observation._tag).toBe("Error")
    expect(result.observation.recoverable).toBe(false)
  })
})

// ── ROUTER REJECTIONS ──────────────────────────────────────────────────

describe("shape-c-channel-router-turn: router rejections", () => {
  it("router rejects the wrong verb against a route direction", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        return yield* router.dispatch.send(String(HostSessionsCreateOrLoadTarget), {})
      }),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("ChannelRouteVerbNotSupported")
    }
  })

  it("router rejects an unknown target string", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        return yield* router.dispatch.call("does.not.exist", {})
      }),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("ChannelRouteNotFound")
    }
  })
})

// ── LOW-LEVEL EDGE PARITY ──────────────────────────────────────────────

describe("shape-c-channel-router-turn: low-level edge parity", () => {
  it("edge.runEdgeTurn drives the Sessions turn at the raw-dispatch tier", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const router = yield* composeFiregridHost
        return yield* runEdgeTurn(router, {
          externalKey: { source: "test", id: "edge-parity-1" },
          inputId: "input_edge_parity_1",
          prompt: "hello",
        })
      }),
    )
    expect(result.observations).toHaveLength(2)
    expect((result.observations[0] as { _tag: string })._tag).toBe("TextChunk")
    expect((result.observations[1] as { _tag: string })._tag).toBe("Terminated")
    expect(result.terminalExitCode).toBe(0)
  })
})

// ── PRODUCTION TARGET MAPPING (asserted at the data level + body text) ──

describe("shape-c-channel-router-turn: production target mapping", () => {
  it("the seven target constants are exactly the production literals from packages/protocol/src/channels/*", () => {
    expect(String(HostContextsCreateTarget)).toBe("host.contexts.create")
    expect(String(HostPromptTarget)).toBe("host.prompt")
    expect(String(HostSessionsCreateOrLoadTarget)).toBe("host.sessions.create_or_load")
    expect(String(HostSessionsStartTarget)).toBe("host.sessions.start")
    expect(String(SessionPromptTarget)).toBe("session.prompt")
    expect(String(SessionAgentOutputTarget)).toBe("session.agent_output")
    expect(String(HostPermissionRespondTarget)).toBe("host.permissions.respond")
  })

  it("the public schemas for the three Launch-shape + permission-respond targets are exported on the runtime route surface", () => {
    // These are the schemas a route Live or an edge would need to
    // import to encode/decode their payloads. The Sessions-shape
    // schemas are exercised via the higher-level proofs above.
    expect(HostContextsCreateRequestSchema).toBeDefined()
    expect(HostContextsCreateResponseSchema).toBeDefined()
    expect(HostPromptRequestSchema).toBeDefined()
    expect(HostPermissionRespondRequestSchema).toBeDefined()
    expect(HostPermissionRespondResponseSchema).toBeDefined()
  })

  it("client.ts hardcodes the (verb, target) pair for each public method", () => {
    // Renaming a target without updating the proof fails the test loud —
    // Wave C re-resolution required.
    expect(clientBody).toContain("router.dispatch.call(\"host.contexts.create\"")
    expect(clientBody).toContain("router.dispatch.send(\"host.prompt\"")
    expect(clientBody).toContain("router.dispatch.call(\"host.sessions.create_or_load\"")
    expect(clientBody).toContain("router.dispatch.call(\"host.sessions.start\"")
    expect(clientBody).toContain("router.dispatch.send(\"session.prompt\"")
    expect(clientBody).toContain("router.dispatch.waitFor(\"session.agent_output\"")
    expect(clientBody).toContain("router.dispatch.call(\"host.permissions.respond\"")
  })

  it("host facade composes exactly the seven production-keyed routes", () => {
    expect(hostFacadeBody).toContain("\"host.contexts.create\"")
    expect(hostFacadeBody).toContain("\"host.prompt\"")
    expect(hostFacadeBody).toContain("\"host.sessions.create_or_load\"")
    expect(hostFacadeBody).toContain("\"host.sessions.start\"")
    expect(hostFacadeBody).toContain("\"session.prompt\"")
    expect(hostFacadeBody).toContain("\"session.agent_output\"")
    expect(hostFacadeBody).toContain("\"host.permissions.respond\"")
  })

  it("wait.forPermissionRequest reuses session.agent_output ingress filtered by predicate (no new route)", () => {
    // Mirrors production firegrid.ts:743 — waitForPermissionRequest is
    // implemented as waitForAgentOutputObservation with an
    // isPermissionRequest predicate. No `session.permission_request`
    // route exists in production; this guard records that decision.
    expect(clientBody).toContain("forPermissionRequest")
    expect(clientBody).toContain("Stream.filter")
    expect(clientBody).toContain("\"PermissionRequest\"")
    // Verify the filter call sits on the session.agent_output stream
    // — i.e. the dispatch + filter live in the same forPermissionRequest
    // closure. Cheap structural check: forPermissionRequest's body must
    // contain both the dispatch call and the predicate filter.
    const fnStart = clientBody.indexOf("forPermissionRequest: (request)")
    const fnEnd = fnStart >= 0
      ? clientBody.indexOf("  })", fnStart)
      : -1
    const fnBody = fnStart >= 0 && fnEnd > fnStart
      ? clientBody.slice(fnStart, fnEnd)
      : ""
    expect(fnBody).toContain("waitForSessionAgentOutput")
    expect(fnBody).toContain("\"PermissionRequest\"")
  })
})

// ── NEGATIVE GUARDS ────────────────────────────────────────────────────

describe("shape-c-channel-router-turn: negative guards (file-text)", () => {
  // Common banned-symbol set for any module that should be dispatch-only.
  const bannedFromDispatchOnly = [
    // sim-local handler + state names
    "handleShapeCEvent",
    "RuntimeContextStateStore",
    "RuntimeContextEventState",
    "RuntimeSessionState",
    // production-equivalent legacy symbols the rebuild must shed
    "RuntimeContextWorkflowNative",
    "RuntimeContextWorkflowNativeLayer",
    "RuntimeContextWorkflowRuntime",
    "executeRuntimeContextWorkflow",
    "runtimeInputDeferredName",
    // generic stream aggregator (Cannon §6 / C6)
    "RuntimeObservationStreams",
    "callerFact",
    // ambient AgentSession (Cannon §1)
    "AgentSession",
    // workflow machinery (C2, C5)
    "WorkflowEngine",
    "WorkflowInstance",
    "Activity.make",
    "DurableDeferred",
    "DurableClock",
    "@effect/workflow",
    // kernel barrel (Cannon §6)
    "@firegrid/runtime/kernel",
  ]

  it("host-facade.ts imports neither handler/state nor any banned capability", () => {
    for (const banned of bannedFromDispatchOnly) {
      expect(hostFacadeImports).not.toContain(banned)
      expect(hostFacadeBody).not.toContain(banned)
    }
  })

  it("edge.ts uses router.dispatch by string target only", () => {
    const extra = ["makeRuntimeRoutes"]
    for (const banned of [...bannedFromDispatchOnly, ...extra]) {
      expect(edgeImports).not.toContain(banned)
      expect(edgeBody).not.toContain(banned)
    }
  })

  it("client.ts (blackbox client facade) is dispatch-only — the load-bearing 5th negative guard", () => {
    const extra = ["makeRuntimeRoutes"]
    for (const banned of [...bannedFromDispatchOnly, ...extra]) {
      expect(clientImports).not.toContain(banned)
      expect(clientBody).not.toContain(banned)
    }
    // No Math.random / randomUUID — deterministic input ids only.
    expect(clientBody).not.toContain("Math.random")
    expect(clientBody).not.toContain("randomUUID")
  })

  it("edge.ts contains no Math.random / randomUUID — deterministic input ids only", () => {
    expect(edgeBody).not.toContain("Math.random")
    expect(edgeBody).not.toContain("randomUUID")
  })

  it("runtime-routes.ts exposes per-target typed channels — no generic aggregator", () => {
    const forbiddenAggregators = [
      "RuntimeObservationStreams",
      "callerFact",
      "RuntimeAgentOutputAfterEvents",
    ]
    for (const banned of forbiddenAggregators) {
      expect(runtimeRoutesBody).not.toContain(banned)
    }
    // The runtime-side re-export surface is bounded.
    expect(indexBody).not.toContain("handleShapeCEvent")
    expect(indexBody).not.toContain("RuntimeContextStateStore")
    expect(indexBody).not.toContain("RuntimeContextEventState")
    expect(indexBody).not.toContain("RuntimeSessionState")
  })

  it("runtime-side Shape C handler signature names no WorkflowEngine / Activity.make / DurableDeferred / ambient AgentSession", () => {
    const forbiddenInRuntime = [
      "WorkflowEngine",
      "WorkflowInstance",
      "Activity.make",
      "DurableDeferred",
      "DurableClock",
      "@effect/workflow",
      "AgentSession",
      "@firegrid/runtime/kernel",
    ]
    for (const banned of forbiddenInRuntime) {
      expect(runtimeRoutesBody).not.toContain(banned)
    }
  })
})

// ── NEGATIVE GUARD via type-level construction ─────────────────────────

describe("shape-c-channel-router-turn: negative guards (type-level)", () => {
  it("composeFiregridHost.R is `never` (host facade has no runtime-substrate capability requirement)", () => {
    type ComposeR = Effect.Effect.Context<typeof composeFiregridHost>
    const assertNever = (_: ComposeR extends never ? true : false): void => undefined
    assertNever(true)
    expect(true).toBe(true)
  })
})
