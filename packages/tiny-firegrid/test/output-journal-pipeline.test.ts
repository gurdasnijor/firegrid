import { Response } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type RuntimeContextSnapshot,
} from "@firegrid/client-sdk/firegrid"
import type { FiregridHost } from "@firegrid/host-sdk"
import {
  CurrentHostSession,
  makeLocalRuntimeContextForHostSession,
  normalizeRuntimeIntent,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
  runtimeContextOutputStreamUrl,
  type CurrentHostStopped,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeStartResult,
} from "@firegrid/protocol/launch"
import {
  sessionContextIdForExternalKey,
  type FiregridSessionId,
} from "@firegrid/protocol/session-facade"
import {
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/runtime/events"
import { Clock, Context, Effect, Layer, Option } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyOutputJournalPipeline } from "../src/configurations/output-journal-pipeline.ts"

type OutputJournalHostContext = Context.Context<FiregridHost>

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

const createHostBoundSessionContext = (
  input: {
    readonly externalKey: { readonly source: string; readonly id: string }
    readonly hostContext: OutputJournalHostContext
    readonly runtimeScript: string
  },
): Effect.Effect<RuntimeContext, DurableTableError | CurrentHostStopped, never> =>
  Effect.gen(function*() {
    // TFIND-038: temporary reach-past until client session creation can
    // express full public runtime intent without host-bound row construction.
    const table = Context.get(input.hostContext, RuntimeControlPlaneTable)
    const session = Context.get(input.hostContext, CurrentHostSession)
    const contextId = sessionContextIdForExternalKey(input.externalKey)
    const createdAtMs = yield* Clock.currentTimeMillis
    const runtimeContext = yield* makeLocalRuntimeContextForHostSession(
      session,
      normalizeRuntimeIntent(runtime(input.runtimeScript)),
      {
        contextId,
        createdAtMs,
        createdBy: "tiny-firegrid",
      },
    )
    yield* table.contexts.upsert(runtimeContext)
    return runtimeContext
  }).pipe(
    Effect.provide(input.hostContext),
  )

const appendPrompt = (
  input: {
    readonly baseUrl: string
    readonly namespace: string
    readonly contextId: FiregridSessionId
  },
) =>
  provideClient(Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.attach({ sessionId: input.contextId })
    return yield* session.prompt({
      payload: { type: "text", text: "drive output journal" },
      idempotencyKey: "output-journal-turn-1",
    })
  }), input)

const readSnapshot = (
  input: {
    readonly baseUrl: string
    readonly namespace: string
    readonly contextId: FiregridSessionId
  },
) =>
  provideClient(Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.attach({ sessionId: input.contextId })
    // TFIND-040: temporary polling path until the client SDK exposes a
    // session-scoped event stream / richer wait surface.
    return yield* session.snapshot()
  }), input)

const startRuntime = (
  input: {
    readonly hostContext: OutputJournalHostContext
    readonly contextId: string
  },
): Effect.Effect<RuntimeStartResult, unknown, never> =>
  Effect.gen(function*() {
    // TFIND-039: temporary reach-past until clients can record a durable
    // start request or hosts can reconcile active contexts automatically.
    const starter = Context.get(input.hostContext, RuntimeStartCapability)
    return yield* starter.start({ contextId: input.contextId })
  }).pipe(
    Effect.provide(input.hostContext),
  )

const readHostAmbientOutputRows = (
  hostContext: OutputJournalHostContext,
): Effect.Effect<ReadonlyArray<RuntimeEventRow>, DurableTableError, never> =>
  Effect.gen(function*() {
    const output = Context.get(hostContext, RuntimeOutputTable)
    return yield* output.events.query(coll => coll.toArray)
  })

const perContextOutputTableLayer = (
  input: {
    readonly baseUrl: string
    readonly context: RuntimeContext
  },
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: input.baseUrl,
        prefix: input.context.host.streamPrefix,
        contextId: input.context.contextId,
      }),
      contentType: "application/json",
    },
  })

const readPerContextOutputRows = (
  input: {
    readonly baseUrl: string
    readonly context: RuntimeContext
  },
): Effect.Effect<ReadonlyArray<RuntimeEventRow>, DurableTableError> =>
  Effect.map(
    RuntimeOutputTable,
    table => table.events.query(coll => coll.toArray),
  ).pipe(
    Effect.flatten,
    Effect.provide(perContextOutputTableLayer(input)),
  )

const textDeltas = (
  snapshot: RuntimeContextSnapshot,
): ReadonlyArray<string> =>
  snapshot.agentOutputs.flatMap(row => {
    if (row._tag !== "TextChunk") return []
    const event = row.event as { readonly part?: { readonly delta?: unknown } }
    return typeof event.part?.delta === "string" ? [event.part.delta] : []
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

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const hostContext = yield* Layer.build(hostLayer)
      const runtimeContext = yield* createHostBoundSessionContext({
        externalKey: { source: "tiny-firegrid", id: "output-journal" },
        hostContext,
        runtimeScript: outputJournalAgentScript(["first", "second"]),
      })
      yield* appendPrompt({
        baseUrl: durableStreamsBaseUrl,
        namespace,
        contextId: runtimeContext.contextId as FiregridSessionId,
      })
      const started = yield* startRuntime({
        hostContext,
        contextId: runtimeContext.contextId,
      })
      const hostAmbientRows = yield* readHostAmbientOutputRows(hostContext)
      const perContextRows = yield* readPerContextOutputRows({
        baseUrl: durableStreamsBaseUrl,
        context: runtimeContext,
      })
      const snapshot = yield* readSnapshot({
        baseUrl: durableStreamsBaseUrl,
        namespace,
        contextId: runtimeContext.contextId as FiregridSessionId,
      })
      return {
        hostAmbientRows,
        perContextRows,
        perContextObservations: perContextRows.flatMap(row => {
          const observation = runtimeAgentOutputObservationFromRow(row)
          return Option.isSome(observation) ? [observation.value] : []
        }),
        snapshot,
        started,
      }
    })))

    expect(result.started).toMatchObject({
      exitCode: 0,
      activityAttempt: 1,
    })
    expect(result.hostAmbientRows).toEqual([])
    expect(result.perContextRows.map(row => row.sequence)).toEqual([0, 1, 2])
    expect(result.perContextObservations.map(row => row._tag)).toEqual([
      "TextChunk",
      "TextChunk",
      "Terminated",
    ])
    expect(textDeltas(result.snapshot)).toEqual(["first", "second"])
    expect(result.snapshot.agentOutputs.map(row => row.sequence)).toEqual([0, 1, 2])
  })
})
