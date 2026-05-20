import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  makeLocalRuntimeContextForHostSession,
  makeHostSessionRow,
  normalizeRuntimeIntent,
  runtimeContextRequestId,
  runtimeControlPlaneStreamUrl,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostSessionId,
  type HostSessionRow,
  type RuntimeContext,
  type RuntimeContextRequestRow,
  type RuntimeStartRequestRow,
} from "@firegrid/protocol/launch"
import {
  encodeRuntimeAgentOutputEnvelope,
  type AgentOutputEvent,
} from "@firegrid/protocol/session-facade"
import {
  inputIdForRuntimeIngressRequest,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TestStreamServer } from "../../effect-durable-operators/test/harness.ts"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
  type FiregridSessionHandle,
  type RuntimeStartRequestAck,
} from "../src/firegrid.ts"

let server: TestStreamServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new TestStreamServer()
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const runtimeConfig = () =>
  local.jsonl({
    argv: [process.execPath, "--version"],
    agentProtocol: "stdio-jsonl",
  })

const agentOutputRaw = (event: AgentOutputEvent): string =>
  encodeRuntimeAgentOutputEnvelope(event)

const makeFixture = () => {
  if (baseUrl === undefined) throw new Error("server not started")
  const namespace = `client-session-${crypto.randomUUID()}`
  const hostSession = makeHostSessionRow({
    hostId: `host_${crypto.randomUUID()}` as HostId,
    hostSessionId: `session-${crypto.randomUUID()}` as HostSessionId,
    namespace,
    startedAtMs: Date.now(),
  })
  const clientLayer = FiregridLive.pipe(
    Layer.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: baseUrl,
      namespace,
    })),
    Layer.provideMerge(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({ baseUrl, namespace }),
        contentType: "application/json",
      },
    })),
  )
  return { hostSession, clientLayer }
}

const namespaceFromHostSession = (hostSession: HostSessionRow): string => {
  const marker = ".firegrid.host."
  const index = hostSession.streamPrefix.indexOf(marker)
  if (index < 0) throw new Error("invalid host session stream prefix")
  return hostSession.streamPrefix.slice(0, index)
}

const runWithClient = <A, E>(
  fixture: {
    readonly hostSession: HostSessionRow
    readonly clientLayer: Layer.Layer<
      Firegrid | RuntimeControlPlaneTable,
      unknown,
      never
    >
  },
  effect: Effect.Effect<
    A,
    E,
    Firegrid | RuntimeControlPlaneTable
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(fixture.clientLayer),
      ),
    ),
  )

const materializeContextRequest = (
  hostSession: HostSessionRow,
  contextId: string,
): Effect.Effect<RuntimeContext, unknown, RuntimeControlPlaneTable> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    const request = yield* table.contextRequests.get(runtimeContextRequestId(contextId))
    if (Option.isNone(request)) {
      return yield* Effect.fail(new Error(`missing context request for ${contextId}`))
    }
    const createdAtMs = Date.parse(request.value.createdAt)
    const runtimeContext = yield* makeLocalRuntimeContextForHostSession(
      hostSession,
      normalizeRuntimeIntent(request.value.runtime),
      {
        contextId,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
        ...(request.value.createdBy === undefined ? {} : { createdBy: request.value.createdBy }),
      },
    )
    yield* table.contexts.insertOrGet(runtimeContext)
    return runtimeContext
  })

