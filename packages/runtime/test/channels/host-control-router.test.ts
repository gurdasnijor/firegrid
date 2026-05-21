import { DurableStreamTestServer } from "@durable-streams/server"
import {
  ChannelRouteVerbNotSupported,
} from "@firegrid/protocol/channels/router"
import {
  HostContextsCreateChannelTarget,
  HostPermissionRespondChannelTarget,
  HostPromptChannelTarget,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsStartChannelTarget,
  SessionPromptChannelTarget,
} from "@firegrid/protocol/channels"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  local,
  makeHostSessionRow,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { Effect, Layer, ParseResult } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ChannelRouteInvocationFailed,
  HostPlaneChannelRouter,
  RuntimeHostControlChannelsLive,
} from "../../src/channels/index.ts"
import {
  HostKernelControlPlane,
  type HostKernelIntent,
} from "../../src/kernel/index.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const controlPlaneLayer = (namespace: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: baseUrl!,
        namespace,
      }),
      contentType: "application/json",
    },
  })

const hostIdForNamespace = (namespace: string) => `${namespace}_host` as HostId

const hostKernelSignalLayer = (
  namespace: string,
  signals: Array<HostKernelIntent>,
) =>
  Layer.mergeAll(
    Layer.succeed(
      CurrentHostSession,
      makeHostSessionRow({
        hostId: hostIdForNamespace(namespace),
        hostSessionId: `${namespace}_session` as HostSessionId,
        namespace,
        startedAtMs: Date.now(),
      }),
    ),
    Layer.succeed(HostKernelControlPlane, {
      signal: (hostId, intent) =>
        Effect.sync(() => {
          signals.push(intent)
          return {
            hostId,
            sequence: signals.length - 1,
            requestId: intent.requestId,
            accepted: true,
          }
        }),
    }),
  )

const runWithRouter = <A, E>(
  namespace: string,
  effect: Effect.Effect<A, E, HostPlaneChannelRouter | RuntimeControlPlaneTable>,
  signals: Array<HostKernelIntent> = [],
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          RuntimeHostControlChannelsLive.pipe(
            Layer.provideMerge(controlPlaneLayer(namespace)),
            Layer.provideMerge(hostKernelSignalLayer(namespace, signals)),
          ),
        ),
      ),
    ),
  )

const insertRuntimeContext = (
  contextId: string,
  namespace: string,
): Effect.Effect<void, unknown, RuntimeControlPlaneTable> => {
  const hostId = hostIdForNamespace(namespace)
  const row = {
    contextId,
    createdAt: new Date().toISOString(),
    runtime: normalizeRuntimeIntent(local.jsonl({
      argv: [process.execPath, "--version"],
    })),
    host: {
      hostId,
      streamPrefix: makeHostStreamPrefix({ namespace, hostId }),
      boundAtMs: Date.now(),
    },
  }
  return Effect.flatMap(
    RuntimeControlPlaneTable,
    control =>
      Effect.asVoid(
        control.contexts.upsert(row) as Effect.Effect<unknown, unknown>,
      ),
  ) as Effect.Effect<void, unknown, RuntimeControlPlaneTable>
}

interface HostControlDispatchObserved {
  readonly created: unknown
  readonly createdSession: unknown
  readonly hostPrompt: unknown
  readonly sessionPrompt: unknown
  readonly started: unknown
  readonly permission: unknown
}

