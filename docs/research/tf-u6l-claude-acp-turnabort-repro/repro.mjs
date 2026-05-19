// tf-u6l: DIRECT, no-Firegrid repro of the post-A1 claude-agent-acp
// model-turn abort. Drives `@agentclientprotocol/claude-agent-acp@0.36.1`
// over raw ACP JSON-RPC stdio with the A1-equivalent `_meta`
// (disableBuiltInTools), a long §6-style planning prompt, and captures
// EVERYTHING the Firegrid codec drops: the raw session/prompt
// result-or-error, every session/update, full stderr, exit code, and
// wall-clock timing of the abort.
//
// Usage: ANTHROPIC_API_KEY=$(cat ~/.firegrid-anthropic-key) node repro.mjs
//
// Node globals are imported from `node:*` (repo convention; the flat
// ESLint config does not honor `/* eslint-env node */`).
import { spawn } from "node:child_process"
import { log as nodeLog } from "node:console"
import process from "node:process"
import { setTimeout, clearTimeout } from "node:timers"

const log = (...a) => nodeLog(`[${new Date().toISOString()}]`, ...a)
const t0 = Date.now()
const dt = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`

const child = spawn("npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.36.1"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
})

let stderrBuf = ""
child.stderr.on("data", d => {
  stderrBuf += String(d)
  process.stderr.write(`[acp-stderr ${dt()}] ${d}`)
})
child.on("exit", (code, sig) =>
  log(`CHILD EXIT code=${code} sig=${sig} at ${dt()}`))

let outBuf = ""
const pending = new Map()
let nextId = 1
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, method, sentAt: Date.now() })
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    log(`-> ${method} (id=${id})`)
    child.stdin.write(line)
  })

child.stdout.on("data", d => {
  outBuf += String(d)
  let i
  while ((i = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, i).trim()
    outBuf = outBuf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { log("non-JSON stdout:", line); continue }
    if (m.method === "session/update") {
      const u = m.params?.update
      log(`<- session/update ${u?.sessionUpdate}`,
        u?.sessionUpdate === "agent_message_chunk"
          ? JSON.stringify(u.content).slice(0, 90)
          : "")
      continue
    }
    if (m.method) { log(`<- request ${m.method} (id=${m.id})`); continue }
    const p = pending.get(m.id)
    if (!p) { log("<- unmatched response", line.slice(0, 200)); continue }
    pending.delete(m.id)
    const took = `${((Date.now() - p.sentAt) / 1000).toFixed(2)}s`
    if (m.error) {
      log(`<- ${p.method} ERROR after ${took}:`, JSON.stringify(m.error))
      p.reject(Object.assign(new Error(m.error.message || "rpc error"), { rpc: m.error, took }))
    } else {
      log(`<- ${p.method} OK after ${took}`)
      p.resolve(m.result)
    }
  }
})

const planningPrompt = [
  "You are a planner. Drive a multi-stage software-delivery loop.",
  "Stages: trigger -> clarify -> plan -> plan-approval -> implementer-delegation",
  "-> pr-opened -> review -> merge-signoff -> durable-ci-watch -> merge -> clean-unwind.",
  "Produce a concise sequenced plan referencing each stage, then BEGIN EXECUTING:",
  "for each stage, state the action you would take and proceed. Do not stop after",
  "planning — continue stage by stage until you reach clean-unwind. Be thorough.",
].join("\n")

const main = async () => {
  const hardTimeout = setTimeout(() => {
    log(`HARD TIMEOUT at ${dt()} — killing child`)
    child.kill("SIGKILL")
    finish(2)
  }, 180_000)

  let result = {}
  const finish = (extra) => {
    clearTimeout(hardTimeout)
    log("=== RESULT ===")
    nodeLog(JSON.stringify({ ...result, ...extra, stderrTail: stderrBuf.slice(-2000) }, null, 2))
    setTimeout(() => process.exit(0), 500)
  }

  try {
    await send("initialize", { protocolVersion: 1, clientCapabilities: {} })
    const sess = await send("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    })
    log("session id:", sess?.sessionId)
    const promptStart = Date.now()
    try {
      const pr = await send("session/prompt", {
        sessionId: sess.sessionId,
        prompt: [{ type: "text", text: planningPrompt }],
      })
      result = {
        verdict: "PROMPT_RESOLVED",
        promptSeconds: ((Date.now() - promptStart) / 1000).toFixed(2),
        stopReason: pr?.stopReason,
      }
    } catch (e) {
      result = {
        verdict: "PROMPT_ABORTED",
        promptSeconds: ((Date.now() - promptStart) / 1000).toFixed(2),
        errorMessage: e.message,
        rpcError: e.rpc ?? null,
      }
    }
  } catch (e) {
    result = { verdict: "SETUP_FAILED", errorMessage: e.message, rpcError: e.rpc ?? null }
  }
  finish({})
}
main()
