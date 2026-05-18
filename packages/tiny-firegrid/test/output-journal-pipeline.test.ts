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
import { runtimeControlPlaneStreamUrl } from "@firegrid/protocol/launch"
import {
  encodeRuntimeAgentOutputEnvelope,
} from "@firegrid/protocol/session-facade"
import { Clock, Effect, Layer, Option, Stream, type Context, type Scope } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyOutputJournalPipeline } from "../src/configurations/output-journal-pipeline.ts"

type ControlPlaneService = Context.Tag.Service<typeof FiregridRuntimeTables.ControlPlane>
type AgentOutputObservation = RuntimeContextSnapshot["agentOutputs"][number]

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

const textChunkLine = (id: string, delta: string): string =>
  encodeRuntimeAgentOutputEnvelope({
    _tag: "TextChunk",
    part: Response.textDeltaPart({ id, delta }),
  })

const outputJournalAgentScript = (
  deltas: ReadonlyArray<string>,
): string => `
const outputs = ${JSON.stringify([
  ...deltas.map((delta, index) => textChunkLine(`journal-${index}`, delta)),
])};
let emitted = false;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (emitted || !input.includes("\\n")) return;
  emitted = true;
  outputs.forEach((line, index) => {
    setTimeout(() => console.log(line), index * 20);
  });
});
// packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts
// owns terminal evidence from process exit; the fixture must not print its
// own Terminated envelope or the journal contains two terminal rows.
setTimeout(() => process.exit(0), 400);
`

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

const waitForIntent = (
  control: ControlPlaneService,
  session: FiregridSessionHandle,
  intentId: string,
) =>
  firstWithinOrFail(
    control.inputIntents.rows().pipe(
      Stream.filter(row =>
        row.contextId === session.contextId &&
        row.intentId === intentId,
      ),
    ),
    `intent ${intentId}`,
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
  hostLayer: ReturnType<typeof tinyOutputJournalPipeline>,
): Effect.Effect<void, DurableTableError, Scope.Scope> =>
  Layer.launch(hostLayer).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )

const textDeltaFromObservation = (
  observation: AgentOutputObservation,
): string | undefined => {
  if (observation.event._tag !== "TextChunk") return undefined
  return observation.event.part.delta
}

const textDeltas = (
  snapshot: RuntimeContextSnapshot,
): ReadonlyArray<string> =>
  snapshot.agentOutputs.flatMap(row => {
    const delta = textDeltaFromObservation(row)
    return delta === undefined ? [] : [delta]
  })

describe("tiny-firegrid output-journal pipeline", () => {
  it("firegrid-runtime-agent-event-pipeline.INGREDIENTS.2 firegrid-typed-wait-source-redesign.WAIT_ROUTER.1 journals per-context output and advances through AgentOutputAfter waits", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const durableStreamsBaseUrl = baseUrl
    const namespace = `tiny-output-journal-${crypto.randomUUID()}`
    const hostLayer = tinyOutputJournalPipeline({
      baseUrl: durableStreamsBaseUrl,
      namespace,
    })

    const result = await runWithPublicClient(({ control, firegrid }) => Effect.gen(function*() {
      const session = yield* firegrid.sessions.createOrLoad({
        externalKey: { source: "tiny-firegrid", id: "output-journal" },
        runtime: runtime(outputJournalAgentScript(["first", "second"])),
        createdBy: "tiny-firegrid",
      })
      const started = yield* session.start()
      yield* launchHost(hostLayer)
      yield* waitForMaterializedContext(control, session)
      const intent = yield* session.prompt({
        payload: { type: "text", text: "drive output journal" },
        idempotencyKey: "output-journal-turn-1",
      })
      const observedIntent = yield* waitForIntent(control, session, intent.intentId)
      const firstOutput = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
      if (!firstOutput.matched) {
        return yield* Effect.fail(new Error("timed out waiting for first output"))
      }
      const secondOutput = yield* session.wait.forAgentOutput({
        afterSequence: firstOutput.output.sequence,
        timeoutMs: 10_000,
      })
      if (!secondOutput.matched) {
        return yield* Effect.fail(new Error("timed out waiting for second output"))
      }
      const terminated = yield* session.wait.forAgentOutput({
        afterSequence: secondOutput.output.sequence,
        timeoutMs: 10_000,
      })
      if (!terminated.matched) {
        return yield* Effect.fail(new Error("timed out waiting for terminated output"))
      }
      const exited = yield* waitForExitedRun(control, session, 0)
      const snapshot = yield* session.snapshot()
      return {
        exited,
        firstOutput: firstOutput.output,
        intent,
        observedIntent,
        secondOutput: secondOutput.output,
        session,
        snapshot,
        started,
        terminated: terminated.output,
      }
    }), { baseUrl: durableStreamsBaseUrl, namespace })

    expect(result.started).toMatchObject({
      contextId: result.session.contextId,
      inserted: true,
    })
    expect(result.observedIntent).toMatchObject({
      intentId: result.intent.intentId,
      contextId: result.session.contextId,
    })
    expect(result.firstOutput).toMatchObject({
      contextId: result.session.contextId,
      sequence: 0,
      _tag: "TextChunk",
    })
    expect(textDeltaFromObservation(result.firstOutput)).toBe("first")
    expect(result.secondOutput).toMatchObject({
      contextId: result.session.contextId,
      sequence: 1,
      _tag: "TextChunk",
    })
    expect(textDeltaFromObservation(result.secondOutput)).toBe("second")
    expect(result.terminated).toMatchObject({
      contextId: result.session.contextId,
      sequence: 2,
      _tag: "Terminated",
    })
    expect(result.exited).toMatchObject({
      contextId: result.session.contextId,
      status: "exited",
      exitCode: 0,
    })
    expect(textDeltas(result.snapshot)).toEqual(["first", "second"])
    expect(result.snapshot.agentOutputs.map(row => row.sequence)).toEqual([0, 1, 2])
    expect(result.snapshot.agentOutputs.map(row => row.contextId)).toEqual([
      result.session.contextId,
      result.session.contextId,
      result.session.contextId,
    ])
  })
})
