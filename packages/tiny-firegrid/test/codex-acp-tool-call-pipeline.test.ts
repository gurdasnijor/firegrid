import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type RuntimeContextSnapshot,
} from "@firegrid/client-sdk/firegrid"
import {
  localProcessSpawnEnvFromHostEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import {
  CurrentHostSession,
  firegridRuntimeContextMcpDeclaration,
  makeLocalRuntimeContextForHostSession,
  normalizeRuntimeIntent,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
  runtimeContextOutputStreamUrl,
  type RuntimeContext,
  type RuntimeInputIntentRow,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import type {
  CurrentHostStopped,
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
import { createServer } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  codexAcpOpenAiEnvPolicy,
  codexAcpToolCallMcpUrl,
  tinyCodexAcpToolCallPipeline,
} from "../src/configurations/codex-acp-tool-call-pipeline.ts"

type CodexAcpHostContext = Context.Context<FiregridHost>

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

const hasOpenAiKey = (): boolean =>
  typeof globalThis.process.env.OPENAI_API_KEY === "string" &&
  globalThis.process.env.OPENAI_API_KEY.length > 0

if (!hasOpenAiKey()) {
  console.warn(
    "Skipping tiny-firegrid Codex ACP MCP tool-call scenario: OPENAI_API_KEY is not set.",
  )
}

const codexAcpArgv = [
  "npx",
  "-y",
  "@zed-industries/codex-acp@0.14.0",
] as const

const codexLocalProcessEnv = () => {
  const base = localProcessSpawnEnvFromHostEnv(globalThis.process.env)
  const baselineEnvVars = { ...(base.baselineEnvVars ?? {}) }
  for (const key of [
    "HOME",
    "TMPDIR",
    "TEMP",
    "USER",
    "LOGNAME",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ]) {
    const value = globalThis.process.env[key]
    if (value !== undefined && value.length > 0) baselineEnvVars[key] = value
  }
  return {
    ...base,
    baselineEnvVars,
  }
}

const reserveLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = createServer()
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      if (address === null || typeof address === "string") {
        socket.close(() => reject(new Error("expected TCP address")))
        return
      }
      const port = address.port
      socket.close((error) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
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
    readonly hostContext: CodexAcpHostContext
    readonly mcpUrl: string
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
      normalizeRuntimeIntent(local.jsonl({
        argv: [...codexAcpArgv],
        agent: "codex-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [{ name: "OPENAI_API_KEY", ref: "env:OPENAI_API_KEY" }],
        mcpServers: [firegridRuntimeContextMcpDeclaration(input.mcpUrl)],
      })),
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

const promptForToolCall = [
  "Use the MCP server available in this ACP session.",
  "Call the Firegrid `sleep` tool with durationMs 0.",
  "After the tool returns, respond exactly with: FIREGRID_TOOL_RESULT sleep slept=true",
  "Do not answer without making the tool call first.",
].join("\n")

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
      payload: promptForToolCall,
      idempotencyKey: "codex-acp-tool-call-turn-1",
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

const textDeltaFromObservation = (
  observation: RuntimeContextSnapshot["agentOutputs"][number],
): string | undefined => {
  if (observation._tag !== "TextChunk") return undefined
  const event = asRecord(observation.event)
  const part = asRecord(event?.part)
  const delta = part?.delta
  return typeof delta === "string" ? delta : undefined
}

const toolNameFromObservation = (
  observation: RuntimeContextSnapshot["agentOutputs"][number],
): string | undefined => {
  if (observation._tag !== "ToolUse") return undefined
  if (observation.toolName !== undefined) return observation.toolName
  const event = asRecord(observation.event)
  const part = asRecord(event?.part)
  const name = part?.name
  return typeof name === "string" ? name : undefined
}

const toolNameFromRuntimeObservation = (
  observation: RuntimeAgentOutputObservation,
): string | undefined =>
  observation._tag === "ToolUse" ? observation.toolName : undefined

const textDeltas = (
  snapshot: RuntimeContextSnapshot,
): ReadonlyArray<string> =>
  snapshot.agentOutputs.flatMap(row => {
    const delta = textDeltaFromObservation(row)
    return delta === undefined ? [] : [delta]
  })

const hasCompletedToolCallResponse = (
  snapshot: RuntimeContextSnapshot,
): boolean => {
  const text = textDeltas(snapshot).join("")
  const hasToolUse = snapshot.agentOutputs.some(row =>
    toolNameFromObservation(row) === "sleep")
  return hasToolUse && text.includes("FIREGRID_TOOL_RESULT")
}

const waitForSnapshot = (
  input: {
    readonly baseUrl: string
    readonly namespace: string
    readonly contextId: FiregridSessionId
    readonly timeoutMs: number
  },
) =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + input.timeoutMs
    let snapshot = yield* readSnapshot(input)
    while (!hasCompletedToolCallResponse(snapshot)) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return snapshot
      yield* Clock.sleep("500 millis")
      snapshot = yield* readSnapshot(input)
    }
    return snapshot
  })

