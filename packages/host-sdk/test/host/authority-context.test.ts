// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.3
// firegrid-host-context-authority.VALIDATION.3
//
// Coverage for the runtime-host context authority surface:
//
//   * insert/find/require operators behave correctly against the
//     RuntimeControlPlaneTable.
//   * `ContextNotLocal` is constructed via its Schema.TaggedError class
//     when a context bound to host A is required from host B.
//   * Parallel fibers using different CurrentRuntimeContext values do
//     NOT share or capture the wrong context — the value seen on each
//     fiber matches the locally provided service.

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  RuntimeContextIntentSchema,
  local,
  makeHostSessionRow,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
  type HostSessionId,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeContextInsert,
  RuntimeContextInsertLive,
} from "../../src/authorities/index.ts"
import {
  ContextNotFound,
  ContextNotLocal,
  CurrentHostSession,
  CurrentRuntimeContext,
  findRuntimeContext,
  provideRuntimeContext,
  requireLocalContext,
} from "@firegrid/protocol/launch"

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
      url: `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`,
      contentType: "application/json",
    },
  })

const sessionLayer = (namespace: string, hostId: HostId) =>
  Layer.succeed(
    CurrentHostSession,
    makeHostSessionRow({
      hostId,
      hostSessionId: `hs_${crypto.randomUUID()}` as HostSessionId,
      namespace,
      startedAtMs: 1_700_000_000_000,
    }),
  )

const sampleIntent = Schema.decodeUnknownSync(RuntimeContextIntentSchema)(
  normalizeRuntimeIntent(local.jsonl({ argv: ["node", "-e", "process.exit(0)"] })),
)

const insertLocalRuntimeContext = (
  intent: typeof sampleIntent,
  options: {
    readonly contextId: string
    readonly createdBy?: string
  },
) =>
  Effect.gen(function* () {
    const contextInsert = yield* RuntimeContextInsert
    return yield* contextInsert.insertLocalContext(intent, options)
  })

describe("insertLocalRuntimeContext", () => {
  it("firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2 fills the host binding from CurrentHostSession", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `host-context-authority-insert-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId

    const context = await Effect.runPromise(
      insertLocalRuntimeContext(sampleIntent, {
        contextId: `ctx_${crypto.randomUUID()}`,
        createdBy: "test",
      }).pipe(
        Effect.provide(RuntimeContextInsertLive),
        Effect.provide(controlPlaneLayer(namespace)),
        Effect.provide(sessionLayer(namespace, hostId)),
        Effect.scoped,
      ),
    )

    expect(context.host.hostId).toBe(hostId)
    expect(context.host.streamPrefix).toBe(`${namespace}.firegrid.host.${hostId}`)
    expect(context.host.boundAtMs).toBeTypeOf("number")
    expect(context.createdBy).toBe("test")
  })

  it("firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1 inserted row is observable via findRuntimeContext", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `host-context-authority-find-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId

    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const inserted = yield* insertLocalRuntimeContext(sampleIntent, {
          contextId: `ctx_${crypto.randomUUID()}`,
        })
        return yield* findRuntimeContext(inserted.contextId)
      }).pipe(
        Effect.provide(RuntimeContextInsertLive),
        Effect.provide(controlPlaneLayer(namespace)),
        Effect.provide(sessionLayer(namespace, hostId)),
        Effect.scoped,
      ),
    )

    expect(found.host.hostId).toBe(hostId)
  })

  it("firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4 findRuntimeContext fails with ContextNotFound for unknown contexts", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `host-context-authority-missing-${crypto.randomUUID()}`

    const exit = await Effect.runPromise(
      Effect.either(findRuntimeContext("ctx_does_not_exist").pipe(
        Effect.provide(controlPlaneLayer(namespace)),
        Effect.scoped,
      )),
    )

    expect(Either.isLeft(exit)).toBe(true)
    if (Either.isLeft(exit)) {
      expect(exit.left).toBeInstanceOf(ContextNotFound)
      expect(exit.left._tag).toBe("ContextNotFound")
    }
  })
})

describe("requireLocalContext", () => {
  it("firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2 fails with ContextNotLocal when the binding names a different host", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `host-context-authority-foreign-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const hostB = `host_B_${crypto.randomUUID()}` as HostId

    // Host A inserts the context.
    const insertedFromA = await Effect.runPromise(
      insertLocalRuntimeContext(sampleIntent, {
        contextId: `ctx_${crypto.randomUUID()}`,
      }).pipe(
        Effect.provide(RuntimeContextInsertLive),
        Effect.provide(controlPlaneLayer(namespace)),
        Effect.provide(sessionLayer(namespace, hostA)),
        Effect.scoped,
      ),
    )

    // Host B tries to require the same context.
    const result = await Effect.runPromise(
      Effect.either(
        requireLocalContext(insertedFromA.contextId).pipe(
          Effect.provide(controlPlaneLayer(namespace)),
          Effect.provide(sessionLayer(namespace, hostB)),
          Effect.scoped,
        ),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ContextNotLocal)
      expect(result.left).toMatchObject({
        _tag: "ContextNotLocal",
        contextId: insertedFromA.contextId,
        hostId: hostA,
        currentHostId: hostB,
      })
    }
  })

  it("firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2 succeeds when the same host requires the context it inserted", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `host-context-authority-local-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId

    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const inserted = yield* insertLocalRuntimeContext(sampleIntent, {
          contextId: `ctx_${crypto.randomUUID()}`,
        })
        return yield* requireLocalContext(inserted.contextId)
      }).pipe(
        Effect.provide(RuntimeContextInsertLive),
        Effect.provide(controlPlaneLayer(namespace)),
        Effect.provide(sessionLayer(namespace, hostId)),
        Effect.scoped,
      ),
    )

    expect(got.host.hostId).toBe(hostId)
  })
})

describe("CurrentRuntimeContext fiber scoping", () => {
  it("firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.3 firegrid-host-context-authority.VALIDATION.3 parallel fibers see their own provided RuntimeContext", async () => {
    const namespace = "scoped-context-test"
    const hostId = "host_test" as HostId
    const streamPrefix = makeHostStreamPrefix({ namespace, hostId })
    const contextOne: RuntimeContext = {
      contextId: "ctx_one",
      createdAt: "2026-05-14T00:00:00.000Z",
      runtime: sampleIntent,
      host: {
        hostId,
        streamPrefix,
        boundAtMs: 1,
      },
    }
    const contextTwo: RuntimeContext = {
      ...contextOne,
      contextId: "ctx_two",
      host: {
        ...contextOne.host,
        boundAtMs: 2,
      },
    }

    // Read CurrentRuntimeContext inside the effect so the captured
    // service is the one the local fiber's scope provided. The
    // assertion would fail if `provideRuntimeContext` somehow leaked
    // a shared closure across fibers.
    const readContextId = Effect.map(
      CurrentRuntimeContext,
      (ctx) => ctx.contextId,
    )

    const [first, second] = await Effect.runPromise(
      Effect.all([
        readContextId.pipe(provideRuntimeContext(contextOne)),
        readContextId.pipe(provideRuntimeContext(contextTwo)),
      ], { concurrency: 2 }),
    )

    expect(first).toBe("ctx_one")
    expect(second).toBe("ctx_two")
  })
})
