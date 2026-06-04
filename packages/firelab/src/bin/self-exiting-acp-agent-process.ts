#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
//
// tf-r06u.36 — a REAL one-shot ACP agent (same `@agentclientprotocol/sdk`
// AgentSideConnection as the vendored example fixture), used to drive the
// NATURAL process-exit path: it answers a single prompt turn with `end_turn`
// and then exits its own process. The host codec then observes the byte-pipe
// EOF and emits `Terminated`, exercising the observer's terminal → deregister
// wiring (the process-leak fix). This is a genuine spawn-target process exiting
// on its own — NOT a fake codec/adapter/sandbox.

import * as acp from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"

class SelfExitingAgent implements acp.Agent {
  private readonly connection: acp.AgentSideConnection

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection
  }

  async initialize(
    _params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }
  }

  async newSession(
    _params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    return { sessionId }
  }

  async authenticate(
    _params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse | void> {
    return {}
  }

  async setSessionMode(
    _params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    return {}
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done — exiting." },
      },
    })
    // Exit the process shortly after the `end_turn` response flushes, so the
    // host codec sees the byte-pipe EOF and emits `Terminated` (natural exit).
    // eslint-disable-next-line local/no-production-js-timers
    setTimeout(() => process.exit(0), 150)
    return { stopReason: "end_turn" }
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {}
}

const input = Writable.toWeb(process.stdout)
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>

const stream = acp.ndJsonStream(input, output)
new acp.AgentSideConnection((conn) => new SelfExitingAgent(conn), stream)