const appendAgentOutput = (
  hostSession: HostSessionRow,
  contextId: string,
  sequence: number,
  event: AgentOutputEvent,
) => {
  if (baseUrl === undefined) throw new Error("server not started")
  return Effect.gen(function* () {
    const output = yield* RuntimeOutputTable
    yield* output.events.upsert({
      eventId: {
        contextId,
        activityAttempt: 1,
        target: "events",
        sequence,
      },
      contextId,
      activityAttempt: 1,
      sequence,
      source: "stdout",
      format: "jsonl",
      receivedAt: new Date().toISOString(),
      raw: agentOutputRaw(event),
    })
  }).pipe(
    Effect.provide(RuntimeOutputTable.layer({
      streamOptions: {
        url: runtimeContextOutputStreamUrl({
          baseUrl,
          prefix: hostSession.streamPrefix,
          contextId,
        }),
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  )
}

const readRuntimeInputIntent = (
  hostSession: HostSessionRow,
  intentId: string,
): Promise<RuntimeInputIntentRow | undefined> => {
  if (baseUrl === undefined) throw new Error("server not started")
  return Effect.runPromise(Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    return yield* table.inputIntents.query((coll) =>
      coll.toArray.find(row => row.intentId === intentId))
  }).pipe(
    Effect.provide(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({
          baseUrl,
          namespace: namespaceFromHostSession(hostSession),
        }),
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  ))
}

describe("Firegrid session facade", () => {
  it("firegrid-session-fact-client-surfaces.SESSION_IDENTITY.3 firegrid-session-fact-client-surfaces.CLIENT_SESSION.4 createOrLoad is idempotent and exposes sessionId with contextId alias", async () => {
    const fixture = makeFixture()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const effect: Effect.Effect<
      {
        readonly first: FiregridSessionHandle
        readonly second: FiregridSessionHandle
        readonly requests: ReadonlyArray<RuntimeContextRequestRow>
      },
      unknown,
      Firegrid | RuntimeControlPlaneTable
    > = Effect.gen(function* () {
      const firegrid = yield* Firegrid
      const first = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "linear", id: "LIN-123" },
        runtime: runtimeConfig(),
        createdBy: "client-session-test",
      })
      const second = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "linear", id: "LIN-123" },
        runtime: runtimeConfig(),
        createdBy: "client-session-test",
      })
      const table = yield* RuntimeControlPlaneTable
      const requests = yield* table.contextRequests.query((coll) => coll.toArray)
      return { first, second, requests }
    })

    const result = await runWithClient(
      fixture,
      effect,
    )

    expect(result.second.contextId).toBe(result.first.contextId)
    expect(result.first.sessionId).toBe(result.first.contextId)
    expect(result.second.sessionId).toBe(result.first.sessionId)
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0]).toMatchObject({
      requestId: runtimeContextRequestId(result.first.contextId),
      contextId: result.first.contextId,
      createdBy: "client-session-test",
      runtime: {
        provider: "local-process",
        config: {
          agentProtocol: "stdio-jsonl",
        },
      },
    })
  })

  it("firegrid-session-fact-client-surfaces.CLIENT_SESSION.1 firegrid-session-fact-client-surfaces.CLIENT_SESSION.2 firegrid-session-fact-client-surfaces.CLIENT_SESSION.3 attaches to an existing session id and scopes snapshot, wait, and start", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const created = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-attach" },
          runtime: runtimeConfig(),
        })
        yield* materializeContextRequest(fixture.hostSession, created.contextId)
        const attached = yield* firegrid.sessions.attach({
          sessionId: created.sessionId,
        })
        const waiting = yield* attached.wait.forPermissionRequest({
          timeoutMs: 2_000,
        }).pipe(Effect.fork)
        yield* Effect.sleep("50 millis")
        yield* appendAgentOutput(
          fixture.hostSession,
          attached.sessionId,
          11,
          {
            _tag: "PermissionRequest",
            permissionRequestId: "permission-attached",
            toolUseId: "tool-attached",
            options: [
              { optionId: "allow", kind: "allow_once", name: "Allow" },
            ],
          },
        )
        const permission = yield* waiting.await
        const snapshot = yield* attached.snapshot()
        return { created, attached, permission, snapshot }
      }),
    )

    expect(result.attached.sessionId).toBe(result.created.sessionId)
    expect(result.attached.contextId).toBe(result.created.contextId)
    expect(result.permission._tag).toBe("Success")
    if (result.permission._tag !== "Success") return
    expect(result.permission.value).toMatchObject({
      matched: true,
      request: {
        contextId: result.created.contextId,
        permissionRequestId: "permission-attached",
      },
    })
    expect(result.snapshot.agentOutputs).toHaveLength(1)
    expect(result.snapshot.agentOutputs[0]).toMatchObject({
      sessionId: result.created.sessionId,
      contextId: result.created.contextId,
      sequence: 11,
      _tag: "PermissionRequest",
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
      ],
    })
  })

  it("firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.5-1 prompt appends a durable runtime input intent", async () => {
    const fixture = makeFixture()
    const effect = Effect.flatMap(Firegrid, firegrid =>
      Effect.flatMap(firegrid.sessions.createOrLoad({
        externalKey: { source: "linear", id: "LIN-456" },
        runtime: runtimeConfig(),
      }), session =>
        Effect.flatMap(materializeContextRequest(fixture.hostSession, session.contextId), () =>
          Effect.flatMap(session.prompt({
            payload: { text: "turn one" },
            idempotencyKey: "turn-1",
            metadata: { source: "test" },
          }), intent =>
            Effect.succeed({ contextId: session.contextId, intent })))))

    const result = await runWithClient(
      fixture,
      effect,
    )
    const stored = await readRuntimeInputIntent(fixture.hostSession, result.intent.intentId)

    expect(result.intent).toMatchObject({
      intentId: inputIdForRuntimeIngressRequest({
        contextId: result.contextId,
        kind: "message",
        authoredBy: "client",
        payload: { text: "turn one" },
        idempotencyKey: "turn-1",
        metadata: { source: "test" },
      }),
      contextId: result.contextId,
      kind: "message",
      authoredBy: "client",
      payload: { text: "turn one" },
      idempotencyKey: "turn-1",
    })
    expect(stored).toMatchObject(result.intent)
  })

  it("firegrid-session-fact-client-surfaces.CLIENT_SESSION.6 whenReady completes from RuntimeContext projection state before prompt append", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-ready" },
          runtime: runtimeConfig(),
        })
        const ready = yield* session.whenReady.pipe(Effect.fork)
        yield* Effect.sleep("50 millis")
        yield* materializeContextRequest(fixture.hostSession, session.contextId)
        const readyExit = yield* ready.await
        const intent = yield* session.prompt({
          payload: { text: "ready turn" },
          idempotencyKey: "ready-turn",
        })
        return { contextId: session.contextId, intent, readyExit }
      }),
    )
    const stored = await readRuntimeInputIntent(fixture.hostSession, result.intent.intentId)

    expect(result.readyExit._tag).toBe("Success")
    expect(stored).toMatchObject({
      contextId: result.contextId,
      payload: { text: "ready turn" },
      idempotencyKey: "ready-turn",
    })
  })

  it("firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.2 firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.3 firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.6 includes normalized agentOutputs in snapshot and waits for the next one", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-output" },
          runtime: runtimeConfig(),
        })
        yield* materializeContextRequest(fixture.hostSession, session.contextId)
        const fiber = yield* session.wait.forAgentOutput({
          timeoutMs: 2_000,
        }).pipe(Effect.fork)
        yield* Effect.sleep("50 millis")
        yield* appendAgentOutput(
          fixture.hostSession,
          session.contextId,
          5,
          {
            _tag: "Status",
            kind: "hello",
          },
        )
        const waited = yield* fiber.await
        const snapshot = yield* session.snapshot()
        return { waited, snapshot }
      }),
    )

    expect(result.waited._tag).toBe("Success")
    if (result.waited._tag !== "Success") return
    expect(result.waited.value).toMatchObject({
      matched: true,
      output: {
        source: "firegrid.runtime.agent-output-events",
        sessionId: result.snapshot.contextId,
        contextId: result.snapshot.contextId,
        sequence: 5,
        _tag: "Status",
        event: {
          _tag: "Status",
          kind: "hello",
        },
      },
    })
    expect(result.snapshot.agentOutputs).toHaveLength(1)
    expect(result.snapshot.agentOutputs[0]).toMatchObject({
      sequence: 5,
      _tag: "Status",
    })
    expect(result.snapshot.events).toHaveLength(1)
    expect(result.snapshot.events[0]?.raw).toBe(agentOutputRaw({
      _tag: "Status",
      kind: "hello",
    }))
  })

  it("firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.4 waits for PermissionRequest over normalized agentOutputEvents", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-789" },
          runtime: runtimeConfig(),
        })
        yield* materializeContextRequest(fixture.hostSession, session.contextId)
        const fiber = yield* session.wait.forPermissionRequest({
          timeoutMs: 2_000,
        }).pipe(Effect.fork)
        yield* Effect.sleep("50 millis")
        yield* appendAgentOutput(
          fixture.hostSession,
          session.contextId,
          6,
          {
            _tag: "Status",
            kind: "not-a-permission",
          },
        )
        yield* appendAgentOutput(
          fixture.hostSession,
          session.contextId,
          7,
          {
            _tag: "PermissionRequest",
            permissionRequestId: "permission-1",
            toolUseId: "tool-1",
            options: [
              { optionId: "allow", kind: "allow_once", name: "Allow" },
            ],
          },
        )
        return yield* fiber.await
      }),
    )

    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.value).toMatchObject({
      matched: true,
      request: {
        source: "firegrid.runtime.agent-output-events",
        sequence: 7,
        _tag: "PermissionRequest",
        permissionRequestId: "permission-1",
        toolUseId: "tool-1",
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
        ],
      },
    })
    if (!result.value.matched) return
    expect(result.value.request.sessionId).toBe(result.value.request.contextId)
  })

  it("firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.9-1 permission response appends a durable runtime input intent", async () => {
    const fixture = makeFixture()
    const effect = Effect.flatMap(Firegrid, firegrid =>
      Effect.flatMap(firegrid.sessions.createOrLoad({
        externalKey: { source: "linear", id: "LIN-999" },
        runtime: runtimeConfig(),
      }), session =>
        Effect.flatMap(materializeContextRequest(fixture.hostSession, session.contextId), () =>
          Effect.flatMap(session.permissions.respond({
            permissionRequestId: "permission-1",
            decision: { _tag: "Allow", optionId: "allow" },
          }), response =>
            Effect.succeed({ contextId: session.contextId, response })))))

    const result = await runWithClient(
      fixture,
      effect,
    )
    const stored = await readRuntimeInputIntent(fixture.hostSession, result.response.inputId)

    expect(result.response).toMatchObject({
      responded: true,
      contextId: result.contextId,
      permissionRequestId: "permission-1",
    })
    expect(stored).toMatchObject({
      intentId: result.response.inputId,
      contextId: result.contextId,
      kind: "required_action_result",
      authoredBy: "client",
      payload: {
        _tag: "PermissionResponse",
        permissionRequestId: "permission-1",
        decision: { _tag: "Allow", optionId: "allow" },
      },
      idempotencyKey: `permission-response:${result.contextId}:permission-1`,
    })
  })

  it("firegrid-session-fact-client-surfaces.CLIENT_SESSION.2 records an attached start request acknowledgement", async () => {
    const fixture = makeFixture()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const effect: Effect.Effect<
      {
        readonly ack: RuntimeStartRequestAck
        readonly request: Option.Option<RuntimeStartRequestRow>
      },
      unknown,
      Firegrid | RuntimeControlPlaneTable
    > = Effect.gen(function* () {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "linear", id: "LIN-start" },
        runtime: runtimeConfig(),
      })
      const attached = yield* firegrid.sessions.attach({
        sessionId: session.sessionId,
      })
      const ack = yield* attached.start()
      const table = yield* RuntimeControlPlaneTable
      const request = yield* table.startRequests.get(ack.requestId)
      return { ack, request }
    })

    const result = await runWithClient(
      fixture,
      effect,
    )

    expect(result.ack).toMatchObject({
      contextId: Option.getOrThrow(result.request).contextId,
      inserted: true,
    })
    expect(Option.getOrThrow(result.request).requestId).toBe(result.ack.requestId)
  })
})
