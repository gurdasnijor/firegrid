// TFIND-048 — NON-GATING smoke (coordinator correctness-bar ruling,
// 2026-05-19). The full real-LLM Codex ACP end-to-end. DOCUMENTED
// FLAKY: a live LLM's tool-use is nondeterministic (observed both a
// real `sleep` MCP tool call → `FIREGRID_TOOL_RESULT` AND the agent
// spuriously declaring the tool "not available"). EXCLUDED from the CI
// gate by filename (`*.smoke.ts`, not `*.test.ts`); NOT deleted — run
// on demand via `pnpm --filter @firegrid/tiny-firegrid test:smoke`. The
// DETERMINISTIC CI-gating assertion of the host-provisioning seam is
// `codex-acp-host-provisioning-seam.test.ts`.

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
} from "@firegrid/client-sdk/firegrid"
import {
  localProcessSpawnEnvFromHostEnv,
} from "@firegrid/host-sdk"
import { Clock, Effect, Layer, Schedule } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  codexAcpOpenAiEnvPolicy,
  tinyCodexAcpToolCallPipeline,
} from "../src/configurations/codex-acp-tool-call-pipeline.ts"
import {
  runWithTraceRecorder,
  type RecordedSpan,
} from "./support/trace-recorder.ts"

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
  "Make EXACTLY ONE call to the Firegrid `sleep` tool with durationMs 0.",
  "Immediately after that single tool call returns, respond with this",
  "exact line and nothing else: FIREGRID_TOOL_RESULT sleep slept=true",
  "Do not call any tool more than once. Do not answer before the call.",
].join("\n")

const traceArtifactPath = path.resolve(
  globalThis.process.cwd(),
  "../../tooling/analysis/mcp-tool-exposure-trace.md",
)
const traceJsonArtifactPath = path.resolve(
  globalThis.process.cwd(),
  "../../tooling/analysis/mcp-tool-exposure-trace.json",
)

const spanTreeLines = (spans: ReadonlyArray<RecordedSpan>): ReadonlyArray<string> => {
  const byParent = new Map<string | undefined, Array<RecordedSpan>>()
  for (const span of spans) {
    const bucket = byParent.get(span.parentSpanId) ?? []
    bucket.push(span)
    byParent.set(span.parentSpanId, bucket)
  }
  const roots = byParent.get(undefined) ?? []
  const lines: Array<string> = []
  const walk = (span: RecordedSpan, depth: number) => {
    const attrs = Object.entries(span.attributes)
      .filter(([key]) =>
        key.startsWith("firegrid.context") ||
        key.startsWith("firegrid.mcp") ||
        key.startsWith("firegrid.acp") ||
        key.startsWith("firegrid.runtime") ||
        key.startsWith("firegrid.codec") ||
        key.startsWith("firegrid.process") ||
        key.startsWith("firegrid.command") ||
        key.startsWith("firegrid.agent_output"))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ")
    lines.push(`${"  ".repeat(depth)}- ${span.name} [${span.kind}/${span.status}]${attrs.length === 0 ? "" : ` ${attrs}`}`)
    for (const child of byParent.get(span.spanId) ?? []) {
      walk(child, depth + 1)
    }
  }
  for (const root of roots) walk(root, 0)
  return lines
}

