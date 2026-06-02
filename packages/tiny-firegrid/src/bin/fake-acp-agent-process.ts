#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Zed Industries, Inc. and contributors
//
// Vendored from the official Agent Client Protocol TypeScript SDK example:
// https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/examples/agent.ts
// Adaptation: import path changed from "../acp.js" to the installed
// @agentclientprotocol/sdk package so this bin can run inside this workspace.

import * as acp from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"

interface AgentSession {
  pendingPrompt: AbortController | null
}

class ExampleAgent implements acp.Agent {
  private readonly connection: acp.AgentSideConnection
  private readonly sessions: Map<string, AgentSession>

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection
    this.sessions = new Map()
  }

  async initialize(
    _params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }
  }

  async newSession(
    _params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")

    this.sessions.set(sessionId, {
      pendingPrompt: null,
    })

    return {
      sessionId,
    }
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

    return {
      stopReason: "end_turn",
    }
  }

  private async simulateTurn(
    sessionId: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "I'll help you with that. Let me start by reading some files to understand the current situation.",
        },
      },
    })

    await this.simulateModelInteraction(abortSignal)

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Reading project files",
        kind: "read",
        status: "pending",
        locations: [{ path: "/project/README.md" }],
        rawInput: { path: "/project/README.md" },
      },
    })

    await this.simulateModelInteraction(abortSignal)

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "# My Project\n\nThis is a sample project...",
            },
          },
        ],
        rawOutput: { content: "# My Project\n\nThis is a sample project..." },
      },
    })

    await this.simulateModelInteraction(abortSignal)

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: " Now I understand the project structure. I need to make some changes to improve it.",
        },
      },
    })

    await this.simulateModelInteraction(abortSignal)

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/project/config.json" }],
        rawInput: {
          path: "/project/config.json",
          content: "{\"database\": {\"host\": \"new-host\"}}",
        },
      },
    })

    const permissionResponse = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: "call_2",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/home/user/project/config.json" }],
        rawInput: {
          path: "/home/user/project/config.json",
          content: "{\"database\": {\"host\": \"new-host\"}}",
        },
      },
      options: [
        {
          kind: "allow_once",
          name: "Allow this change",
          optionId: "allow",
        },
        {
          kind: "reject_once",
          name: "Skip this change",
          optionId: "reject",
        },
      ],
    })

    if (permissionResponse.outcome.outcome === "cancelled") {
      return
    }

    switch (permissionResponse.outcome.optionId) {
      case "allow": {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_2",
            status: "completed",
            rawOutput: { success: true, message: "Configuration updated" },
          },
        })

        await this.simulateModelInteraction(abortSignal)

        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: " Perfect! I've successfully updated the configuration. The changes have been applied.",
            },
          },
        })
        break
      }
      case "reject": {
        await this.simulateModelInteraction(abortSignal)

        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: " I understand you prefer not to make that change. I'll skip the configuration update.",
            },
          },
        })
        break
      }
      default:
        throw new Error(
          `Unexpected permission outcome ${JSON.stringify(permissionResponse.outcome)}`,
        )
    }
  }

  private simulateModelInteraction(abortSignal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) =>
      // eslint-disable-next-line local/no-production-js-timers
      setTimeout(() => {
        if (abortSignal.aborted) {
          reject(new Error("prompt cancelled"))
        } else {
          resolve()
        }
      }, 1000),
    )
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort()
  }
}

const input = Writable.toWeb(process.stdout)
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>

const stream = acp.ndJsonStream(input, output)
new acp.AgentSideConnection((conn) => new ExampleAgent(conn), stream)
