#!/usr/bin/env node
//
// ACP example agent for Firegrid tracer 023.
//
// Adapted with minimal changes from the upstream
// @agentclientprotocol/sdk example agent
// (https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/examples/agent.ts).
// We import the real SDK and implement the real Agent interface so the
// tracer is exercising actual ACP semantics (initialize, session/new,
// session/prompt, session/update, requestPermission) and not a homegrown
// JSON-RPC facsimile.
//
// Modifications relative to upstream:
//   * Sleep budget in simulateModelInteraction is configurable via the
//     TRACER_AGENT_TURN_DELAY_MS env var (default 1 ms) so tests run fast.
//   * The text emitted in the first agent_message_chunk includes the
//     TRACER_AGENT_MARKER env var so the scenario can correlate output.
//
// This file is .mjs because it is launched as a subprocess by the tracer
// adapter; ts-node/Vitest do not need to compile it.

import * as acp from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"

const marker = process.env["TRACER_AGENT_MARKER"] ?? "tracer-023"
const turnDelayMs = Number.parseInt(process.env["TRACER_AGENT_TURN_DELAY_MS"] ?? "1", 10)

class ExampleAgent {
  connection
  sessions

  constructor(connection) {
    this.connection = connection
    this.sessions = new Map()
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }
  }

  async newSession() {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    this.sessions.set(sessionId, { pendingPrompt: null })
    return { sessionId }
  }

  async authenticate() {
    return {}
  }

  async setSessionMode() {
    return {}
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`)
    }
    session.pendingPrompt?.abort()
    session.pendingPrompt = new AbortController()
    try {
      await this.simulateTurn(params.sessionId, session.pendingPrompt.signal)
    } catch (err) {
      if (session.pendingPrompt.signal.aborted) {
        return { stopReason: "cancelled" }
      }
      throw err
    }
    session.pendingPrompt = null
    return { stopReason: "end_turn" }
  }

  async simulateTurn(sessionId, abortSignal) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `${marker}: starting turn`,
        },
      },
    })

    await this.tick(abortSignal)

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_read",
        title: "Reading project files",
        kind: "read",
        status: "pending",
        locations: [{ path: "/project/README.md" }],
        rawInput: { path: "/project/README.md" },
      },
    })

    await this.tick(abortSignal)

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_read",
        status: "completed",
        rawOutput: { content: `${marker}: example context` },
      },
    })

    await this.tick(abortSignal)

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_edit",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/project/config.json" }],
        rawInput: { path: "/project/config.json", content: "{}" },
      },
    })

    const permission = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: "call_edit",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/project/config.json" }],
        rawInput: { path: "/project/config.json", content: "{}" },
      },
      options: [
        { kind: "allow_once", name: "Allow this change", optionId: "allow" },
        { kind: "reject_once", name: "Skip this change", optionId: "reject" },
      ],
    })

    if (permission.outcome.outcome === "cancelled") {
      return
    }

    const decision = permission.outcome.optionId === "allow" ? "allowed" : "rejected"
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_edit",
        status: decision === "allowed" ? "completed" : "failed",
        rawOutput: decision === "allowed"
          ? { success: true, message: `${marker}: edit applied` }
          : { success: false, message: `${marker}: edit skipped` },
      },
    })

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `${marker}: ended turn (${decision})`,
        },
      },
    })
  }

  tick(abortSignal) {
    if (turnDelayMs <= 0) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        if (abortSignal.aborted) reject(new Error("aborted"))
        else resolve()
      }, turnDelayMs),
    )
  }

  async cancel(params) {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort()
  }
}

const outgoing = Writable.toWeb(process.stdout)
const incoming = Readable.toWeb(process.stdin)
const stream = acp.ndJsonStream(outgoing, incoming)
new acp.AgentSideConnection((conn) => new ExampleAgent(conn), stream)
