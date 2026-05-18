import { Response } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { FiregridHost } from "@firegrid/host-sdk"
import {
  reconcileRuntimeControlRequestsOnce,
  startRuntime,
} from "@firegrid/host-sdk"
import type { FiregridSessionId } from "@firegrid/protocol/session-facade"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
} from "@firegrid/client-sdk/firegrid"
import { encodeRuntimeAgentOutputEnvelope } from "@firegrid/runtime/events"
import { Effect, Layer } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyDurableStreamsBackedPipeline } from "../src/configurations/durable-streams-backed-pipeline.ts"

type TinyDurableHostLayer = Layer.Layer<FiregridHost, DurableTableError>
interface StartRuntimeForTest {
  readonly contextId: string
  readonly activityAttempt: number
  readonly exitCode: number
  readonly signal?: string | undefined
}

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

const runtime = (script: string) =>
  local.jsonl({
    argv: [process.execPath, "-e", script],
  })

const textChunkLine = (delta: string): string =>
  encodeRuntimeAgentOutputEnvelope({
    _tag: "TextChunk",
    part: Response.textDeltaPart({
      id: "tiny-firegrid",
      delta,
    }),
  })

const promptDrivenAgentScript = (
  deltas: ReadonlyArray<string>,
): string => `
const outputs = ${JSON.stringify(deltas.map(textChunkLine))};
let emitted = false;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (emitted || !input.includes("\\n")) return;
  emitted = true;
  outputs.forEach((line, index) => {
    setTimeout(() => console.log(line), index * 25);
  });
  setTimeout(() => process.exit(0), outputs.length * 25 + 10);
});
setTimeout(() => process.exit(2), 5_000);
`

const textDeltas = (
  snapshot: {
    readonly agentOutputs: ReadonlyArray<{
      readonly _tag: string
      readonly event: Record<string, unknown>
    }>
  },
): ReadonlyArray<string> =>
  snapshot.agentOutputs.flatMap((row) => {
    const part = row.event.part
    if (row._tag !== "TextChunk" || typeof part !== "object" || part === null) return []
    const delta = (part as Record<string, unknown>).delta
    return typeof delta === "string" ? [delta] : []
  })

const provideClient = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Effect.Effect<A, E | DurableTableError | FiregridConfigError, Exclude<R, Firegrid>> =>
  self.pipe(
    Effect.provide(FiregridStandaloneLive),
    Effect.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: input.baseUrl,
      namespace: input.namespace,
    })),
  )

const startHostRuntime = (
  input: {
    readonly contextId: string
    readonly hostLayer: TinyDurableHostLayer
  },
) =>
  startRuntime({ contextId: input.contextId }).pipe(
    Effect.provide(input.hostLayer),
    Effect.scoped,
  ) as Effect.Effect<StartRuntimeForTest, unknown, never>

const reconcileHostRequests = (
  input: {
    readonly hostLayer: TinyDurableHostLayer
  },
) =>
  reconcileRuntimeControlRequestsOnce().pipe(
    Effect.provide(input.hostLayer),
    Effect.scoped,
  ) as Effect.Effect<void, unknown, never>

const createClientSessionContext = (
  input: {
    readonly baseUrl: string
    readonly namespace: string
    readonly externalKey: { readonly source: string; readonly id: string }
    readonly hostLayer: TinyDurableHostLayer
    readonly runtimeScript: string
  },
): Effect.Effect<FiregridSessionId, unknown, never> =>
  Effect.gen(function*() {
    const sessionId = yield* provideClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.createOrLoad({
        externalKey: input.externalKey,
        runtime: runtime(input.runtimeScript),
        createdBy: "tiny-firegrid",
      })
      return session.sessionId
    }), { baseUrl: input.baseUrl, namespace: input.namespace }).pipe(Effect.scoped)
    yield* reconcileHostRequests({ hostLayer: input.hostLayer })
    return sessionId
  })

