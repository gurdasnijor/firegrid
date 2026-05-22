#!/usr/bin/env node
// Headless ACP-client driver for Firegrid.
//
// Replays a list of scripted prompts against `firegrid acp` over stdio exactly
// as Zed does — it is an ACP *client* (acp.ClientSideConnection) talking to the
// `firegrid acp` *agent* subprocess. This exercises the real ACP stdio edge
// (the path where the permission deadlock / schedule_me hang live), which the
// tiny-firegrid client-SDK sims bypass.
//
// All artifacts for a run land under one easy-to-find folder:
//
//   .firegrid/runs/<YYYY-MM-DD_HH-MM-SS>-<label>/
//     trace.jsonl        OTel spans (the --otel-file the agent writes)
//     transcript.md      human-readable: each prompt + agent text + tool calls
//     transcript.json    structured per-turn updates
//     summary.json       run metadata + per-turn stopReason/duration/errors
//     agent-stderr.log    firegrid acp stderr (diagnostics / resolved trace path)
//     health.txt         scripts/acp-trace-health.py output (best-effort)
//   .firegrid/runs/latest -> the newest run dir (symlink)
//
// Usage:
//   ANTHROPIC_API_KEY=... node scripts/acp-drive.mjs [promptsFile] [options]
//
// Options:
//   --label NAME           run-folder suffix (default: the prompts file basename)
//   --agent NAME           --agent for firegrid acp (default: claude-acp)
//   --secret-env NAME      env var to authorize into the agent (default: ANTHROPIC_API_KEY)
//   --turn-timeout-ms N    per-turn backstop timeout (default: 90000; the edge's
//                          own 30s turn timeout usually fires first)
//   --dry-run              initialize + newSession only, then exit (no prompts,
//                          no LLM tokens) — verifies the ACP plumbing cheaply
//   -- <agentcmd...>       override the backing agent command (default:
//                          npx -y @agentclientprotocol/claude-agent-acp@0.36.1)
//
// Prompts file: one prompt per line; blank lines and lines starting with # are
// ignored. Each line is a separate agent turn. Default: scripts/acp-prompts.txt

import { spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..")

// The ACP SDK is a dependency of @firegrid/host-sdk, not of the repo root, so
// resolve it from there and dynamic-import the ESM entry. Keeps this a
// zero-dependency root script.
const requireFromHostSdk = createRequire(path.join(repoRoot, "packages/host-sdk/package.json"))
const acp = await import(pathToFileURL(requireFromHostSdk.resolve("@agentclientprotocol/sdk")).href)

// --------------------------------------------------------------------------
// args
// --------------------------------------------------------------------------
const rawArgs = process.argv.slice(2)
const dashDash = rawArgs.indexOf("--")
const driverArgs = dashDash === -1 ? rawArgs : rawArgs.slice(0, dashDash)
const agentCmdOverride = dashDash === -1 ? undefined : rawArgs.slice(dashDash + 1)

const opts = { agent: "claude-acp", secretEnv: "ANTHROPIC_API_KEY", turnTimeoutMs: 90_000, dryRun: false }
let promptsFile
for (let i = 0; i < driverArgs.length; i++) {
  const a = driverArgs[i]
  if (a === "--dry-run") opts.dryRun = true
  else if (a === "--label") opts.label = driverArgs[++i]
  else if (a === "--agent") opts.agent = driverArgs[++i]
  else if (a === "--secret-env") opts.secretEnv = driverArgs[++i]
  else if (a === "--turn-timeout-ms") opts.turnTimeoutMs = Number(driverArgs[++i])
  else if (a === "--help" || a === "-h") { printHelpAndExit() }
  else if (!a.startsWith("-")) promptsFile = a
  else { console.error(`unknown option: ${a}`); process.exit(2) }
}
promptsFile = promptsFile ?? path.join(repoRoot, "scripts/acp-prompts.txt")

function printHelpAndExit() {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n").replace(/^\/\/ ?/gm, ""))
  process.exit(0)
}

// --------------------------------------------------------------------------
// prompts + run dir
// --------------------------------------------------------------------------
const prompts = opts.dryRun
  ? []
  : readFileSync(promptsFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"))

if (!opts.dryRun && prompts.length === 0) {
  console.error(`no prompts found in ${promptsFile}`)
  process.exit(2)
}

const label = (opts.label ?? path.basename(promptsFile).replace(/\.[^.]+$/, "")).replace(/[^a-zA-Z0-9_-]/g, "-")
const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace("T", "_").replace(/:/g, "-")
const runDir = path.join(repoRoot, ".firegrid/runs", `${stamp}-${label}`)
mkdirSync(runDir, { recursive: true })
const tracePath = path.join(runDir, "trace.jsonl")

if (opts.secretEnv && !process.env[opts.secretEnv] && !agentCmdOverride && !opts.dryRun) {
  console.error(`warning: $${opts.secretEnv} is not set — the agent will likely fail to authenticate.`)
}

// --------------------------------------------------------------------------
// spawn `firegrid acp` (which itself launches the backing agent subprocess)
// --------------------------------------------------------------------------
const agentCmd = agentCmdOverride ?? ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.36.1"]
const fgArgs = [
  "--silent", "exec", "tsx", "packages/cli/src/bin/run.ts", "--", "acp",
  "--agent", opts.agent, "--agent-protocol", "acp",
  ...(opts.secretEnv ? ["--secret-env", opts.secretEnv] : []),
  "--otel-file", tracePath, "--cwd", repoRoot,
  "--", ...agentCmd,
]
console.error(`acp-drive: run dir ${path.relative(repoRoot, runDir)}`)
console.error(`acp-drive: spawning firegrid acp (--agent ${opts.agent}); trace -> ${path.relative(repoRoot, tracePath)}`)

const child = spawn("pnpm", fgArgs, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"], env: process.env })
child.stderr.pipe(createWriteStream(path.join(runDir, "agent-stderr.log")))
child.on("exit", (code, signal) => {
  if (code && code !== 0) console.error(`acp-drive: firegrid acp exited code=${code} signal=${signal} (see agent-stderr.log)`)
})

// --------------------------------------------------------------------------
// ACP client
// --------------------------------------------------------------------------
let currentUpdates = []
const client = {
  // Auto-approve permission requests (mirrors what the stdio edge does post-#628).
  async requestPermission(params) {
    const opt = params.options?.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? params.options?.[0]
    currentUpdates.push({ _driver: "permission_request", tool: params.toolCall?.title, decided: opt?.optionId })
    return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } }
  },
  async sessionUpdate(params) {
    currentUpdates.push(params.update)
  },
  // We advertise no fs capability, so these should not be called; stub to be safe.
  async writeTextFile() { return {} },
  async readTextFile() { return { content: "" } },
}

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
const connection = new acp.ClientSideConnection(() => client, stream)

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`driver timeout after ${ms}ms (${label})`)), ms)),
  ])

