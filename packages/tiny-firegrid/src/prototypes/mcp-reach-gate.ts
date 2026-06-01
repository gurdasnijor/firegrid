/**
 * MCP-surfacing-reach GATE (RFC §5.5 × §6 / architect-elevated 2026-05-31).
 *
 * The §6 "config not code / small-rock" verdict has ONE un-run dependency: does
 * Firegrid's choreography surface actually REACH each adapter's LLM as a callable
 * tool? Choreography tools (schedule_me/wait_for/spawn) reach a downstream acpx
 * agent ONLY via MCP servers declared on session/new — and the codec's hardcoded
 * claude `_meta` (`acp/index.ts:200-234`) is precisely the MCP-reach coax
 * (alwaysLoad alias + disableBuiltInTools) the Claude Agent SDK needs to surface
 * deferred MCP tools. codex defers MCP differently. So reach is per-dialect and,
 * before this gate, unproven for codex.
 *
 * This harness stands up a REAL HTTP MCP server exposing a `schedule_me` tool
 * (the real protocol schema shape: {when:int>=0, prompt:string}), surfaces it
 * through the REAL codec MCP path (`AcpSessionOptions.mcpServers` →
 * lowerMcpServerDeclaration + claudeAgentAcpMeta), and prompts each adapter to
 * call it. MEASURED per adapter: tools/list seen? schedule_me CALLED? args?
 *
 *   FIREGRID_SPIKE_ADAPTER=claude-agent-acp|codex-acp  npx tsx mcp-reach-gate.ts
 */
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { IdGenerator, Prompt } from "@effect/ai"
import { AcpSessionLive, AgentSession } from "@firegrid/runtime/sources/codecs"
import { LocalProcessSandboxProvider, SandboxProvider } from "@firegrid/runtime/sources/sandbox"
import type { AgentInputEvent, AgentOutputEvent } from "@firegrid/runtime/events"
import { Effect, Layer, Stream } from "effect"

const PNPM = "/Users/gnijor/gurdasnijor/firegrid/firegrid-worktrees/pr765-adapter-spike/node_modules/.pnpm"
const { McpServer } = await import(`${PNPM}/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`)
const { StreamableHTTPServerTransport } = await import(`${PNPM}/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js`)
const { z } = await import(`${PNPM}/zod@4.4.3/node_modules/zod/index.js`)

const WT = "/Users/gnijor/gurdasnijor/firegrid/firegrid-worktrees/pr765-adapter-spike"
const ADAPTERS: Record<string, { argv: ReadonlyArray<string>; envKey: string }> = {
  "claude-agent-acp": {
    argv: [process.execPath, join(WT, "node_modules/.pnpm/@agentclientprotocol+claude-agent-acp@0.36.1_@anthropic-ai+sdk@0.97.1_zod@4.4.3__@model_b6d2333e11a1d0858a199bb549333483/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")],
    envKey: "ANTHROPIC_API_KEY",
  },
  "codex-acp": {
    argv: [process.execPath, "/tmp/acp-adapters/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
    envKey: "OPENAI_API_KEY",
  },
}
const name = process.env["FIREGRID_SPIKE_ADAPTER"] ?? "claude-agent-acp"
const spec = ADAPTERS[name]!
const work = mkdtempSync(join(tmpdir(), "mcp-reach-"))

// ── Measurement state ───────────────────────────────────────────────────────
const mcpMethods: Array<string> = []
const scheduleMeCalls: Array<unknown> = []

// ── Real HTTP MCP server exposing the real `schedule_me` tool shape ──────────
const mcp = new McpServer({ name: "firegrid", version: "0.0.0" })
mcp.registerTool(
  "schedule_me",
  {
    title: "Schedule-me tool input",
    description: "Schedule a future prompt to the same agent context.",
    inputSchema: { when: z.number().int().min(0), prompt: z.string().min(1) },
  },
  async (args: unknown) => {
    scheduleMeCalls.push(args)
    process.stderr.write(`[mcp] schedule_me CALLED args=${JSON.stringify(args)}\n`)
    return { content: [{ type: "text", text: JSON.stringify({ scheduledId: "sched-gate-1", accepted: true }) }] }
  },
)
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
await mcp.connect(transport)
const httpServer = createServer((req, res) => {
  if (req.method !== "POST") { void transport.handleRequest(req, res); return }
  const chunks: Array<Buffer> = []
  req.on("data", (c: Buffer) => chunks.push(c))
  req.on("end", () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const methods = Array.isArray(parsed) ? parsed.map((m: { method?: string }) => m.method) : [(parsed as { method?: string }).method]
      for (const m of methods) if (typeof m === "string") { mcpMethods.push(m); process.stderr.write(`[mcp] <- ${m}\n`) }
    } catch { /* non-JSON */ }
    void transport.handleRequest(req, res, parsed)
  })
})
const port: number = await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve((httpServer.address() as { port: number }).port)))
const mcpUrl = `http://127.0.0.1:${port}/mcp`
process.stderr.write(`[mcp] listening ${mcpUrl}\n`)

