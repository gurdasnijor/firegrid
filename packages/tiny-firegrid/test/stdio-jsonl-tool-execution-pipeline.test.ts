import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
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
  type RuntimeInputIntentRow,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import {
  sessionContextIdForExternalKey,
  type FiregridSessionId,
} from "@firegrid/protocol/session-facade"
import {
  runtimeAgentOutputObservationFromRow,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import { Clock, Context, Effect, Layer, Option, Stream } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyStdioJsonlToolExecutionPipeline } from "../src/configurations/stdio-jsonl-tool-execution-pipeline.ts"

type StdioJsonlHostContext = Context.Context<FiregridHost>

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

const stdioJsonlToolAgentScript = `
let buffer = "";
let requestedTool = false;
let completed = false;

const emit = (event) => {
  process.stdout.write(JSON.stringify(event) + "\\n");
};

const handleLine = (line) => {
  if (line.trim().length === 0) return;
  const event = JSON.parse(line);
  if (event.type === "prompt" && !requestedTool) {
    requestedTool = true;
    emit({
      type: "tool_use",
      toolUseId: "tiny-sleep-1",
      name: "sleep",
      input: { durationMs: 0 }
    });
    return;
  }
  if (event.type === "tool_result" && event.toolUseId === "tiny-sleep-1") {
    completed = true;
    const slept = event.content && event.content.slept === true;
    emit({
      type: "text",
      text: "FIREGRID_TOOL_RESULT sleep slept=" + String(slept)
    });
    emit({ type: "turn_complete", finishReason: "stop" });
    setTimeout(() => process.exit(slept ? 0 : 3), 10);
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});

setTimeout(() => {
  if (!completed) process.exit(requestedTool ? 4 : 2);
}, 5_000);
`

const stdioJsonlRuntime = (script: string) =>
  local.jsonl({
    argv: [process.execPath, "-e", script],
    agent: "tiny-stdio-jsonl-tool",
    agentProtocol: "stdio-jsonl",
    cwd: globalThis.process.cwd(),
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

const firstWithin = <A, E, R>(
  self: Stream.Stream<A, E, R>,
  timeoutMs: number,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.raceFirst(
    Stream.runHead(self),
    Clock.sleep(`${timeoutMs} millis`).pipe(Effect.as(Option.none<A>())),
  )

const waitForIntent = (
  control: RuntimeControlPlaneTable["Type"],
  input: {
    readonly contextId: string
    readonly timeoutMs: number
  },
): Effect.Effect<Option.Option<RuntimeInputIntentRow>, DurableTableError> =>
  firstWithin(
    control.inputIntents.rows().pipe(
      Stream.filter(row => row.contextId === input.contextId),
    ),
    input.timeoutMs,
  )

const waitForRunStatus = (
  control: RuntimeControlPlaneTable["Type"],
  input: {
    readonly contextId: string
    readonly status: RuntimeRunEventRow["status"]
    readonly timeoutMs: number
  },
): Effect.Effect<Option.Option<RuntimeRunEventRow>, DurableTableError> =>
  firstWithin(
    control.runs.rows().pipe(
      Stream.filter(row =>
        row.contextId === input.contextId &&
        row.status === input.status,
      ),
    ),
    input.timeoutMs,
  )

const waitForOutputObservation = (
  input: {
    readonly baseUrl: string
    readonly context: RuntimeContext
    readonly timeoutMs: number
    readonly predicate: (observation: RuntimeAgentOutputObservation) => boolean
  },
): Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, DurableTableError> =>
  firstWithin(
    Stream.unwrap(
      Effect.map(RuntimeOutputTable, table =>
        table.events.rows().pipe(
          Stream.filterMap(runtimeAgentOutputObservationFromRow),
          Stream.filter(row =>
            row.contextId === input.context.contextId &&
            input.predicate(row),
          ),
        )),
    ).pipe(
      Stream.provideLayer(perContextOutputTableLayer({
        baseUrl: input.baseUrl,
        context: input.context,
      })),
    ),
    input.timeoutMs,
  )

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
    readonly contextId: FiregridSessionId
    readonly hostContext: StdioJsonlHostContext
  },
): Effect.Effect<RuntimeContext, DurableTableError | CurrentHostStopped, never> =>
  Effect.gen(function*() {
    // TFIND-038: temporary reach-past until client session creation can
    // express full public runtime intent without host-bound row construction.
    const table = Context.get(input.hostContext, RuntimeControlPlaneTable)
    const session = Context.get(input.hostContext, CurrentHostSession)
    const createdAtMs = yield* Clock.currentTimeMillis
    const runtimeContext = yield* makeLocalRuntimeContextForHostSession(
      session,
      normalizeRuntimeIntent(stdioJsonlRuntime(stdioJsonlToolAgentScript)),
      {
        contextId: input.contextId,
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
      payload: "Run the Firegrid sleep tool with durationMs 0, then report the result.",
      idempotencyKey: "stdio-jsonl-tool-call-turn-1",
    })
  }), input)

