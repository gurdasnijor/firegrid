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
import {
  tinyMultiContextProductionConsumingPipeline,
} from "../src/configurations/multi-context-production-consuming-pipeline.ts"

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

const waitForRunStatus = (
  control: ControlPlaneService,
  session: FiregridSessionHandle,
  status: "started" | "exited" | "failed",
  timeoutMs: number,
) =>
  firstWithinOrFail(
    control.runs.rows().pipe(
      Stream.filter(row =>
        row.contextId === session.contextId &&
        row.status === status,
      ),
    ),
    `${status} run for ${session.contextId}`,
    timeoutMs,
  )

const waitForAgentOutputMatching = (
  session: FiregridSessionHandle,
  predicate: (observation: AgentOutputObservation) => boolean,
  timeoutMs: number,
): Effect.Effect<AgentOutputObservation, Error> =>
  Effect.gen(function*() {
    const deadlineMs = (yield* Clock.currentTimeMillis) + timeoutMs
    let afterSequence: number | undefined

    while (true) {
      const nowMs = yield* Clock.currentTimeMillis
      if (nowMs >= deadlineMs) {
        return yield* Effect.fail(new Error(`timed out waiting for agent output from ${session.contextId}`))
      }
      const result = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: deadlineMs - nowMs,
      })
      if (!result.matched) {
        return yield* Effect.fail(new Error(`timed out waiting for agent output from ${session.contextId}`))
      }
      if (predicate(result.output)) return result.output
      afterSequence = result.output.sequence
    }
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
  hostLayer: ReturnType<typeof tinyMultiContextProductionConsumingPipeline>,
): Effect.Effect<void, DurableTableError, Scope.Scope> =>
  Layer.launch(hostLayer).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )

