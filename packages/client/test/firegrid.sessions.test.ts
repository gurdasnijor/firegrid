import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
  makeHostSessionRow,
  runtimeControlPlaneStreamUrl,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostSessionId,
  type HostSessionRow,
} from "@firegrid/protocol/launch"
import { encodeRuntimeAgentOutputEnvelope } from "@firegrid/protocol/session-facade"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TestStreamServer } from "../../effect-durable-operators/test/harness.ts"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
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

const agentOutputRaw = (event: Readonly<Record<string, unknown>>): string =>
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
    Firegrid | RuntimeControlPlaneTable | CurrentHostSession
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(fixture.clientLayer),
        Effect.provideService(CurrentHostSession, fixture.hostSession),
      ),
    ),
  )

const appendAgentOutput = (
  hostSession: HostSessionRow,
  contextId: string,
  sequence: number,
  event: Readonly<Record<string, unknown>>,
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

describe("Firegrid session facade", () => {
  it("firegrid-session-fact-client-surfaces.SESSION_IDENTITY.3 firegrid-session-fact-client-surfaces.CLIENT_SESSION.4 createOrLoad is idempotent and exposes sessionId with contextId alias", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
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
        const snapshot = yield* first.snapshot()
        return { first, second, snapshot }
      }),
    )

    expect(result.second.contextId).toBe(result.first.contextId)
    expect(result.first.sessionId).toBe(result.first.contextId)
    expect(result.second.sessionId).toBe(result.first.sessionId)
    expect(result.snapshot.context).toMatchObject({
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

  it("firegrid-session-fact-client-surfaces.CLIENT_SESSION.1 firegrid-session-fact-client-surfaces.CLIENT_SESSION.2 firegrid-session-fact-client-surfaces.CLIENT_SESSION.3 attaches to an existing session id and scopes prompt, snapshot, wait, and permission response", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const created = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-attach" },
          runtime: runtimeConfig(),
        })
        const attached = yield* firegrid.sessions.attach({
          sessionId: created.sessionId,
        })
        const prompt = yield* attached.prompt({
          payload: { text: "attached prompt" },
          idempotencyKey: "attached-turn-1",
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
        const response = yield* attached.permissions.respond({
          permissionRequestId: "permission-attached",
          decision: { _tag: "Allow", optionId: "allow" },
        })
        const snapshot = yield* attached.snapshot()
        return { created, attached, prompt, permission, response, snapshot }
      }),
    )

    expect(result.attached.sessionId).toBe(result.created.sessionId)
    expect(result.attached.contextId).toBe(result.created.contextId)
    expect(result.prompt.contextId).toBe(result.created.contextId)
    expect(result.permission._tag).toBe("Success")
    if (result.permission._tag !== "Success") return
    expect(result.permission.value).toMatchObject({
      matched: true,
      request: {
        contextId: result.created.contextId,
        permissionRequestId: "permission-attached",
      },
    })
    expect(result.response).toMatchObject({
      responded: true,
      contextId: result.created.contextId,
      permissionRequestId: "permission-attached",
    })
    expect(result.snapshot.inputs.map(row => row.kind)).toEqual([
      "message",
      "control",
    ])
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

  it("firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.5 prompt appends idempotent RuntimeIngress rows", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-456" },
          runtime: runtimeConfig(),
        })
        const first = yield* session.prompt({
          payload: { text: "turn one" },
          idempotencyKey: "turn-1",
          metadata: { source: "test" },
        })
        const second = yield* session.prompt({
          payload: { text: "duplicate should not rewrite" },
          idempotencyKey: "turn-1",
        })
        const snapshot = yield* session.snapshot()
        return { first, second, snapshot }
      }),
    )

    expect(result.second.inputId).toBe(result.first.inputId)
    expect(result.snapshot.inputs).toHaveLength(1)
    expect(result.snapshot.inputs[0]).toMatchObject({
      inputId: result.first.inputId,
      sequence: 0,
      status: "sequenced",
      kind: "message",
      authoredBy: "client",
      payload: { text: "turn one" },
      idempotencyKey: "turn-1",
      metadata: { source: "test" },
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
        const fiber = yield* session.wait.forAgentOutput({
          timeoutMs: 2_000,
        }).pipe(Effect.fork)
        yield* Effect.sleep("50 millis")
        yield* appendAgentOutput(
          fixture.hostSession,
          session.contextId,
          5,
          {
            _tag: "TextChunk",
            part: { text: "hello" },
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
        _tag: "TextChunk",
        event: {
          _tag: "TextChunk",
          part: { text: "hello" },
        },
      },
    })
    expect(result.snapshot.agentOutputs).toHaveLength(1)
    expect(result.snapshot.agentOutputs[0]).toMatchObject({
      sequence: 5,
      _tag: "TextChunk",
    })
    expect(result.snapshot.events).toHaveLength(1)
    expect(result.snapshot.events[0]?.raw).toBe(agentOutputRaw({
      _tag: "TextChunk",
      part: { text: "hello" },
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
        const fiber = yield* session.wait.forPermissionRequest({
          timeoutMs: 2_000,
        }).pipe(Effect.fork)
        yield* Effect.sleep("50 millis")
        yield* appendAgentOutput(
          fixture.hostSession,
          session.contextId,
          6,
          {
            _tag: "TextChunk",
            part: { text: "not a permission" },
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

  it("firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.9 writes PermissionResponse RuntimeIngress control rows", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-999" },
          runtime: runtimeConfig(),
        })
        const response = yield* session.permissions.respond({
          permissionRequestId: "permission-1",
          decision: { _tag: "Allow", optionId: "allow" },
        })
        const duplicate = yield* session.permissions.respond({
          permissionRequestId: "permission-1",
          decision: { _tag: "Allow", optionId: "allow" },
        })
        const snapshot = yield* session.snapshot()
        return { response, duplicate, snapshot }
      }),
    )

    expect(result.duplicate.inputId).toBe(result.response.inputId)
    expect(result.snapshot.inputs).toHaveLength(1)
    expect(result.snapshot.inputs[0]).toMatchObject({
      inputId: result.response.inputId,
      kind: "control",
      authoredBy: "client",
      payload: {
        _tag: "PermissionResponse",
        permissionRequestId: "permission-1",
        decision: { _tag: "Allow", optionId: "allow" },
      },
      idempotencyKey: `permission-response:${result.response.contextId}:permission-1`,
    })
  })

  it("firegrid-session-fact-client-surfaces.CLIENT_SESSION.2 delegates attached start through the server-provided protocol capability", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-start" },
          runtime: runtimeConfig(),
        })
        const attached = yield* firegrid.sessions.attach({
          sessionId: session.sessionId,
        })
        return yield* attached.start().pipe(
          Effect.provideService(RuntimeStartCapability, {
            start: options =>
              Effect.succeed({
                contextId: options.contextId,
                activityAttempt: 1,
                exitCode: 0,
              }),
          }),
        )
      }),
    )

    expect(result).toMatchObject({
      activityAttempt: 1,
      exitCode: 0,
    })
  })
})
