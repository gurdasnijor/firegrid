import { Response } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridRuntimeTables,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type FiregridService,
  type FiregridSessionHandle,
  type RuntimeContextSnapshot,
} from "@firegrid/client-sdk/firegrid"
import {
  encodeRuntimeAgentOutputEnvelope,
} from "@firegrid/protocol/session-facade"
import { runtimeControlPlaneStreamUrl } from "@firegrid/protocol/launch"
import { Clock, Effect, Layer, Option, Stream, type Context, type Scope } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyDurableStreamsBackedPipeline } from "../src/configurations/durable-streams-backed-pipeline.ts"

type ControlPlaneService = Context.Tag.Service<typeof FiregridRuntimeTables.ControlPlane>

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

const firstWithinOrFail = <A, E>(
  stream: Stream.Stream<A, E>,
  label: string,
  timeoutMs: number,
): Effect.Effect<A, E | Error> =>
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
  control: ControlPlaneService,
  session: FiregridSessionHandle,
) =>
  firstWithinOrFail(
    control.contexts.rows().pipe(
      Stream.filter(row => row.contextId === session.contextId),
    ),
    `context ${session.contextId}`,
    10_000,
  )

const waitForExitedRun = (
  control: ControlPlaneService,
  session: FiregridSessionHandle,
  exitCode: number,
) =>
  firstWithinOrFail(
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

const runWithPublicClient = <A, E>(
  scenario: (services: {
    readonly control: ControlPlaneService
    readonly firegrid: FiregridService
  }) => Effect.Effect<A, E, Scope.Scope>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      provideClient(
        Effect.gen(function*() {
          const control: ControlPlaneService = yield* FiregridRuntimeTables.ControlPlane
          const firegrid = yield* Firegrid
          return yield* scenario({ control, firegrid })
        }).pipe(Effect.provide(controlPlaneLayer(input))),
        input,
      ),
    ),
  )

const launchHost = (
  hostLayer: ReturnType<typeof tinyDurableStreamsBackedPipeline>,
): Effect.Effect<void, DurableTableError, Scope.Scope> =>
  Layer.launch(hostLayer).pipe(
    Effect.forkScoped,
    Effect.asVoid,
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

    const result = await runWithPublicClient(({ control, firegrid }) => Effect.gen(function*() {
      const session = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "tiny-firegrid", id: "e2e" },
        runtime: runtime(promptDrivenAgentScript(["hello"])),
        createdBy: "tiny-firegrid",
      })
      const started = yield* session.start()
      yield* launchHost(hostLayer)
      yield* waitForMaterializedContext(control, session)
      const intent = yield* session.prompt({
        payload: { type: "text", text: "hello" },
        idempotencyKey: "turn-1",
      })
      const firstOutput = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
      yield* waitForExitedRun(control, session, 0)
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

    const first = await runWithPublicClient(({ control, firegrid }) => Effect.gen(function*() {
      const session = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "tiny-firegrid", id: "replay" },
        runtime: runtime(promptDrivenAgentScript(["first", "second"])),
        createdBy: "tiny-firegrid",
      })
      const started = yield* session.start()
      yield* launchHost(firstHostLayer)
      yield* waitForMaterializedContext(control, session)
      const intent = yield* session.prompt({
        payload: { type: "text", text: "hello" },
        idempotencyKey: "turn-1",
      })
      const partial = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
      yield* waitForExitedRun(control, session, 0)
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

    const restarted = await runWithPublicClient(({ control, firegrid }) => Effect.gen(function*() {
      const attached = yield* firegrid.sessions.attach({
        sessionId: first.session.sessionId,
      })
      const started = yield* attached.start()
      yield* launchHost(secondHostLayer)
      yield* waitForExitedRun(control, attached, 0)
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