const textDeltaFromRuntimeObservation = (
  observation: RuntimeAgentOutputObservation,
): string | undefined => {
  if (observation.event._tag !== "TextChunk") return undefined
  return observation.event.part.delta
}

const toolUseProviderExecuted = (
  observation: RuntimeAgentOutputObservation,
): boolean | undefined => {
  if (observation.event._tag !== "ToolUse") return undefined
  return observation.event.part.providerExecuted
}

describe("tiny-firegrid stdio-jsonl tool-execution pipeline", () => {
  it(
    "firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1 executes a stdio-jsonl ToolUse through RuntimeToolUseExecutor and returns ToolResult to the agent",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-stdio-jsonl-tool-${crypto.randomUUID()}`
      const externalKey = { source: "tiny-firegrid", id: "stdio-jsonl-tool-call" }
      const contextId = sessionContextIdForExternalKey(externalKey)
      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const hostContext = yield* Layer.build(tinyStdioJsonlToolExecutionPipeline({
            baseUrl: durableStreamsBaseUrl,
            namespace,
          }))
          const control = Context.get(hostContext, RuntimeControlPlaneTable)
          const intentFiber = yield* waitForIntent(control, {
            contextId,
            timeoutMs: 10_000,
          }).pipe(Effect.forkScoped)
          const startedFiber = yield* waitForRunStatus(control, {
            contextId,
            status: "started",
            timeoutMs: 30_000,
          }).pipe(Effect.forkScoped)
          const exitedFiber = yield* waitForRunStatus(control, {
            contextId,
            status: "exited",
            timeoutMs: 30_000,
          }).pipe(Effect.forkScoped)
          const runtimeContext = yield* createHostBoundSessionContext({
            contextId,
            hostContext,
          })
          const readyFiber = yield* waitForOutputObservation({
            baseUrl: durableStreamsBaseUrl,
            context: runtimeContext,
            timeoutMs: 30_000,
            predicate: observation => observation._tag === "Ready",
          }).pipe(Effect.forkScoped)
          const toolUseFiber = yield* waitForOutputObservation({
            baseUrl: durableStreamsBaseUrl,
            context: runtimeContext,
            timeoutMs: 30_000,
            predicate: observation =>
              observation._tag === "ToolUse" &&
              observation.toolName === "sleep",
          }).pipe(Effect.forkScoped)
          const finalTextFiber = yield* waitForOutputObservation({
            baseUrl: durableStreamsBaseUrl,
            context: runtimeContext,
            timeoutMs: 30_000,
            predicate: observation =>
              textDeltaFromRuntimeObservation(observation)?.includes(
                "FIREGRID_TOOL_RESULT sleep slept=true",
              ) === true,
          }).pipe(Effect.forkScoped)
          const intent = yield* appendPrompt({
            baseUrl: durableStreamsBaseUrl,
            namespace,
            contextId,
          })
          // TFIND-039: temporary reach-past until clients can record a durable
          // start trigger or hosts auto-start eligible contexts.
          const starter = Context.get(hostContext, RuntimeStartCapability)
          yield* starter.start({ contextId }).pipe(
            Effect.provide(hostContext),
            Effect.forkScoped,
          )
          const observedIntent = yield* intentFiber
          const runStarted = yield* startedFiber
          const ready = yield* readyFiber
          const toolUse = yield* toolUseFiber
          const finalText = yield* finalTextFiber
          const runExited = yield* exitedFiber
          return {
            intent,
            observedIntent,
            runStarted,
            ready,
            toolUse,
            finalText,
            runExited,
          }
        })),
      )

      expect(Option.getOrUndefined(result.observedIntent)).toMatchObject({
        intentId: result.intent.intentId,
        contextId,
      })
      expect(Option.getOrUndefined(result.runStarted)).toMatchObject({
        contextId,
        status: "started",
      })
      expect(Option.getOrUndefined(result.ready)).toMatchObject({
        contextId,
        _tag: "Ready",
      })
      const toolUse = Option.getOrUndefined(result.toolUse)
      expect(toolUse).toMatchObject({
        contextId,
        _tag: "ToolUse",
        toolName: "sleep",
      })
      expect(toolUse === undefined ? undefined : toolUseProviderExecuted(toolUse)).toBe(false)
      // TFIND-041: `ToolUse` does not carry a full lifecycle discriminant.
      // The public proof that stdio-jsonl requested Firegrid execution is
      // indirect: providerExecuted=false plus a later agent TextChunk that
      // could only be emitted after the codec received a ToolResult.
      expect(Option.getOrUndefined(result.finalText)).toMatchObject({
        contextId,
        _tag: "TextChunk",
      })
      expect(textDeltaFromRuntimeObservation(
        Option.getOrThrow(result.finalText),
      )).toContain("FIREGRID_TOOL_RESULT sleep slept=true")
      expect(Option.getOrUndefined(result.runExited)).toMatchObject({
        contextId,
        status: "exited",
        exitCode: 0,
      })
    },
    60_000,
  )
})