const turns = []
let sessionId

try {
  await withTimeout(
    connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
    30_000, "initialize",
  )
  const session = await withTimeout(
    connection.newSession({ cwd: repoRoot, mcpServers: [] }),
    30_000, "newSession",
  )
  sessionId = session.sessionId
  console.error(`acp-drive: session ${sessionId}`)

  for (const prompt of prompts) {
    currentUpdates = []
    const t0 = Date.now()
    let stopReason
    let error
    try {
      const res = await withTimeout(
        connection.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] }),
        opts.turnTimeoutMs, "prompt",
      )
      stopReason = res?.stopReason
    } catch (e) {
      error = String(e?.message ?? e)
    }
    const ms = Date.now() - t0
    turns.push({ prompt, ms, stopReason, error, updates: currentUpdates })
    console.error(`acp-drive: [turn ${turns.length}/${prompts.length}] ${stopReason ?? "ERROR:" + error} (${ms}ms) :: ${prompt.slice(0, 70)}`)
  }
} catch (e) {
  console.error(`acp-drive: fatal: ${String(e?.message ?? e)}`)
} finally {
  child.kill("SIGTERM")
}

// --------------------------------------------------------------------------
// artifacts
// --------------------------------------------------------------------------
const summary = {
  label,
  runDir,
  agent: opts.agent,
  promptsFile,
  startedAt: stamp,
  sessionId,
  turnCount: turns.length,
  timeouts: turns.filter((t) => t.error?.includes("timed out") || t.error?.includes("timeout")).length,
  errors: turns.filter((t) => t.error).length,
  turns: turns.map(({ prompt, ms, stopReason, error }) => ({ prompt, ms, stopReason, error })),
}
writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2))
writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify(turns, null, 2))
writeFileSync(path.join(runDir, "transcript.md"), renderTranscript(turns))

// latest symlink
const latest = path.join(repoRoot, ".firegrid/runs/latest")
try { if (existsSync(latest)) rmSync(latest) } catch { /* ignore */ }
try { symlinkSync(runDir, latest) } catch { /* ignore (e.g. perms) */ }

// best-effort health report
await runHealthReport(tracePath, path.join(runDir, "health.txt"))

console.error(`\nacp-drive: done. ${summary.turnCount} turns, ${summary.errors} errors (${summary.timeouts} timeouts).`)
console.error(`acp-drive: artifacts -> ${path.relative(repoRoot, runDir)}/  (also .firegrid/runs/latest)`)
process.exit(0)

// --------------------------------------------------------------------------
function renderTranscript(turns) {
  const lines = [`# ACP drive transcript — ${label}`, "", `agent: ${opts.agent} · session: ${sessionId ?? "(none)"}`, ""]
  if (turns.length === 0) lines.push("(dry-run: initialize + newSession only)")
  turns.forEach((t, i) => {
    lines.push(`## Turn ${i + 1} — ${t.stopReason ?? "ERROR"} (${t.ms}ms)`, "", `**Prompt:** ${t.prompt}`, "")
    const text = t.updates.filter((u) => u?.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text ?? "").join("")
    if (text.trim()) lines.push("**Agent:**", "", text.trim(), "")
    const tools = t.updates.filter((u) => u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update")
      .map((u) => `- \`${u.title ?? u.toolCallId ?? "?"}\`${u.status ? ` (${u.status})` : ""}`)
    if (tools.length) lines.push("**Tool calls:**", ...dedupe(tools), "")
    const perms = t.updates.filter((u) => u?._driver === "permission_request")
      .map((u) => `- ${u.tool ?? "?"} -> auto-approved (${u.decided ?? "?"})`)
    if (perms.length) lines.push("**Permissions:**", ...perms, "")
    if (t.error) lines.push(`**Error:** \`${t.error}\``, "")
  })
  return lines.join("\n") + "\n"
}

function dedupe(arr) { return [...new Set(arr)] }

function runHealthReport(tracePath, outPath) {
  return new Promise((resolve) => {
    const script = path.join(repoRoot, "scripts/acp-trace-health.py")
    if (!existsSync(script) || !existsSync(tracePath)) { resolve(); return }
    const out = createWriteStream(outPath)
    const py = spawn("python3", [script, tracePath], { cwd: repoRoot })
    py.stdout.pipe(out)
    py.stderr.pipe(out)
    py.on("error", () => resolve())
    py.on("close", () => resolve())
  })
}
