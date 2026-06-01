/**
 * LIVE foreign-ACP-adapter tests (tf-r06u.12 — adapter divergence + MCP-reach gate).
 *
 * These drive REAL published ACP adapter binaries (codex-acp, claude-agent-acp)
 * through the production codec `AcpSessionLive` + the real
 * `LocalProcessSandboxProvider` — the exact two seams
 * `ProductionCodecAdapterLive.buildSessionForContext` composes
 * (src/unified/codec-adapter.ts:264-317). They drive the PRIVATE codec/sandbox
 * seam (no client-sdk, no FiregridHost), so per tiny-firegrid methodology they
 * live in the owning package's test/ folder, NOT as a tiny-firegrid sim.
 *
 * GATED behind `FIREGRID_ACP_LIVE=1` (subprocess spawn + network + API creds)
 * so default CI skips them. Per adapter, the bin + credential must be present:
 *   - claude-agent-acp: resolved from the @firegrid/runtime devDependency;
 *     needs ANTHROPIC_API_KEY.
 *   - codex-acp: NOT a workspace dep (external adapter) — point at it via
 *     FIREGRID_CODEX_ACP_BIN=/abs/path/to/codex-acp/dist/index.js; needs
 *     OPENAI_API_KEY. (install: `npm i @agentclientprotocol/codex-acp` in any
 *     dir outside the pnpm workspace, then set the env to its dist/index.js.)
 *
 * The VERDICT is prose: docs/findings/tf-r06u-12-adapter-divergence-mcp-reach.md.
 * These tests are the cited evidence — they assert reachability, they do not
 * compute a verdict object.
 */
import { createServer, type Server as HttpServer } from "node:http"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IdGenerator, Prompt } from "@effect/ai"
import { NodeContext } from "@effect/platform-node"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { AcpSessionLive, AgentSession } from "../../../../src/sources/codecs/index.ts"
import { LocalProcessSandboxProvider, SandboxProvider } from "../../../../src/sources/sandbox/index.ts"
import type { AgentInputEvent, AgentOutputEvent } from "../../../../src/events/index.ts"

const LIVE = process.env["FIREGRID_ACP_LIVE"] === "1"
const require_ = createRequire(import.meta.url)

interface AdapterSpec {
  readonly name: string
  readonly argv: ReadonlyArray<string>
  readonly envKey: string
}

const resolveAdapters = (): ReadonlyArray<AdapterSpec> => {
  const specs: Array<AdapterSpec> = []
  // claude-agent-acp — resolved from the runtime devDependency (no abs path).
  try {
    const claudeBin = require_.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")
    if (process.env["ANTHROPIC_API_KEY"]) {
      specs.push({ name: "claude-agent-acp", argv: [process.execPath, claudeBin], envKey: "ANTHROPIC_API_KEY" })
    }
  } catch { /* not installed */ }
  // codex-acp — external adapter, located via env (not a workspace dep).
  const codexBin = process.env["FIREGRID_CODEX_ACP_BIN"]
  if (codexBin && process.env["OPENAI_API_KEY"]) {
    specs.push({ name: "codex-acp", argv: [process.execPath, codexBin], envKey: "OPENAI_API_KEY" })
  }
  return specs
}

const sandboxLayer = LocalProcessSandboxProvider.layer().pipe(Layer.provide(NodeContext.layer))
const idGenLayer = Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)

const envFor = (spec: AdapterSpec): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  [spec.envKey]: process.env[spec.envKey] ?? "",
})

/** Drive one turn through the real codec; return the AgentOutputEvent tag sequence. */
const driveTurn = (
  spec: AdapterSpec,
  promptText: string,
  options: { readonly mcpUrl?: string },
): Effect.Effect<ReadonlyArray<{ readonly tag: string; readonly toolName?: string }>, unknown> => {
  const work = mkdtempSync(join(tmpdir(), "acp-live-"))
  const envVars = envFor(spec)
  return Effect.gen(function*() {
    const provider = yield* SandboxProvider
    const sandbox = yield* provider.create({ workingDir: work, envVars })
    const bytes = yield* provider.openBytePipe(sandbox, { argv: spec.argv, cwd: work, envVars })
    return yield* Effect.gen(function*() {
      const session = yield* AgentSession
      const events: Array<{ readonly tag: string; readonly toolName?: string }> = []
      const consumer = yield* session.outputs.pipe(
        Stream.tap((e: AgentOutputEvent) =>
          Effect.sync(() => {
            events.push(e._tag === "ToolUse"
              ? { tag: e._tag, toolName: (e as { part?: { name?: string } }).part?.name ?? "" }
              : { tag: e._tag })
          })),
        Stream.takeUntil((e: AgentOutputEvent) => e._tag === "TurnComplete" || e._tag === "Terminated"),
        Stream.runDrain,
        Effect.timeout("120 seconds"),
        Effect.fork,
      )
      const prompt: AgentInputEvent = {
        _tag: "Prompt",
        prompt: Prompt.userMessage({ content: [Prompt.textPart({ text: promptText })] }),
        correlationId: "live-1",
      }
      yield* session.send(prompt)
      yield* consumer.await.pipe(Effect.ignore)
      return events
    }).pipe(
      Effect.provide(
        AcpSessionLive(bytes, {
          cwd: work,
          ...(options.mcpUrl === undefined
            ? {}
            : { mcpServers: [{ name: "firegrid", server: { type: "url", url: options.mcpUrl } }] }),
          permissionPolicy: "allow",
        }).pipe(Layer.provide(idGenLayer)),
      ),
    )
  }).pipe(Effect.scoped, Effect.provide(sandboxLayer))
}

