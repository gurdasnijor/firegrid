// tf-u6l V2: same direct claude-agent-acp@0.36.1 repro as V1, but WITH a
// minimal NON-Firegrid stub MCP HTTP server advertised EXACTLY like A1:
// ACP `mcpServers` (http) PLUS `_meta.claudeCode.options.mcpServers`
// ["stub-alwaysload"] = { type:"http", url, alwaysLoad:true } +
// disableBuiltInTools. Isolates: does the §6 turn-abort reproduce against
// a known-good stub MCP (=> upstream claude-agent-acp/alwaysLoad path) or
// only against the Firegrid MCP (=> Firegrid-side response shape)?
//
// Usage: ANTHROPIC_API_KEY=$(cat ~/.firegrid-anthropic-key) node repro-v2.mjs
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

// pnpm: @modelcontextprotocol/sdk + zod are workspace deps of
// packages/runtime; this repro lives under docs/, so anchor resolution at
// packages/runtime/package.json (which has the pnpm symlinks).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const req = createRequire(pathToFileURL(path.join(ROOT, "packages/runtime/package.json")))
const { McpServer } = await import(
  pathToFileURL(req.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href
)
const { StreamableHTTPServerTransport } = await import(
  pathToFileURL(req.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js")).href
)
// zod is a dep of @modelcontextprotocol/sdk, not of packages/runtime —
// resolve it via the SDK's own package require.
const sdkPkg = req.resolve("@modelcontextprotocol/sdk/package.json")
const sdkReq = createRequire(pathToFileURL(sdkPkg))
const { z } = await import(pathToFileURL(sdkReq.resolve("zod")).href)

const t0 = Date.now()
const dt = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`
const log = (...a) => console.log(`[${dt()}]`, ...a)

// --- minimal stub MCP HTTP server (stateless) ---
let toolCalls = 0
const mcp = new McpServer({ name: "stub-mcp", version: "0.0.0" })
mcp.registerTool(
  "stub_echo",
  { description: "Echo back the text argument.", inputSchema: { text: z.string() } },
  async ({ text }) => {
    toolCalls += 1
    log(`STUB MCP tools/call stub_echo #${toolCalls} text=${JSON.stringify(text)}`)
    return { content: [{ type: "text", text: `echoed:${text}` }] }
  },
)
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
await mcp.connect(transport)
const http = createServer((req, res) => {
  let body = ""
  req.on("data", c => (body += c))
  req.on("end", () => {
    let parsed
    try { parsed = body ? JSON.parse(body) : undefined } catch { parsed = undefined }
    transport.handleRequest(req, res, parsed).catch(e => {
      log("stub MCP handleRequest error", e?.message)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
})
await new Promise(r => http.listen(0, "127.0.0.1", r))
const mcpUrl = `http://127.0.0.1:${http.address().port}/mcp`
log(`stub MCP listening ${mcpUrl}`)

// --- drive claude-agent-acp ---
const child = spawn("npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.36.1"], {
  stdio: ["pipe", "pipe", "pipe"], env: { ...process.env },
})
let stderrBuf = ""
child.stderr.on("data", d => { stderrBuf += String(d); process.stderr.write(`[acp-stderr ${dt()}] ${d}`) })
child.on("exit", (c, s) => log(`CHILD EXIT code=${c} sig=${s}`))

let outBuf = ""
const pending = new Map()
let nextId = 1
const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject, method, sentAt: Date.now() })
  log(`-> ${method} (id=${id})`)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
})
child.stdout.on("data", d => {
  outBuf += String(d)
  let i
  while ((i = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, i).trim(); outBuf = outBuf.slice(i + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "session/update") {
      const u = m.params?.update
      log(`<- update ${u?.sessionUpdate}`,
        u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update"
          ? JSON.stringify({ title: u.title, status: u.status, rawInput: u.rawInput }).slice(0, 160)
          : (u?.sessionUpdate === "agent_message_chunk" ? JSON.stringify(u.content).slice(0, 70) : ""))
      continue
    }
    if (m.method) { log(`<- req ${m.method}`); continue }
    const p = pending.get(m.id); if (!p) continue
    pending.delete(m.id)
    const took = `${((Date.now() - p.sentAt) / 1000).toFixed(2)}s`
    if (m.error) { log(`<- ${p.method} ERROR ${took}`, JSON.stringify(m.error)); p.reject(Object.assign(new Error(m.error.message || "rpc"), { rpc: m.error, took })) }
    else { log(`<- ${p.method} OK ${took}`); p.resolve(m.result) }
  }
})

const finish = (result) => {
  log("=== RESULT ===")
  console.log(JSON.stringify({ ...result, stubToolCalls: toolCalls, stderrTail: stderrBuf.slice(-2000) }, null, 2))
  setTimeout(() => process.exit(0), 500)
}
const hard = setTimeout(() => { log("HARD TIMEOUT — kill"); child.kill("SIGKILL"); finish({ verdict: "HARD_TIMEOUT" }) }, 180_000)

try {
  await send("initialize", { protocolVersion: 1, clientCapabilities: {} })
  // Variants via env to bisect WHY MCP tools are unavailable:
  //   REPRO_DISABLE_BUILTINS=0  -> keep claude_code preset (no disableBuiltInTools)
  //   REPRO_ALIAS=0             -> drop the _meta alwaysLoad alias
  const disableBuiltins = process.env.REPRO_DISABLE_BUILTINS !== "0"
  const useAlias = process.env.REPRO_ALIAS !== "0"
  const meta = {}
  if (disableBuiltins) meta.disableBuiltInTools = true
  if (useAlias) {
    meta.claudeCode = { options: { mcpServers: { "stub-mcp-alwaysload": { type: "http", url: mcpUrl, alwaysLoad: true } } } }
  }
  log(`variant: disableBuiltins=${disableBuiltins} alias=${useAlias}`)
  const sess = await send("session/new", {
    cwd: "/tmp",
    // ACP McpServerHttp.headers is REQUIRED (Array<HttpHeader>) — mirror
    // the Firegrid codec's lowerMcpServerDeclaration (always an array).
    mcpServers: [{ type: "http", name: "stub-mcp", url: mcpUrl, headers: [] }],
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  })
  log("session", sess?.sessionId)
  const ps = Date.now()
  try {
    const pr = await send("session/prompt", {
      sessionId: sess.sessionId,
      prompt: [{ type: "text", text: "Call the stub_echo tool with text=\"hello-from-repro\". Then reply with the tool result and nothing else. You MUST call the tool." }],
    })
    clearTimeout(hard)
    finish({ verdict: "PROMPT_RESOLVED", promptSeconds: ((Date.now() - ps) / 1000).toFixed(2), stopReason: pr?.stopReason })
  } catch (e) {
    clearTimeout(hard)
    finish({ verdict: "PROMPT_ABORTED", promptSeconds: ((Date.now() - ps) / 1000).toFixed(2), errorMessage: e.message, rpcError: e.rpc ?? null })
  }
} catch (e) {
  clearTimeout(hard)
  finish({ verdict: "SETUP_FAILED", errorMessage: e.message, rpcError: e.rpc ?? null })
}