describe("tiny-firegrid durable-streams-backed pipeline", () => {
  it("wires Firegrid client launch and prompt through the production Durable Streams substrate", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const namespace = `tiny-e2e-${crypto.randomUUID()}`
    const hostLayer = tinyDurableStreamsBackedPipeline({
      baseUrl,
      namespace,
      controlRequestReconciler: false,
    })

    const contextId = await Effect.runPromise(createClientSessionContext({
      baseUrl,
      namespace,
      externalKey: { source: "tiny-firegrid", id: "e2e" },
      hostLayer,
      runtimeScript: promptDrivenAgentScript(["hello"]),
    }))
    const created = await Effect.runPromise(provideClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.attach({ sessionId: contextId })
      const intent = yield* session.prompt({
        payload: { type: "text", text: "hello" },
        idempotencyKey: "turn-1",
      })
      return { contextId: session.contextId, intent }
    }), { baseUrl, namespace }).pipe(Effect.scoped))

    const started = await Effect.runPromise(startHostRuntime({
      contextId: created.contextId,
      hostLayer,
    }))
    const snapshot = await Effect.runPromise(provideClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.attach({ sessionId: created.contextId })
      return yield* session.snapshot()
    }), { baseUrl, namespace }).pipe(Effect.scoped))

    expect(started).toMatchObject({
      contextId: created.intent.contextId,
      exitCode: 0,
    })
    expect(textDeltas(snapshot)).toEqual(["hello"])
    expect(snapshot.agentOutputs.map(row => row.contextId)).toEqual([
      created.intent.contextId,
      created.intent.contextId,
    ])
  })

  it("replays a completed workflow after engine restart without duplicate sends", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const namespace = `tiny-replay-${crypto.randomUUID()}`
    const firstHostLayer = tinyDurableStreamsBackedPipeline({
      baseUrl,
      namespace,
      controlRequestReconciler: false,
    })

    const contextId = await Effect.runPromise(createClientSessionContext({
      baseUrl,
      namespace,
      externalKey: { source: "tiny-firegrid", id: "replay" },
      hostLayer: firstHostLayer,
      runtimeScript: promptDrivenAgentScript(["first", "second"]),
    }))
    const created = await Effect.runPromise(provideClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.attach({ sessionId: contextId })
      const intent = yield* session.prompt({
        payload: { type: "text", text: "hello" },
        idempotencyKey: "turn-1",
      })
      return { contextId: session.contextId, intent }
    }), { baseUrl, namespace }).pipe(Effect.scoped))

    const firstHostRun = Effect.runPromise(startHostRuntime({
      contextId: created.contextId,
      hostLayer: firstHostLayer,
    }))
    const partial = await Effect.runPromise(provideClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.attach({ sessionId: created.contextId })
      return yield* session.wait.forAgentOutput({ timeoutMs: 2_000 })
    }), { baseUrl, namespace }).pipe(Effect.scoped))
    const completed = await firstHostRun
    const snapshot = await Effect.runPromise(provideClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.attach({ sessionId: created.contextId })
      return yield* session.snapshot()
    }), { baseUrl, namespace }).pipe(Effect.scoped))

    expect(partial).toMatchObject({
      matched: true,
      output: {
        contextId: created.contextId,
        sequence: 0,
      },
    })
    expect(completed).toMatchObject({
      contextId: created.contextId,
      exitCode: 0,
    })
    expect(textDeltas(snapshot)).toEqual(["first", "second"])
    expect(snapshot.agentOutputs.map(row => row.sequence)).toEqual([0, 1, 2])

    const secondHostLayer = tinyDurableStreamsBackedPipeline({
      baseUrl,
      namespace,
      controlRequestReconciler: false,
    })

    const restarted = await Effect.runPromise(startHostRuntime({
      contextId: created.contextId,
      hostLayer: secondHostLayer,
    }))
    const replaySnapshot = await Effect.runPromise(provideClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const attached = yield* firegrid.sessions.attach({ sessionId: created.contextId })
      return yield* attached.snapshot()
    }), { baseUrl, namespace }).pipe(Effect.scoped))

    expect(restarted).toMatchObject({
      contextId: created.contextId,
      exitCode: 0,
    })
    expect(textDeltas(replaySnapshot)).toEqual(["first", "second"])
    expect(replaySnapshot.agentOutputs.map(row => row.sequence)).toEqual([0, 1, 2])
  })
})