/** A real HTTP MCP server exposing one `schedule_me` tool; records invocations. */
const startMcpServer = async (): Promise<{
  readonly url: string
  readonly methods: Array<string>
  readonly scheduleMeCalls: Array<unknown>
  readonly close: () => void
}> => {
  const methods: Array<string> = []
  const scheduleMeCalls: Array<unknown> = []
  const server = new McpServer({ name: "firegrid", version: "0.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "schedule_me",
      description: "Schedule a future prompt to the same agent context.",
      inputSchema: {
        type: "object",
        properties: {
          when: { type: "integer", minimum: 0, description: "Due timestamp (epoch ms)." },
          prompt: { type: "string", minLength: 1 },
        },
        required: ["when", "prompt"],
      },
    }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req: { params: { name: string; arguments?: unknown } }) => {
    if (req.params.name === "schedule_me") scheduleMeCalls.push(req.params.arguments)
    return { content: [{ type: "text", text: JSON.stringify({ scheduledId: "sched-live-1", accepted: true }) }] }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
  // server.connect's Transport param differs only by exactOptionalPropertyTypes
  // friction against the SDK's own interface; bridge via a typed indirection.
  const connect = server.connect.bind(server) as (t: unknown) => Promise<void>
  await connect(transport)
  const http: HttpServer = createServer((req, res) => {
    if (req.method !== "POST") { void transport.handleRequest(req, res); return }
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const ms = Array.isArray(parsed)
          ? parsed.map((m: { method?: string }) => m.method)
          : [(parsed as { method?: string }).method]
        for (const m of ms) if (typeof m === "string") methods.push(m)
      } catch { /* non-JSON */ }
      void transport.handleRequest(req, res, parsed)
    })
  })
  const port: number = await new Promise((resolve) =>
    http.listen(0, "127.0.0.1", () => resolve((http.address() as { port: number }).port)))
  return { url: `http://127.0.0.1:${port}/mcp`, methods, scheduleMeCalls, close: () => http.close() }
}

const adapters = LIVE ? resolveAdapters() : []

describe.skipIf(!LIVE)("LIVE: foreign ACP adapters through the production codec", () => {
  if (LIVE && adapters.length === 0) {
    it("no adapters available", () => {
      throw new Error("FIREGRID_ACP_LIVE=1 but no adapter bin+credential resolved (see file header)")
    })
  }

  // Divergence: each adapter completes a turn, reducing to the same AgentOutputEvent
  // vocabulary, through the UNMODIFIED codec.
  for (const spec of adapters) {
    it(`${spec.name}: completes a turn through AcpSessionLive (TurnComplete)`, async () => {
      const events = await Effect.runPromise(
        driveTurn(spec, "Reply with exactly the single word: PONG. Do not use any tools.", {}),
      )
      const tags = events.map(e => e.tag)
      expect(tags, JSON.stringify(tags)).toContain("Ready")
      expect(tags, JSON.stringify(tags)).toContain("TextChunk")
      expect(tags, JSON.stringify(tags)).toContain("TurnComplete")
    }, 180_000)
  }

  // MCP-surfacing reach (the §4 newSessionMeta gate): the choreography tool,
  // surfaced through the real codec MCP path, is actually callable by the LLM.
  for (const spec of adapters) {
    it(`${spec.name}: reaches + calls a Firegrid-surfaced schedule_me MCP tool`, async () => {
      const mcp = await startMcpServer()
      try {
        const events = await Effect.runPromise(
          driveTurn(
            spec,
            "You have an MCP tool named `schedule_me`. Call it exactly once, now, with arguments when=9999999999999 and prompt=\"check the build\". You MUST actually invoke the schedule_me tool. After it returns, reply DONE.",
            { mcpUrl: mcp.url },
          ),
        )
        expect(mcp.methods, JSON.stringify(mcp.methods)).toContain("tools/list")
        expect(mcp.scheduleMeCalls.length, "schedule_me was not invoked by the adapter LLM").toBeGreaterThan(0)
        expect(mcp.scheduleMeCalls[0]).toMatchObject({ when: 9999999999999, prompt: "check the build" })
        // The codec observed the provider-executed tool use (name convention is
        // dialect-specific: bare `schedule_me` vs namespaced `mcp.<server>.<tool>`).
        const toolUseNames = events.filter(e => e.tag === "ToolUse").map(e => e.toolName ?? "")
        expect(toolUseNames.some(n => n.includes("schedule_me")), JSON.stringify(toolUseNames)).toBe(true)
      } finally {
        mcp.close()
      }
    }, 180_000)
  }
})