const textChunkLine = (delta: string): string =>
  encodeRuntimeAgentOutputEnvelope({
    _tag: "TextChunk",
    part: Response.textDeltaPart({
      id: "tiny-firegrid-multi-context",
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
    setTimeout(() => console.log(line), index * 20);
  });
  setTimeout(() => process.exit(0), outputs.length * 20 + 20);
});
setTimeout(() => process.exit(2), 30_000);
`

const runtime = (script: string) =>
  local.jsonl({
    argv: [process.execPath, "-e", script],
    cwd: globalThis.process.cwd(),
  })

const textDeltaFromObservation = (
  observation: AgentOutputObservation,
): string | undefined => {
  if (observation.event._tag !== "TextChunk") return undefined
  return observation.event.part.delta
}

const textDeltas = (
  snapshot: RuntimeContextSnapshot,
): ReadonlyArray<string> =>
  snapshot.agentOutputs.flatMap((row) => {
    const delta = textDeltaFromObservation(row)
    return delta === undefined ? [] : [delta]
  })

describe("tiny-firegrid multi-context production-consuming pipeline", () => {
  it(
    "routes interleaved public client intents to isolated per-context engines",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-multi-context-prod-${crypto.randomUUID()}`
      const hostLayer = tinyMultiContextProductionConsumingPipeline({
        baseUrl: durableStreamsBaseUrl,
        namespace,
      })

      const result = await runWithPublicClient(({ control, firegrid }) => Effect.gen(function*() {
        const left = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "tiny-firegrid", id: "multi-context-left" },
          runtime: runtime(promptDrivenAgentScript([
            "left:first",
            "left:second",
          ])),
          createdBy: "tiny-firegrid",
        })
        const right = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "tiny-firegrid", id: "multi-context-right" },
          runtime: runtime(promptDrivenAgentScript([
            "right:first",
            "right:second",
          ])),
          createdBy: "tiny-firegrid",
        })
        const leftStarted = yield* left.start()
        const rightStarted = yield* right.start()
        yield* launchHost(hostLayer)
        const leftContext = yield* waitForMaterializedContext(control, left)
        const rightContext = yield* waitForMaterializedContext(control, right)

        const leftIntent = yield* left.prompt({
          payload: { type: "text", text: "left turn" },
          idempotencyKey: "left-turn-1",
        })
        const rightIntent = yield* right.prompt({
          payload: { type: "text", text: "right turn" },
          idempotencyKey: "right-turn-1",
        })
        const observedRightIntent = yield* waitForIntent(control, right, rightIntent.intentId)
        const observedLeftIntent = yield* waitForIntent(control, left, leftIntent.intentId)
        const leftRunStarted = yield* waitForRunStatus(control, left, "started", 30_000)
        const rightRunStarted = yield* waitForRunStatus(control, right, "started", 30_000)
        const leftFirstOutput = yield* waitForAgentOutputMatching(
          left,
          observation => textDeltaFromObservation(observation) === "left:first",
          30_000,
        )
        const rightFirstOutput = yield* waitForAgentOutputMatching(
          right,
          observation => textDeltaFromObservation(observation) === "right:first",
          30_000,
        )
        const leftSecondOutput = yield* waitForAgentOutputMatching(
          left,
          observation => textDeltaFromObservation(observation) === "left:second",
          30_000,
        )
        const rightSecondOutput = yield* waitForAgentOutputMatching(
          right,
          observation => textDeltaFromObservation(observation) === "right:second",
          30_000,
        )
        const leftExited = yield* waitForRunStatus(control, left, "exited", 30_000)
        const rightExited = yield* waitForRunStatus(control, right, "exited", 30_000)
        const leftSnapshot = yield* left.snapshot()
        const rightSnapshot = yield* right.snapshot()
        return {
          left,
          leftContext,
          leftExited,
          leftFirstOutput,
          leftIntent,
          leftRunStarted,
          leftSecondOutput,
          leftSnapshot,
          leftStarted,
          observedLeftIntent,
          observedRightIntent,
          right,
          rightContext,
          rightExited,
          rightFirstOutput,
          rightIntent,
          rightRunStarted,
          rightSecondOutput,
          rightSnapshot,
          rightStarted,
        }
      }), { baseUrl: durableStreamsBaseUrl, namespace })

      expect(result.left.contextId).not.toBe(result.right.contextId)
      expect(result.leftStarted).toMatchObject({
        contextId: result.left.contextId,
        inserted: true,
      })
      expect(result.rightStarted).toMatchObject({
        contextId: result.right.contextId,
        inserted: true,
      })
      expect(result.leftContext).toMatchObject({
        contextId: result.left.contextId,
      })
      expect(result.rightContext).toMatchObject({
        contextId: result.right.contextId,
      })
      expect(result.leftRunStarted).toMatchObject({
        contextId: result.left.contextId,
        status: "started",
      })
      expect(result.rightRunStarted).toMatchObject({
        contextId: result.right.contextId,
        status: "started",
      })
      expect(result.observedLeftIntent).toMatchObject({
        intentId: result.leftIntent.intentId,
        contextId: result.left.contextId,
      })
      expect(result.observedRightIntent).toMatchObject({
        intentId: result.rightIntent.intentId,
        contextId: result.right.contextId,
      })
      expect(result.leftFirstOutput).toMatchObject({
        contextId: result.left.contextId,
        sequence: 0,
      })
      expect(result.rightFirstOutput).toMatchObject({
        contextId: result.right.contextId,
        sequence: 0,
      })
      expect(result.leftSecondOutput).toMatchObject({
        contextId: result.left.contextId,
        sequence: 1,
      })
      expect(result.rightSecondOutput).toMatchObject({
        contextId: result.right.contextId,
        sequence: 1,
      })
      expect(result.leftExited).toMatchObject({
        contextId: result.left.contextId,
        status: "exited",
        exitCode: 0,
      })
      expect(result.rightExited).toMatchObject({
        contextId: result.right.contextId,
        status: "exited",
        exitCode: 0,
      })
      expect(textDeltas(result.leftSnapshot)).toEqual([
        "left:first",
        "left:second",
      ])
      expect(textDeltas(result.rightSnapshot)).toEqual([
        "right:first",
        "right:second",
      ])
      expect(result.leftSnapshot.agentOutputs.map(row => row.contextId)).toEqual([
        result.left.contextId,
        result.left.contextId,
        result.left.contextId,
      ])
      expect(result.rightSnapshot.agentOutputs.map(row => row.contextId)).toEqual([
        result.right.contextId,
        result.right.contextId,
        result.right.contextId,
      ])
    },
    60_000,
  )
})
