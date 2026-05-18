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
import { Clock, Effect, Layer, Option, Stream, type Context, type Scope } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyStdioJsonlToolExecutionPipeline } from "../src/configurations/stdio-jsonl-tool-execution-pipeline.ts"

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
  hostLayer: ReturnType<typeof tinyStdioJsonlToolExecutionPipeline>,
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

const toolUseProviderExecuted = (
  observation: AgentOutputObservation,
): boolean | undefined => {
  if (observation.event._tag !== "ToolUse") return undefined
  return observation.event.part.providerExecuted
}

const toolNameFromObservation = (
  observation: AgentOutputObservation,
): string | undefined => {
  if (observation.event._tag !== "ToolUse") return undefined
  return observation.event.part.name
}

describe("tiny-firegrid stdio-jsonl tool-execution pipeline", () => {
  it(
    "firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1 executes a stdio-jsonl ToolUse through RuntimeToolUseExecutor and returns ToolResult to the agent",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-stdio-jsonl-tool-${crypto.randomUUID()}`
      const externalKey = { source: "tiny-firegrid", id: "stdio-jsonl-tool-call" }
      const hostLayer = tinyStdioJsonlToolExecutionPipeline({
        baseUrl: durableStreamsBaseUrl,
        namespace,
      })

      const result = await runWithPublicClient(({ control, firegrid }) => Effect.gen(function*() {
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey,
          runtime: stdioJsonlRuntime(stdioJsonlToolAgentScript),
          createdBy: "tiny-firegrid",
        })
        const started = yield* session.start()
        yield* launchHost(hostLayer)
        yield* waitForMaterializedContext(control, session)
        const intent = yield* session.prompt({
          payload: "Run the Firegrid sleep tool with durationMs 0, then report the result.",
          idempotencyKey: "stdio-jsonl-tool-call-turn-1",
        })
        const observedIntent = yield* waitForIntent(control, session, intent.intentId)
        const runStarted = yield* waitForRunStatus(control, session, "started", 30_000)
        const ready = yield* waitForAgentOutputMatching(
          session,
          observation => observation._tag === "Ready",
          30_000,
        )
        const toolUse = yield* waitForAgentOutputMatching(
          session,
          observation =>
            observation._tag === "ToolUse" &&
            toolNameFromObservation(observation) === "sleep",
          30_000,
        )
        const finalText = yield* waitForAgentOutputMatching(
          session,
          observation =>
            textDeltaFromObservation(observation)?.includes(
              "FIREGRID_TOOL_RESULT sleep slept=true",
            ) === true,
          30_000,
        )
        const runExited = yield* waitForRunStatus(control, session, "exited", 30_000)
        const snapshot = yield* session.snapshot()
        return {
          finalText,
          intent,
          observedIntent,
          ready,
          runExited,
          runStarted,
          session,
          snapshot,
          started,
          toolUse,
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
      expect(result.runStarted).toMatchObject({
        contextId: result.session.contextId,
        status: "started",
      })
      expect(result.ready).toMatchObject({
        contextId: result.session.contextId,
        _tag: "Ready",
      })
      expect(result.toolUse).toMatchObject({
        contextId: result.session.contextId,
        _tag: "ToolUse",
        toolName: "sleep",
      })
      expect(toolUseProviderExecuted(result.toolUse)).toBe(false)
      // TFIND-041: `ToolUse` does not carry a full lifecycle discriminant.
      // The public proof that stdio-jsonl requested Firegrid execution is
      // indirect: providerExecuted=false plus a later agent TextChunk that
      // could only be emitted after the codec received a ToolResult.
      expect(result.finalText).toMatchObject({
        contextId: result.session.contextId,
        _tag: "TextChunk",
      })
      expect(textDeltaFromObservation(result.finalText)).toContain(
        "FIREGRID_TOOL_RESULT sleep slept=true",
      )
      expect(result.runExited).toMatchObject({
        contextId: result.session.contextId,
        status: "exited",
        exitCode: 0,
      })
      expect(result.snapshot.context).toMatchObject({
        contextId: result.session.contextId,
      })
    },
    60_000,
  )
})
