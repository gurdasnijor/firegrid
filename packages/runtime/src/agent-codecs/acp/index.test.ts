import * as acp from "@agentclientprotocol/sdk"
import { Prompt, Response } from "@effect/ai"
import { Chunk, Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type {
  AgentByteStream,
  AgentCodecOpenOptions,
  AgentOutputEvent,
  AgentSession,
} from "../../agent-io/index.ts"
import {
  AcpCapabilities,
  AcpCodec,
} from "./index.ts"

interface Harness {
  readonly bytes: AgentByteStream
  readonly agentInput: ReadableStream<Uint8Array>
  readonly agentOutput: WritableStream<Uint8Array>
  readonly exit: Deferred.Deferred<{ readonly exitCode?: number; readonly signal?: string }, unknown>
}

class FixtureAgent implements acp.Agent {
  readonly prompts: Array<acp.PromptRequest> = []
  readonly newSessionRequests: Array<acp.NewSessionRequest> = []
  protected readonly connection: acp.AgentSideConnection
  private readonly cancelWaiters: Array<() => void> = []

  readonly promptStarted: Promise<void>
  protected readonly resolvePromptStarted: () => void

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection
    let resolvePromptStarted = () => {}
    this.promptStarted = new Promise<void>(resolve => {
      resolvePromptStarted = resolve
    })
    this.resolvePromptStarted = resolvePromptStarted
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
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

    const text = params.prompt[0]?.type === "text"
      ? params.prompt[0].text
      : "unsupported"

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: {
          type: "text",
          text: `received: ${text}`,
        },
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
    for (const resolve of this.cancelWaiters.splice(0)) {
      resolve()
    }
  }

  waitForCancel(): Promise<void> {
    return new Promise(resolve => {
      this.cancelWaiters.push(resolve)
    })
  }
}

class PermissionFixtureAgent extends FixtureAgent {
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
        {
          optionId: "allow",
          kind: "allow_once",
          name: "Allow once",
        },
        {
          optionId: "deny",
          kind: "reject_once",
          name: "Deny",
        },
      ],
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: permission.outcome.outcome,
        },
      },
    })
    return {
      stopReason: "end_turn",
      ...(params.messageId === undefined ? {} : { userMessageId: params.messageId }),
    }
  }
}

class CancelDuringPermissionAgent extends FixtureAgent {
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
        {
          optionId: "allow",
          kind: "allow_once",
          name: "Allow once",
        },
        {
          optionId: "deny",
          kind: "reject_once",
          name: "Deny",
        },
      ],
    })

    return {
      stopReason: permission.outcome.outcome === "cancelled" ? "cancelled" : "end_turn",
      ...(params.messageId === undefined ? {} : { userMessageId: params.messageId }),
    }
  }
}

class CancelFixtureAgent extends FixtureAgent {
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

const makeHarness = Effect.gen(function*() {
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
  } satisfies Harness
})

const startAgent = <A extends acp.Agent>(
  harness: Harness,
  makeAgent: (connection: acp.AgentSideConnection) => A,
): A => {
  let agent: A | undefined
  const stream = acp.ndJsonStream(harness.agentOutput, harness.agentInput)
  new acp.AgentSideConnection(connection => {
    agent = makeAgent(connection)
    return agent
  }, stream)
  if (agent === undefined) {
    throw new Error("expected ACP fixture agent to initialize synchronously")
  }
  return agent
}

const openSession = (bytes: AgentByteStream, options: AgentCodecOpenOptions = {}) =>
  AcpCodec.open(bytes, options)

const userMessage = (text: string): Prompt.UserMessage =>
  Prompt.userMessage({ content: [Prompt.textPart({ text })] })

const collectOutputs = (
  session: AgentSession,
  count: number,
) =>
  session.outputs.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
  )

