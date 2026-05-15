import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
  hostOwnedStreamUrl,
  makeHostSessionRow,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
  type HostSessionRow,
} from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TestStreamServer } from "../../../effect-durable-operators/test/harness.ts"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "../firegrid.ts"

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
  JSON.stringify({
    type: "firegrid.agent-output",
    event,
  })

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
        url: hostOwnedStreamUrl({
          baseUrl,
          prefix: hostSession.streamPrefix,
          segment: "runtimeOutput",
        }),
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  )
}

describe("Firegrid session facade", () => {
  it("firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.1 createOrLoad is idempotent for duplicate externalKey", async () => {
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

  it("firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.8 waits for PermissionRequest over agentOutputEvents", async () => {
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
      },
    })
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

  it("firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.6 delegates start through the protocol capability", async () => {
    const fixture = makeFixture()

    const result = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-start" },
          runtime: runtimeConfig(),
        })
        return yield* session.start().pipe(
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