describe("tiny-firegrid Codex ACP MCP tool-call pipeline", () => {
  const maybeIt = hasOpenAiKey() ? it : it.skip

  maybeIt(
    "firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.1 firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.6 spawns Codex ACP and observes an MCP-backed Firegrid tool call",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-codex-acp-${crypto.randomUUID()}`
      const mcpHost = "127.0.0.1"
      const mcpPort = await reserveLoopbackPort()
      const mcpPath = "/mcp"
      const externalKey = { source: "tiny-firegrid", id: "codex-acp-tool-call" }
      const contextId = sessionContextIdForExternalKey(externalKey)
      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const hostContext = yield* Layer.build(tinyCodexAcpToolCallPipeline({
            baseUrl: durableStreamsBaseUrl,
            namespace,
            mcpHost,
            mcpPort,
            mcpPath,
            localProcessEnv: codexLocalProcessEnv(),
            envPolicy: codexAcpOpenAiEnvPolicy(globalThis.process.env),
          }))
          const mcpUrl = codexAcpToolCallMcpUrl({
            host: mcpHost,
            port: mcpPort,
            path: mcpPath,
            contextId,
          })
          const control = Context.get(hostContext, RuntimeControlPlaneTable)
          const intentFiber = yield* waitForIntent(control, {
            contextId,
            timeoutMs: 10_000,
          }).pipe(Effect.forkScoped)
          const startedFiber = yield* waitForRunStatus(control, {
            contextId,
            status: "started",
            timeoutMs: 120_000,
          }).pipe(Effect.forkScoped)
          const runtimeContext = yield* createHostBoundSessionContext({
            contextId,
            hostContext,
            mcpUrl,
          })
          const readyFiber = yield* waitForOutputObservation({
            baseUrl: durableStreamsBaseUrl,
            context: runtimeContext,
            timeoutMs: 120_000,
            predicate: observation => observation._tag === "Ready",
          }).pipe(Effect.forkScoped)
          const toolUseFiber = yield* waitForOutputObservation({
            baseUrl: durableStreamsBaseUrl,
            context: runtimeContext,
            timeoutMs: 120_000,
            predicate: observation => toolNameFromRuntimeObservation(observation) === "sleep",
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
          const snapshot = yield* waitForSnapshot({
            baseUrl: durableStreamsBaseUrl,
            namespace,
            contextId,
            timeoutMs: 120_000,
          })
          return {
            snapshot,
            intent,
            observedIntent,
            runStarted,
            ready,
            toolUse,
          }
        })),
      )

      const text = textDeltas(result.snapshot).join("")
      const toolUse = result.snapshot.agentOutputs.find(row =>
        toolNameFromObservation(row) === "sleep",
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
      expect(Option.getOrUndefined(result.toolUse)).toMatchObject({
        contextId,
        _tag: "ToolUse",
        toolName: "sleep",
      })
      expect(toolUse).toBeDefined()
      expect(text).toContain("FIREGRID_TOOL_RESULT")
    },
    180_000,
  )
})
