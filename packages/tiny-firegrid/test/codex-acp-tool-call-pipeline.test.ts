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
} from "@firegrid/host-sdk"
import { Clock, Effect, Layer, Schedule } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  codexAcpOpenAiEnvPolicy,
  tinyCodexAcpToolCallPipeline,
} from "../src/configurations/codex-acp-tool-call-pipeline.ts"

// TFIND-048 validation (SDD_MCP_ROUTE_URL_LIFECYCLE Amendment 1 §A1.4):
// the resumed Codex ACP migration runs ENTIRELY through the public
// client surface — `sessions.createOrLoad` + `session.prompt` +
// `session.start` + `session.snapshot` — with the URL-less
// `runtimeContextMcp` marker. There is NO pre-baked MCP URL, NO
// TFIND-038/039 control-plane reach-past, NO `as unknown as`. The host
// reconciler materializes the context and the codec start path injects
// the concrete contextId-scoped MCP URL from the host's OWN bound
// listener. The only skip is the pre-existing environmental gate: this
// spawns a real Codex ACP agent and needs a live OPENAI_API_KEY.

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

const promptForToolCall = [
  "Use the MCP server available in this ACP session.",
  "Call the Firegrid `sleep` tool with durationMs 0.",
  "After the tool returns, respond exactly with: FIREGRID_TOOL_RESULT sleep slept=true",
  "Do not answer without making the tool call first.",
].join("\n")

type SnapshotObservation = RuntimeContextSnapshot["agentOutputs"][number]

// TFIND-048 forbids `as unknown as`. The typed `AgentOutputEvent` union
// is narrowed on `observation.event._tag` (the correct access pattern;
// the separate TFIND-047 envelope-`_tag` precision gap is NOT pulled
// into this PR), so `event.part.delta` is typed with no cast.
const textDeltaFromObservation = (
  observation: SnapshotObservation,
): string | undefined =>
  observation.event._tag === "TextChunk"
    ? observation.event.part.delta
    : undefined

const toolNameFromObservation = (
  observation: SnapshotObservation,
): string | undefined =>
  observation._tag === "ToolUse" ? observation.toolName : undefined

const textOf = (snapshot: RuntimeContextSnapshot): string =>
  snapshot.agentOutputs
    .flatMap(row => {
      const delta = textDeltaFromObservation(row)
      return delta === undefined ? [] : [delta]
    })
    .join("")

const hasReady = (snapshot: RuntimeContextSnapshot): boolean =>
  snapshot.agentOutputs.some(row => row.event._tag === "Ready")

const hasSleepToolUse = (snapshot: RuntimeContextSnapshot): boolean =>
  snapshot.agentOutputs.some(row => toolNameFromObservation(row) === "sleep")

const hasCompletedToolCallResponse = (
  snapshot: RuntimeContextSnapshot,
): boolean =>
  hasReady(snapshot) &&
  hasSleepToolUse(snapshot) &&
  textOf(snapshot).includes("FIREGRID_TOOL_RESULT")

describe("tiny-firegrid Codex ACP MCP tool-call pipeline", () => {
  const maybeIt = hasOpenAiKey() ? it : it.skip

  maybeIt(
    "firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.1 firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.6 spawns Codex ACP via the client surface and observes a host-provisioned MCP-backed Firegrid tool call",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-codex-acp-${crypto.randomUUID()}`
      const externalKey = {
        source: "tiny-firegrid",
        id: "codex-acp-tool-call",
      }

      const snapshot = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          // Host: reconciler daemon + bound MCP listener (OS-chosen
          // port). The daemon materializes the client's context request
          // and the codec start path injects the concrete MCP URL from
          // the host's own bound listener.
          yield* Layer.build(tinyCodexAcpToolCallPipeline({
            baseUrl: durableStreamsBaseUrl,
            namespace,
            localProcessEnv: codexLocalProcessEnv(),
            envPolicy: codexAcpOpenAiEnvPolicy(globalThis.process.env),
          }))

          // Pure client surface: create the session with the URL-less
          // runtime-context MCP marker. No contextId pre-derivation, no
          // pre-baked URL, no control-plane reach-past.
          const contextId = yield* provideClient(
            Effect.gen(function*() {
              const firegrid = yield* Firegrid
              const session = yield* firegrid.sessions.createOrLoad({
                externalKey,
                runtime: local.jsonl({
                  argv: [...codexAcpArgv],
                  agent: "codex-acp",
                  agentProtocol: "acp",
                  cwd: globalThis.process.cwd(),
                  envBindings: [
                    { name: "OPENAI_API_KEY", ref: "env:OPENAI_API_KEY" },
                  ],
                  runtimeContextMcp: { enabled: true },
                }),
                createdBy: "tiny-firegrid",
              })
              // #332 model: `createOrLoad` writes a context REQUEST; the
              // host reconciler daemon materializes it asynchronously.
              // A client does not reach past — it waits for the host to
              // materialize, retrying the ingress append until the
              // context exists (bounded).
              yield* session.prompt({
                payload: promptForToolCall,
                idempotencyKey: "codex-acp-tool-call-turn-1",
              }).pipe(
                Effect.retry(
                  Schedule.intersect(
                    Schedule.spaced("1000 millis"),
                    Schedule.recurs(60),
                  ),
                ),
              )
              yield* session.start()
              return session.contextId
            }),
            { baseUrl: durableStreamsBaseUrl, namespace },
          )

          // Poll the client snapshot until the host-provisioned MCP URL
          // has driven a real Firegrid `sleep` tool call to completion.
          // Budget is generous: this spawns a real `npx` Codex agent
          // (cold-start download) plus live LLM round-trips.
          const deadline = (yield* Clock.currentTimeMillis) + 260_000
          const readContextSnapshot = provideClient(
            Effect.gen(function*() {
              const firegrid = yield* Firegrid
              const session = yield* firegrid.sessions.attach({
                sessionId: contextId,
              })
              return yield* session.snapshot()
            }),
            { baseUrl: durableStreamsBaseUrl, namespace },
          ).pipe(
            // The context is materialized (prompt succeeded), but the
            // snapshot can transiently error during agent cold-start.
            Effect.retry(
              Schedule.intersect(
                Schedule.spaced("1000 millis"),
                Schedule.recurs(5),
              ),
            ),
          )
          let current = yield* readContextSnapshot
          while (!hasCompletedToolCallResponse(current)) {
            if ((yield* Clock.currentTimeMillis) >= deadline) break
            yield* Clock.sleep("1000 millis")
            current = yield* readContextSnapshot
          }
          return current
        })),
      )

      if (!hasCompletedToolCallResponse(snapshot)) {
        // Diagnostic: surface what the agent actually produced so a
        // host-provisioned-URL regression is distinguishable from a
        // slow/absent real-LLM tool call.
        console.error("[codex-acp] incomplete snapshot", JSON.stringify({
          tags: snapshot.agentOutputs.map(row => row._tag),
          eventTags: snapshot.agentOutputs.map(row => row.event._tag),
          text: textOf(snapshot).slice(0, 2000),
        }))
      }

      expect(hasReady(snapshot)).toBe(true)
      expect(hasSleepToolUse(snapshot)).toBe(true)
      const sleepToolUse = snapshot.agentOutputs.find(
        row => toolNameFromObservation(row) === "sleep",
      )
      expect(sleepToolUse).toMatchObject({
        _tag: "ToolUse",
        toolName: "sleep",
      })
      expect(textOf(snapshot)).toContain("FIREGRID_TOOL_RESULT")
    },
    300_000,
  )
})
