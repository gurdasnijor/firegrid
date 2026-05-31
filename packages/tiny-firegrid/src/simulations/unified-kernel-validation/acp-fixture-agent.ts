/**
 * In-process ACP fixture agents + byte-pipe harness.
 *
 * Lifted from `packages/runtime/test/sources/codecs/acp/index.test.ts`
 * (the canonical FixtureAgent pattern that proves `AcpSessionLive`
 * works against a real `acp.Agent`). Used by the production-flow-acp
 * scenario to drive `ProductionCodecAdapterLive` end-to-end without
 * spawning a `claude-agent-acp` binary.
 *
 * Why this is structurally honest: the fixture agent SPEAKS REAL ACP
 * over `acp.ndJsonStream` against the real `acp.AgentSideConnection`.
 * The codec under test (`AcpSessionLive`) sees byte-level JSON-RPC
 * framing identical to what a packaged binary would emit. The only
 * fake piece is the byte transport — a `TransformStream<Uint8Array>`
 * pair instead of a child process pipe.
 *
 * Variants:
 *   - `FixtureAgent` — happy-path turn (text chunk + tool call + complete)
 *   - `PermissionFixtureAgent` — exercises `requestPermission`
 *   - `CancelFixtureAgent` — exercises the cancel handshake
 *   - `McpFiregridToolCallAgent` — exercises an MCP-bridged tool_call
 *     (uses the `mcp__<server>__<tool>` identifier convention)
 */

import * as acp from "@agentclientprotocol/sdk"
import type { AgentByteStream } from "@firegrid/runtime/sources/sandbox"
import { Deferred, Effect } from "effect"

// ── Harness: in-memory byte transport ──────────────────────────────────────

export interface AcpFixtureHarness {
  /** Hand this to the codec — same shape `LocalProcessSandboxProvider.openBytePipe` returns. */
  readonly bytes: AgentByteStream
  /** Fed by the codec; consumed by the fixture agent. */
  readonly agentInput: ReadableStream<Uint8Array>
  /** Written by the fixture agent; read by the codec. */
  readonly agentOutput: WritableStream<Uint8Array>
  /** Resolve to terminate the fake process. */
  readonly exit: Deferred.Deferred<
    { readonly exitCode?: number; readonly signal?: string },
    unknown
  >
}

export const makeAcpFixtureHarness: Effect.Effect<AcpFixtureHarness> = Effect.gen(function*() {
  const runtimeToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToRuntime = new TransformStream<Uint8Array, Uint8Array>()
  const stderr = new TransformStream<Uint8Array, Uint8Array>()
  const exit = yield* Deferred.make<
    { readonly exitCode?: number; readonly signal?: string },
    unknown
  >()

  return {
    bytes: {
      stdin: runtimeToAgent.writable,
      stdout: agentToRuntime.readable,
      stderr: stderr.readable,
      exit: Deferred.await(exit),
    },
    agentInput: runtimeToAgent.readable,
    agentOutput: agentToRuntime.writable,
    exit,
  } satisfies AcpFixtureHarness
})

// ── Agent bootstrap ────────────────────────────────────────────────────────

export const startFixtureAgent = <A extends acp.Agent>(
  harness: AcpFixtureHarness,
  makeAgent: (connection: acp.AgentSideConnection) => A,
): A => {
  let agent: A | undefined
  const stream = acp.ndJsonStream(harness.agentOutput, harness.agentInput)
  new acp.AgentSideConnection((connection) => {
    agent = makeAgent(connection)
    return agent
  }, stream)
  if (agent === undefined) {
    throw new Error("expected ACP fixture agent to initialize synchronously")
  }
  return agent
}

// ── Fixture variants ───────────────────────────────────────────────────────

export class FixtureAgent implements acp.Agent {
  readonly prompts: Array<acp.PromptRequest> = []
  readonly newSessionRequests: Array<acp.NewSessionRequest> = []
  protected readonly connection: acp.AgentSideConnection
  private readonly cancelWaiters: Array<() => void> = []

  readonly promptStarted: Promise<void>
  protected readonly resolvePromptStarted: () => void

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection
    let resolvePromptStarted = (): void => {}
    this.promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve
    })
    this.resolvePromptStarted = resolvePromptStarted
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.newSessionRequests.push(params)
    return { sessionId: "session-1" }
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    this.resolvePromptStarted()
    const text = params.prompt[0]?.type === "text" ? params.prompt[0].text : "unsupported"
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: `received: ${text}` },
      },
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "lookup",
        kind: "read",
        status: "pending",
        rawInput: { query: text },
      },
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      },
    })
    return {
      stopReason: "end_turn",
      ...(params.messageId === undefined ? {} : { userMessageId: params.messageId }),
    }
  }

  async cancel(): Promise<void> {
    for (const resolve of this.cancelWaiters.splice(0)) resolve()
  }

  waitForCancel(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.cancelWaiters.push(resolve)
    })
  }
}

export class PermissionFixtureAgent extends FixtureAgent {
  override async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    this.resolvePromptStarted()
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-permission",
        title: "edit config",
        kind: "edit",
        status: "pending",
        rawInput: { path: "config.json" },
      },
    })
    const permission = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-permission",
        title: "edit config",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow once" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: permission.outcome.outcome },
      },
    })
    return {
      stopReason: "end_turn",
      ...(params.messageId === undefined ? {} : { userMessageId: params.messageId }),
    }
  }
}

export class CancelFixtureAgent extends FixtureAgent {
  override async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    this.resolvePromptStarted()
    await this.waitForCancel()
    return {
      stopReason: "cancelled",
      ...(params.messageId === undefined ? {} : { userMessageId: params.messageId }),
    }
  }
}

export class McpFiregridToolCallAgent extends FixtureAgent {
  override async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    this.resolvePromptStarted()
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-mcp-1",
        // tf-2p4: real ACP clients emit the `mcp__<server>__<tool>`
        // identifier when the call routes through an MCP bridge.
        title: "mcp__firegrid__lookup",
        kind: "read",
        status: "pending",
        rawInput: { what: "ack" },
      },
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-mcp-1",
        status: "completed",
      },
    })
    return {
      stopReason: "end_turn",
      ...(params.messageId === undefined ? {} : { userMessageId: params.messageId }),
    }
  }
}