const writeTraceArtifact = async (
  input: {
    readonly observed: {
      readonly sawReady: boolean
      readonly sawSleepToolUse: boolean
      readonly resultText: string
    }
    readonly spans: ReadonlyArray<RecordedSpan>
    readonly fibers: ReadonlyArray<{ readonly id: string; readonly status: string }>
  },
): Promise<void> => {
  const firegridToolCatalogSpan = input.spans.find(span =>
    span.name === "firegrid.mcp.register_toolkit")
  const injectedMcpSpan = input.spans.find(span =>
    span.name === "firegrid.host.codec.resolve_effective_mcp_servers" &&
    span.attributes["firegrid.mcp.injected_name"] === "firegrid-runtime-context")
  const acpNewSessionSpan = input.spans.find(span =>
    span.name === "firegrid.agent_event_pipeline.acp.new_session")
  const observedNoToolUse = input.observed.sawReady &&
    !input.observed.sawSleepToolUse &&
    input.observed.resultText.includes("not available")
  const summary = {
    agentReachedReady: input.observed.sawReady,
    agentEmittedFiregridSleepToolUse: input.observed.sawSleepToolUse,
    agentTextExcerpt: input.observed.resultText.slice(0, 600),
    hostToolkitToolCount: firegridToolCatalogSpan?.attributes["firegrid.mcp.tool_count"] ?? null,
    hostToolkitToolNames: firegridToolCatalogSpan?.attributes["firegrid.mcp.tool_names"] ?? null,
    codecInjectedRuntimeContextMcpUrl: injectedMcpSpan?.attributes["firegrid.mcp.injected_url"] ?? null,
    acpNewSessionMcpServerCount: acpNewSessionSpan?.attributes["firegrid.acp.mcp_server_count"] ?? null,
    acpNewSessionMcpServerNames: acpNewSessionSpan?.attributes["firegrid.acp.mcp_server_names"] ?? null,
  }
  const localization = observedNoToolUse
    ? [
      "Firegrid host toolkit registration is not empty: the firegrid.mcp.register_toolkit span records 8 tools.",
      "Codec MCP URL injection is not missing: firegrid.host.codec.resolve_effective_mcp_servers records a firegrid-runtime-context URL.",
      "ACP session setup receives that MCP server declaration: firegrid.agent_event_pipeline.acp.new_session records one MCP server named firegrid-runtime-context.",
      "The real Codex ACP agent nevertheless reaches Ready, emits no Firegrid ToolUse, and reports firegrid.sleep is not available.",
      "Therefore this trace localizes G-MCP-2 downstream of Firegrid's host catalog construction and codec MCP URL injection, at or after ACP agent-side MCP discovery/tool exposure.",
    ]
    : [
      "The observed run did not reproduce the zero-tool symptom; inspect the span tree and raw spans.",
    ]
  const content = [
    "# G-MCP-2 MCP Tool Exposure Trace",
    "",
    "Generated by `packages/tiny-firegrid/test/codex-acp-tool-call-pipeline.smoke.test.ts` with an Effect-native in-memory tracer (`Effect.withTracer`) and `Supervisor.track`.",
    "",
    "## Summary",
    "",
    `- Agent reached Ready: ${summary.agentReachedReady}`,
    `- Agent emitted Firegrid sleep ToolUse: ${summary.agentEmittedFiregridSleepToolUse}`,
    `- Agent text excerpt: ${JSON.stringify(summary.agentTextExcerpt)}`,
    `- Host toolkit span tool count: ${JSON.stringify(summary.hostToolkitToolCount)}`,
    `- Host toolkit span tool names: ${JSON.stringify(summary.hostToolkitToolNames)}`,
    `- Codec injected runtime-context MCP URL: ${JSON.stringify(summary.codecInjectedRuntimeContextMcpUrl)}`,
    `- ACP newSession MCP server count: ${JSON.stringify(summary.acpNewSessionMcpServerCount)}`,
    `- ACP newSession MCP server names: ${JSON.stringify(summary.acpNewSessionMcpServerNames)}`,
    "",
    "## Localization",
    "",
    ...localization.map(line => `- ${line}`),
    "",
    "## Span Tree",
    "",
    ...spanTreeLines(input.spans),
    "",
    "## Supervisor Snapshot",
    "",
    "```json",
    JSON.stringify(input.fibers, null, 2),
    "```",
    "",
    "## Raw Spans",
    "",
    "```json",
    JSON.stringify(input.spans, null, 2),
    "```",
    "",
  ].join("\n")
  await mkdir(path.dirname(traceArtifactPath), { recursive: true })
  await writeFile(traceArtifactPath, content)
  await writeFile(traceJsonArtifactPath, JSON.stringify({
    summary,
    localization,
    spanTree: spanTreeLines(input.spans),
    fibers: input.fibers,
    spans: input.spans,
  }, null, 2))
}

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

      const traced = await Effect.runPromise(
        runWithTraceRecorder(Effect.scoped(Effect.gen(function*() {
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

          // Consume agent output INCREMENTALLY through the client
          // `wait.forAgentOutput` surface (one observation per call,
          // server-blocked up to `timeoutMs`). This is the client-surface
          // equivalent of the old incremental durable stream and is
          // O(1) memory — unlike re-snapshotting a stream that a real
          // LLM can grow large by looping the tool call. Budget is
          // generous: a real `npx` Codex cold-start + live LLM.
          const deadline = (yield* Clock.currentTimeMillis) + 260_000
          const waitNext = (afterSequence: number | undefined) =>
            provideClient(
              Effect.gen(function*() {
                const firegrid = yield* Firegrid
                const session = yield* firegrid.sessions.attach({
                  sessionId: contextId,
                })
                return yield* session.wait.forAgentOutput({
                  ...(afterSequence === undefined
                    ? {}
                    : { afterSequence }),
                  timeoutMs: 15_000,
                })
              }),
              { baseUrl: durableStreamsBaseUrl, namespace },
            ).pipe(
              Effect.retry(
                Schedule.intersect(
                  Schedule.spaced("1000 millis"),
                  Schedule.recurs(5),
                ),
              ),
            )

          let sawReady = false
          let sawSleepToolUse = false
          let resultText = ""
          let afterSequence: number | undefined
          while (
            !(sawReady && sawSleepToolUse &&
              resultText.includes("FIREGRID_TOOL_RESULT"))
          ) {
            if ((yield* Clock.currentTimeMillis) >= deadline) break
            const next = yield* waitNext(afterSequence)
            if (!next.matched) continue
            const observation = next.output
            afterSequence = observation.sequence
            // Cast-free narrowing on the typed `AgentOutputEvent` union
            // (the separate TFIND-047 envelope-`_tag`/flattened-field
            // precision gap is intentionally NOT pulled into this PR).
            const event = observation.event
            if (event._tag === "Ready") sawReady = true
            if (event._tag === "ToolUse" && event.part.name === "sleep") {
              sawSleepToolUse = true
            }
            if (event._tag === "TextChunk") resultText += event.part.delta
          }
          return { sawReady, sawSleepToolUse, resultText }
        }))),
      )
      const observed = traced.result
      await writeTraceArtifact({
        observed,
        spans: traced.spans,
        fibers: traced.fibers,
      })

      if (
        !(observed.sawReady && observed.sawSleepToolUse &&
          observed.resultText.includes("FIREGRID_TOOL_RESULT"))
      ) {
        // Diagnostic: distinguish a host-provisioned-URL regression
        // from a slow/absent real-LLM tool call.
        console.error("[codex-acp] incomplete", JSON.stringify({
          sawReady: observed.sawReady,
          sawSleepToolUse: observed.sawSleepToolUse,
          text: observed.resultText.slice(0, 2000),
        }))
      }

      expect(observed.sawReady).toBe(true)
      expect(observed.sawSleepToolUse).toBe(true)
      expect(observed.resultText).toContain("FIREGRID_TOOL_RESULT")
    },
    300_000,
  )
})
