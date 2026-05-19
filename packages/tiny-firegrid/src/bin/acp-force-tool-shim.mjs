// Thin ACP-layer forced-tool-call shim.
//
// Sits transparently between the Firegrid ACP codec and the real ACP agent
// process (stdio ndjson JSON-RPC). It does NOT touch Firegrid substrate and
// does NOT fabricate tool calls. Its only lever is an honest forced-retry
// contract: if the agent ends a prompt turn WITHOUT having emitted any
// `session/update { sessionUpdate: "tool_call" }`, the shim sends an
// additional escalating `session/prompt` to the agent (its own reserved id;
// that injected response is swallowed so the codec's protocol state is
// untouched) demanding the agent issue exactly one Firegrid tool call and
// nothing else. The agent must still produce the tool_call itself; the shim
// only refuses to accept a prose-only completion. Bounded retries.
//
// Usage: node acp-force-tool-shim.mjs -- <agent-cmd> [agent-args...]
//
// Outcome is evidence either way: if a force makes the constrained planner
// emit a real Firegrid tools/call the #401 harness observes, §6 advances;
// if even this cannot, the cross-runtime terminal finding is hardened
// (shim-resistant).

import { spawn } from "node:child_process"

const sepIndex = globalThis.process.argv.indexOf("--")
const agentArgv = sepIndex >= 0 ? globalThis.process.argv.slice(sepIndex + 1) : []
if (agentArgv.length === 0) {
  globalThis.process.stderr.write("[acp-shim] no agent argv after --\n")
  globalThis.process.exit(2)
}

const MAX_FORCES = 4
const INJECTED_ID_BASE = 990000
const FORCE_TEXT = [
  "STOP. You returned prose/finished WITHOUT calling a tool.",
  "Prose makes ZERO progress. The ONLY accepted response is a Firegrid",
  "tool call. Issue EXACTLY ONE Firegrid tool call NOW and nothing else:",
  "call `wait_for` with source { _tag: \"CallerFact\", stream:",
  "\"darkFactory.facts\" } for eventType \"human.plan.approved\" (this is",
  "the §6 plan-approval gate; the plan is already implied by the trigger).",
  "Do not explain. Do not plan in text. Emit the tool call as your entire",
  "response right now.",
].join(" ")

const child = spawn(agentArgv[0], agentArgv.slice(1), {
  env: globalThis.process.env,
  stdio: ["pipe", "pipe", "pipe"],
})

child.on("error", err => {
  globalThis.process.stderr.write(`[acp-shim] spawn error: ${String(err)}\n`)
  globalThis.process.exit(2)
})
child.on("exit", code => globalThis.process.exit(code ?? 0))
child.stderr.pipe(globalThis.process.stderr)

// codec stdin -> agent stdin (transparent); also learn sessionId + the
// codec's own session/prompt request id.
let codecBuf = ""
let sessionId
let codecPromptId
globalThis.process.stdin.on("data", chunk => {
  codecBuf += chunk.toString("utf8")
  let nl
  while ((nl = codecBuf.indexOf("\n")) >= 0) {
    const line = codecBuf.slice(0, nl)
    codecBuf = codecBuf.slice(nl + 1)
    if (line.trim().length > 0) {
      try {
        const msg = JSON.parse(line)
        if (msg.method === "session/prompt" && msg.id !== undefined) {
          codecPromptId = msg.id
          turnHadToolCall = false
          if (msg.params && typeof msg.params.sessionId === "string") {
            sessionId = msg.params.sessionId
          }
        }
        if (msg.method === "session/new" && msg.id !== undefined) {
          newSessionReqId = msg.id
        }
      } catch {
        // not JSON-RPC we care about; relay verbatim regardless
      }
    }
    child.stdin.write(`${line}\n`)
  }
})
globalThis.process.stdin.on("end", () => child.stdin.end())

let newSessionReqId
let turnHadToolCall = false
let forcesUsed = 0
const injectedIds = new Set()

const sendForce = () => {
  if (sessionId === undefined) return
  const id = INJECTED_ID_BASE + forcesUsed
  injectedIds.add(id)
  forcesUsed += 1
  turnHadToolCall = false
  const req = {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: FORCE_TEXT }],
    },
  }
  globalThis.process.stderr.write(`[acp-shim] force #${forcesUsed}: re-prompting for a tool call\n`)
  child.stdin.write(`${JSON.stringify(req)}\n`)
}

// agent stdout -> codec stdout (transparent) EXCEPT swallow responses to our
// injected ids. Track tool_call presence + turn-end to drive forced retry.
let agentBuf = ""
child.stdout.on("data", chunk => {
  agentBuf += chunk.toString("utf8")
  let nl
  while ((nl = agentBuf.indexOf("\n")) >= 0) {
    const line = agentBuf.slice(0, nl)
    agentBuf = agentBuf.slice(nl + 1)
    let swallow = false
    if (line.trim().length > 0) {
      try {
        const msg = JSON.parse(line)
        if (
          msg.id === newSessionReqId &&
          msg.result &&
          typeof msg.result.sessionId === "string"
        ) {
          sessionId = msg.result.sessionId
        }
        if (
          msg.method === "session/update" &&
          msg.params &&
          msg.params.update &&
          msg.params.update.sessionUpdate === "tool_call"
        ) {
          turnHadToolCall = true
        }
        const isInjectedResponse =
          msg.id !== undefined &&
          injectedIds.has(msg.id) &&
          (msg.result !== undefined || msg.error !== undefined)
        const isCodecPromptResponse =
          msg.id !== undefined &&
          msg.id === codecPromptId &&
          (msg.result !== undefined || msg.error !== undefined)
        if (isInjectedResponse) {
          swallow = true
          if (!turnHadToolCall && forcesUsed < MAX_FORCES) sendForce()
        } else if (isCodecPromptResponse) {
          // Let the codec resolve its turn, then enforce the contract.
          if (!turnHadToolCall && forcesUsed < MAX_FORCES) {
            // forward first so codec state is consistent, then force.
            globalThis.process.stdout.write(`${line}\n`)
            sendForce()
            continue
          }
        }
      } catch {
        // non-JSON line: relay verbatim
      }
    }
    if (!swallow) globalThis.process.stdout.write(`${line}\n`)
  }
})
