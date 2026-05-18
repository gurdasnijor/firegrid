import { Response } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridRuntimeTables,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type FiregridSessionHandle,
  type RuntimeContextSnapshot,
} from "@firegrid/client-sdk/firegrid"
import {
  encodeRuntimeAgentOutputEnvelope,
} from "@firegrid/protocol/session-facade"
import { runtimeControlPlaneStreamUrl } from "@firegrid/protocol/launch"
import { Clock, Effect, Layer, Option, Stream, type Scope } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyDurableStreamsBackedPipeline } from "../src/configurations/durable-streams-backed-pipeline.ts"

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
  snapshot: RuntimeContextSnapshot,
): ReadonlyArray<string> =>
  snapshot.agentOutputs.flatMap((row) => {
    if (row.event._tag !== "TextChunk") return []
    return [row.event.part.delta]
  })

const exitedRun = (
  snapshot: RuntimeContextSnapshot,
) =>
  snapshot.runs.find(row => row.status === "exited")

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

const controlPlaneLayer = (
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
) =>
  FiregridRuntimeTables.ControlPlane.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl(input),
      contentType: "application/json",
    },
    txTimeoutMs: 2_000,
  })

const waitForControlPlaneRow = <A, E>(
  stream: Stream.Stream<A, E>,
  label: string,
  timeoutMs: number,
) =>
  Effect.raceFirst(
    Stream.runHead(stream).pipe(
      Effect.flatMap(row =>
        Option.match(row, {
          onNone: () => Effect.fail(new Error(`${label} stream ended before matching`)),
          onSome: Effect.succeed,
        })),
    ),
    Clock.sleep(`${timeoutMs} millis`).pipe(
      Effect.flatMap(() => Effect.fail(new Error(`timed out waiting for ${label}`))),
    ),
  )

const waitForMaterializedContext = (
  session: FiregridSessionHandle,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
) =>
  Effect.gen(function*() {
    const control = yield* FiregridRuntimeTables.ControlPlane
    return yield* waitForControlPlaneRow(
      control.contexts.rows().pipe(
        Stream.filter(row => row.contextId === session.contextId),
      ),
      `context ${session.contextId}`,
      10_000,
    )
  }).pipe(
    Effect.provide(controlPlaneLayer(input)),
    Effect.scoped,
  )

const waitForExitedRun = (
  session: FiregridSessionHandle,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
  exitCode: number,
) =>
  Effect.gen(function*() {
    const control = yield* FiregridRuntimeTables.ControlPlane
    return yield* waitForControlPlaneRow(
      control.runs.rows().pipe(
        Stream.filter(row =>
          row.contextId === session.contextId &&
          row.status === "exited" &&
          row.exitCode === exitCode,
        ),
      ),
      `exited run for ${session.contextId}`,
      10_000,
    )
  }).pipe(
    Effect.provide(controlPlaneLayer(input)),
    Effect.scoped,
  )

const runWithPublicClient = <A, E>(
  self: Effect.Effect<A, E, Firegrid | Scope.Scope>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      provideClient(self, input),
    ),
  )