describe("AcpCodec", () => {
  it("emits Ready with ACP capabilities after SDK initialize/session setup", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new FixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          return yield* collectOutputs(session, 1)
        }),
      ),
    )

    expect(events).toEqual([
      {
        _tag: "Ready",
        capabilities: AcpCapabilities,
      },
    ])
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.2 sends default cwd and empty mcpServers to ACP newSession", async () => {
    const agent = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const agent = startAgent(harness, connection => new FixtureAgent(connection))
          yield* openSession(harness.bytes)
          return agent
        }),
      ),
    )

    expect(agent.newSessionRequests).toHaveLength(1)
    expect(agent.newSessionRequests[0]?.cwd).toBe(globalThis.process.cwd())
    expect(agent.newSessionRequests[0]?.mcpServers).toEqual([])
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.1 lowers Firegrid-neutral MCP declarations to ACP newSession mcpServers", async () => {
    const agent = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const agent = startAgent(harness, connection => new FixtureAgent(connection))
          yield* openSession(harness.bytes, {
            session: {
              cwd: "/tmp/firegrid-acp-codec-cwd",
              mcpServers: [
                {
                  name: "firegrid-runtime-context",
                  server: {
                    type: "url",
                    url: "http://127.0.0.1:54321/mcp/runtime-context/ctx_test",
                    headers: [{ name: "authorization", value: "Bearer test" }],
                  },
                },
              ],
            },
          })
          return agent
        }),
      ),
    )

    expect(agent.newSessionRequests).toEqual([
      {
        cwd: "/tmp/firegrid-acp-codec-cwd",
        mcpServers: [
          {
            type: "http",
            name: "firegrid-runtime-context",
            url: "http://127.0.0.1:54321/mcp/runtime-context/ctx_test",
            headers: [{ name: "authorization", value: "Bearer test" }],
          },
        ],
      },
    ])
  })

  it("maps SDK prompt, text, tool_call, tool_call_update, and completion events", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new FixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 5).pipe(Effect.fork)
          yield* session.send({
            _tag: "Prompt",
            correlationId: "prompt-1",
            prompt: userMessage("hello ACP"),
          })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events).toEqual([
      {
        _tag: "Ready",
        capabilities: AcpCapabilities,
      },
      {
        _tag: "TextChunk",
        part: Response.textDeltaPart({
          id: "message-1",
          delta: "received: hello ACP",
        }),
      },
      {
        _tag: "ToolUse",
        part: Prompt.toolCallPart({
          id: "tool-1",
          name: "lookup",
          params: { query: "hello ACP" },
          providerExecuted: false,
        }),
      },
      {
        _tag: "Status",
        kind: "tool_call_update",
        payload: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        },
      },
      {
        _tag: "TurnComplete",
        finishReason: "stop",
        messageId: "prompt-1",
      },
    ])
  })

  it("sends UserMessage content to ACP without role filtering at runtime", async () => {
    const agent = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const agent = startAgent(harness, connection => new FixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          yield* session.send({
            _tag: "Prompt",
            correlationId: "prompt-role-aware",
            prompt: userMessage("latest user"),
          })
          yield* Effect.promise(() => agent.promptStarted)
          return agent
        }),
      ),
    )

    expect(agent.prompts[0]?.prompt).toEqual([{
      type: "text",
      text: "latest user",
    }])
  })

  it("maps SDK requestPermission to PermissionRequest and resolves PermissionResponse", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new PermissionFixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          const fiber = yield* session.outputs.pipe(
            Stream.take(5),
            Stream.tap(event =>
              event._tag === "PermissionRequest"
                ? session.send({
                  _tag: "PermissionResponse",
                  permissionRequestId: event.permissionRequestId,
                  decision: { _tag: "Allow", optionId: "allow" },
                })
                : Effect.void,
            ),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            Effect.fork,
          )
          yield* session.send({
            _tag: "Prompt",
            correlationId: "prompt-2",
            prompt: userMessage("edit config"),
          })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "ToolUse",
      part: Prompt.toolCallPart({
        id: "tool-permission",
        name: "edit config",
        params: { path: "config.json" },
        providerExecuted: false,
      }),
    })
    expect(events[2]).toEqual({
      _tag: "PermissionRequest",
      permissionRequestId: "permission-1",
      toolUseId: "tool-permission",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "Allow once",
        },
        {
          optionId: "deny",
          kind: "reject_once",
          name: "Deny",
        },
      ],
    })
    expect(events[3]?._tag).toBe("TextChunk")
    if (events[3]?._tag === "TextChunk") {
      expect(events[3].part.id).toMatch(/^id_/)
      expect(events[3].part.id).not.toBe("session-1")
      expect(events[3].part.delta).toBe("selected")
    }
    expect(events[4]).toEqual({
      _tag: "TurnComplete",
      finishReason: "stop",
      messageId: "prompt-2",
    })
  })

  it("sends SDK session/cancel and maps cancelled prompt completion", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const agent = startAgent(harness, connection => new CancelFixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 2).pipe(Effect.fork)
          yield* session.send({
            _tag: "Prompt",
            correlationId: "prompt-3",
            prompt: userMessage("cancel me"),
          })
          yield* Effect.promise(() => agent.promptStarted)
          yield* session.send({ _tag: "Cancel", reason: "test" })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "TurnComplete",
      finishReason: "other",
      messageId: "prompt-3",
    })
  })

  it("resolves pending ACP permission requests as cancelled before session/cancel", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new CancelDuringPermissionAgent(connection))
          const session = yield* openSession(harness.bytes)
          const fiber = yield* session.outputs.pipe(
            Stream.take(4),
            Stream.tap(event =>
              event._tag === "PermissionRequest"
                ? session.send({ _tag: "Cancel", reason: "test" })
                : Effect.void,
            ),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            Effect.fork,
          )
          yield* session.send({
            _tag: "Prompt",
            correlationId: "prompt-4",
            prompt: userMessage("edit config"),
          })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "ToolUse",
      part: Prompt.toolCallPart({
        id: "tool-permission",
        name: "edit config",
        params: { path: "config.json" },
        providerExecuted: false,
      }),
    })
    expect(events[2]).toEqual({
      _tag: "PermissionRequest",
      permissionRequestId: "permission-1",
      toolUseId: "tool-permission",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "Allow once",
        },
        {
          optionId: "deny",
          kind: "reject_once",
          name: "Deny",
        },
      ],
    })
    expect(events[3]).toEqual({
      _tag: "TurnComplete",
      finishReason: "other",
      messageId: "prompt-4",
    })
  })

  it("emits Terminated from the byte stream exit signal", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new FixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 2).pipe(Effect.fork)
          yield* Deferred.succeed(harness.exit, { exitCode: 0 })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "Terminated",
      exitCode: 0,
    } satisfies AgentOutputEvent)
  })

  it("completes the output stream after Terminated", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new FixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          const fiber = yield* session.outputs.pipe(
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            Effect.fork,
          )
          yield* Deferred.succeed(harness.exit, { exitCode: 0 })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events).toEqual([
      {
        _tag: "Ready",
        capabilities: AcpCapabilities,
      },
      {
        _tag: "Terminated",
        exitCode: 0,
      },
    ])
  })

  it("rejects ToolResult input until ACP out-of-band tool results are specified", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new FixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          return yield* session.send({
            _tag: "ToolResult",
            part: Prompt.toolResultPart({
              id: "tool-1",
              name: "lookup",
              result: { ok: true },
              isFailure: false,
              providerExecuted: false,
            }),
          }).pipe(Effect.either)
        }),
      ),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.message).toContain("out-of-band")
    }
  })
})