// ── Drive the adapter through the REAL codec, surfacing the MCP server ───────
const envVars: Record<string, string> = {
  PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", [spec.envKey]: process.env[spec.envKey] ?? "",
}
const program = Effect.gen(function*() {
  const provider = yield* SandboxProvider
  const sandbox = yield* provider.create({ workingDir: work, envVars })
  const bytes = yield* provider.openBytePipe(sandbox, { argv: spec.argv, cwd: work, envVars })

  const codecCtx = yield* Layer.buildWithScope(
    AcpSessionLive(bytes, {
      cwd: work,
      // The REAL codec MCP-surfacing path (claude → alwaysLoad _meta coax).
      mcpServers: [{ name: "firegrid", server: { type: "url", url: mcpUrl } }],
      permissionPolicy: "allow", // auto-allow any tool-permission prompt so the call isn't gated
    }).pipe(Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator))),
    yield* Effect.scope,
  )
  const session = codecCtx.unsafeMap.get(AgentSession.key) as AgentSession["Type"]

  const toolUses: Array<string> = []
  const consumer = yield* session.outputs.pipe(
    Stream.tap((e: AgentOutputEvent) => Effect.sync(() => {
      if (e._tag === "ToolUse") {
        const n = (e as { part?: { name?: string } }).part?.name ?? "?"
        toolUses.push(n); process.stderr.write(`[out] ToolUse name=${n}\n`)
      } else process.stderr.write(`[out] ${e._tag}\n`)
    })),
    Stream.takeUntil((e: AgentOutputEvent) => e._tag === "TurnComplete" || e._tag === "Terminated"),
    Stream.runDrain, Effect.timeout("120 seconds"), Effect.fork,
  )

  const prompt: AgentInputEvent = {
    _tag: "Prompt",
    prompt: Prompt.userMessage({ content: [Prompt.textPart({
      text: "You have an MCP tool named `schedule_me`. Call it exactly once, now, with arguments when=9999999999999 and prompt=\"check the build\". You MUST actually invoke the schedule_me tool (do not just describe it). After the tool returns, reply with the single word DONE.",
    })] }),
    correlationId: "mcp-reach-1",
  }
  yield* session.send(prompt)
  yield* consumer.await.pipe(Effect.ignore)
  return toolUses
})

const sandboxLayer = LocalProcessSandboxProvider.layer().pipe(Layer.provide(NodeContext.layer))
Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(sandboxLayer)) as Effect.Effect<ReadonlyArray<string>, unknown, never>).then(
  (toolUses) => {
    const listed = mcpMethods.includes("tools/list")
    const called = scheduleMeCalls.length > 0
    console.log(JSON.stringify({
      adapter: name,
      mcpToolsListSeen: listed,
      scheduleMeCalledOnServer: called,
      scheduleMeArgs: scheduleMeCalls,
      codecObservedToolUses: toolUses,
      mcpMethodsSeen: Array.from(new Set(mcpMethods)),
      VERDICT: called ? "REACHED (tool callable)" : listed ? "DISCOVERED-NOT-CALLED" : "NOT-DISCOVERED",
    }, null, 2))
    httpServer.close(); process.exit(0)
  },
  (err) => { console.error("FAIL", err?.message ?? err); httpServer.close(); process.exit(1) },
)