describe("tiny-firegrid durable-streams-backed pipeline", () => {
  it("wires Firegrid client launch and prompt through the production Durable Streams substrate", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const durableStreamsBaseUrl = baseUrl
    const namespace = `tiny-e2e-${crypto.randomUUID()}`
    const hostLayer = tinyDurableStreamsBackedPipeline({
      baseUrl: durableStreamsBaseUrl,
      namespace,
    })

    const result = await runWithPublicClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "tiny-firegrid", id: "e2e" },
        runtime: runtime(promptDrivenAgentScript(["hello"])),
        createdBy: "tiny-firegrid",
      })
      const started = yield* session.start()
      yield* Layer.launch(hostLayer).pipe(Effect.forkScoped)
      yield* waitForMaterializedContext(session, {
        baseUrl: durableStreamsBaseUrl,
        namespace,
      })
      const intent = yield* session.prompt({
        payload: { type: "text", text: "hello" },
        idempotencyKey: "turn-1",
      })
      const firstOutput = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
      yield* waitForExitedRun(session, { baseUrl: durableStreamsBaseUrl, namespace }, 0)
      const snapshot = yield* session.snapshot()

      return {
        firstOutput,
        intent,
        session,
        snapshot,
        started,
      }
    }), { baseUrl: durableStreamsBaseUrl, namespace })

    expect(result.started).toMatchObject({
      contextId: result.session.contextId,
      inserted: true,
    })
    expect(result.intent).toMatchObject({
      contextId: result.session.contextId,
    })
    expect(result.firstOutput).toMatchObject({
      matched: true,
      output: {
        contextId: result.session.contextId,
        sequence: 0,
      },
    })
    expect(exitedRun(result.snapshot)).toMatchObject({
      contextId: result.session.contextId,
      exitCode: 0,
    })
    expect(textDeltas(result.snapshot)).toEqual(["hello"])
    expect(result.snapshot.agentOutputs.map(row => row.contextId)).toEqual([
      result.session.contextId,
      result.session.contextId,
    ])
  })

  it("restarts the host without duplicating completed output", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const durableStreamsBaseUrl = baseUrl
    const namespace = `tiny-replay-${crypto.randomUUID()}`
    const firstHostLayer = tinyDurableStreamsBackedPipeline({
      baseUrl: durableStreamsBaseUrl,
      namespace,
    })

    const first = await runWithPublicClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "tiny-firegrid", id: "replay" },
        runtime: runtime(promptDrivenAgentScript(["first", "second"])),
        createdBy: "tiny-firegrid",
      })
      const started = yield* session.start()
      yield* Layer.launch(firstHostLayer).pipe(Effect.forkScoped)
      yield* waitForMaterializedContext(session, {
        baseUrl: durableStreamsBaseUrl,
        namespace,
      })
      const intent = yield* session.prompt({
        payload: { type: "text", text: "hello" },
        idempotencyKey: "turn-1",
      })
      const partial = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
      yield* waitForExitedRun(session, { baseUrl: durableStreamsBaseUrl, namespace }, 0)
      const snapshot = yield* session.snapshot()
      return { intent, partial, session, snapshot, started }
    }), { baseUrl: durableStreamsBaseUrl, namespace })

    expect(first.started).toMatchObject({
      contextId: first.session.contextId,
      inserted: true,
    })
    expect(first.partial).toMatchObject({
      matched: true,
      output: {
        contextId: first.session.contextId,
        sequence: 0,
      },
    })
    expect(first.intent).toMatchObject({
      contextId: first.session.contextId,
    })
    expect(textDeltas(first.snapshot)).toEqual(["first", "second"])
    expect(first.snapshot.agentOutputs.map(row => row.sequence)).toEqual([0, 1, 2])

    const secondHostLayer = tinyDurableStreamsBackedPipeline({
      baseUrl: durableStreamsBaseUrl,
      namespace,
    })

    const restarted = await runWithPublicClient(Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const attached = yield* firegrid.sessions.attach({
        sessionId: first.session.sessionId,
      })
      const started = yield* attached.start()
      yield* Layer.launch(secondHostLayer).pipe(Effect.forkScoped)
      yield* waitForExitedRun(attached, { baseUrl: durableStreamsBaseUrl, namespace }, 0)
      const snapshot = yield* attached.snapshot()
      return { snapshot, started }
    }), { baseUrl: durableStreamsBaseUrl, namespace })

    expect(restarted.started).toMatchObject({
      contextId: first.session.contextId,
      inserted: false,
    })
    expect(textDeltas(restarted.snapshot)).toEqual(["first", "second"])
    expect(restarted.snapshot.agentOutputs.map(row => row.sequence)).toEqual([0, 1, 2])
  })
})