describe("host-plane channel router", () => {
  it("rejects a verb that the route direction does not support", async () => {
    const namespace = `router-invalid-verb-${crypto.randomUUID()}`

    const result = await runWithRouter(
      namespace,
      Effect.either(Effect.gen(function*() {
        const router = yield* HostPlaneChannelRouter
        return yield* router.dispatch({
          target: HostPromptChannelTarget,
          verb: "call",
          payload: {},
        })
      })),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ChannelRouteVerbNotSupported)
    }
  })

  it("surfaces protocol Schema parse failures before route invocation", async () => {
    const namespace = `router-parse-${crypto.randomUUID()}`

    const result = await runWithRouter(
      namespace,
      Effect.either(Effect.gen(function*() {
        const router = yield* HostPlaneChannelRouter
        return yield* router.dispatch({
          target: HostPromptChannelTarget,
          verb: "send",
          payload: { contextId: 1, payload: "bad" },
        })
      })),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ParseResult.ParseError)
    }
  })

  it("wraps route invocation failures in a structured dispatch error", async () => {
    const namespace = `router-invocation-${crypto.randomUUID()}`
    const contextId = `ctx_${crypto.randomUUID()}`

    const result = await runWithRouter(
      namespace,
      Effect.either(Effect.gen(function*() {
        const router = yield* HostPlaneChannelRouter
        return yield* router.dispatch({
          target: HostPromptChannelTarget,
          verb: "send",
          payload: {
            contextId,
            payload: "host prompt before context exists",
            idempotencyKey: "missing-context-prompt",
          },
        })
      })),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ChannelRouteInvocationFailed)
      expect(result.left).toMatchObject({
        target: HostPromptChannelTarget,
        verb: "send",
        cause: {
          _tag: "ContextNotFound",
          contextId,
        },
      })
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.6 dispatches host-control create/start routes into the host kernel signal boundary", async () => {
    const namespace = `router-host-control-${crypto.randomUUID()}`
    const contextId = `ctx_${crypto.randomUUID()}`
    const signals: Array<HostKernelIntent> = []

    const dispatchHostControlRoutes: Effect.Effect<
      HostControlDispatchObserved,
      unknown,
      HostPlaneChannelRouter | RuntimeControlPlaneTable
    > =
      Effect.gen(function*() {
        const router = yield* HostPlaneChannelRouter
        const runtime = local.jsonl({
          argv: [process.execPath, "--version"],
        })
        const created = yield* router.dispatch({
          target: HostContextsCreateChannelTarget,
          verb: "call",
          payload: { contextId, runtime, createdBy: "router-test" },
        })
        const createdSession = yield* router.dispatch({
          target: HostSessionsCreateOrLoadChannelTarget,
          verb: "call",
          payload: {
            externalKey: {
              source: "router-test",
              id: contextId,
            },
            runtime,
            createdBy: "router-test",
          },
        })
        yield* insertRuntimeContext(contextId, namespace)
        const hostPrompt = yield* router.dispatch({
          target: HostPromptChannelTarget,
          verb: "send",
          payload: {
            contextId,
            payload: "host prompt",
            idempotencyKey: "host-prompt-1",
          },
        })
        const sessionPrompt = yield* router.dispatch({
          target: SessionPromptChannelTarget,
          verb: "send",
          payload: {
            sessionId: contextId,
            prompt: {
              payload: "session prompt",
              idempotencyKey: "session-prompt-1",
            },
          },
        })
        const started = yield* router.dispatch({
          target: HostSessionsStartChannelTarget,
          verb: "call",
          payload: { sessionId: contextId },
        })
        const permission = yield* router.dispatch({
          target: HostPermissionRespondChannelTarget,
          verb: "call",
          payload: {
            contextId,
            permissionRequestId: "permission-1",
            decision: { _tag: "Allow" },
          },
        })
        return { created, createdSession, hostPrompt, sessionPrompt, started, permission }
      })

    const observed = await runWithRouter(
      namespace,
      dispatchHostControlRoutes,
      signals,
    )

    expect(observed.created).toMatchObject({ contextId, sessionId: contextId })
    const createdSession = observed.createdSession as {
      readonly contextId?: unknown
      readonly sessionId?: unknown
    }
    expect(typeof createdSession.contextId).toBe("string")
    expect(typeof createdSession.sessionId).toBe("string")
    expect(observed.started).toMatchObject({ contextId, inserted: true })
    expect(observed.permission).toMatchObject({
      responded: true,
      contextId,
      permissionRequestId: "permission-1",
    })
    expect(observed.hostPrompt).toMatchObject({
      contextId,
      idempotencyKey: "host-prompt-1",
    })
    expect(observed.sessionPrompt).toMatchObject({
      contextId,
      idempotencyKey: "session-prompt-1",
    })
    expect(signals.map(signal => signal._tag)).toEqual([
      "CreateLoad",
      "CreateLoad",
      "Start",
    ])
    expect(signals[0]).toMatchObject({ _tag: "CreateLoad", contextId })
    expect(signals[2]).toMatchObject({ _tag: "Start", contextId })
  })
})
