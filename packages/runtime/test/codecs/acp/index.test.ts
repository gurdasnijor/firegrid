import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import * as acp from "@agentclientprotocol/sdk"
import { IdGenerator, Prompt, Response } from "@effect/ai"
import { Chunk, Context, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type { AgentOutputEvent } from "../../../src/agent-event-pipeline/events/index.ts"
import type { AgentByteStream } from "../../../src/agent-event-pipeline/sources/byte-stream.ts"
import {
  AcpCapabilities,
  AcpSessionLive,
  type AcpSessionOptions,
} from "../../../src/agent-event-pipeline/codecs/acp/index.ts"
import { AgentSession } from "../../../src/agent-event-pipeline/codecs/contract.ts"

const requireFromTest = createRequire(import.meta.url)

const claudeAgentAcpSource = (): string => {
  const packageJsonPath = requireFromTest.resolve("@agentclientprotocol/claude-agent-acp/package.json")
  return readFileSync(join(dirname(packageJsonPath), "dist/acp-agent.js"), "utf8")
}

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

// tf-2p4: emits an MCP-bridged tool_call the way a real ACP client does
// (the `mcp__<server>__<tool>` identifier convention, source-verified
// against docs/investigations/2026-05-19-s6-dark-factory-live-run.md).
class McpFiregridToolCallAgent extends FixtureAgent {
  override async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    this.resolvePromptStarted()
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "mcp-call-1",
        title: "mcp__firegrid-runtime-context__wait_for",
        kind: "other",
        status: "pending",
        rawInput: { source: { _tag: "CallerFact", stream: "darkFactory.facts" } },
      },
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "mcp-call-1",
        title: "mcp__firegrid-runtime-context__wait_for",
        status: "completed",
        rawInput: { source: { _tag: "CallerFact", stream: "darkFactory.facts" } },
      },
    })
    return {
      stopReason: "end_turn",
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

const openSession = (
  bytes: AgentByteStream,
  options: AcpSessionOptions = {},
  idGenerator: IdGenerator.Service = IdGenerator.defaultIdGenerator,
) =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const context = yield* Layer.buildWithScope(
      AcpSessionLive(bytes, options).pipe(
        Layer.provide(Layer.succeed(IdGenerator.IdGenerator, idGenerator)),
      ),
      scope,
    )
    return Context.get(context, AgentSession)
  })

type LiveAgentSession = Context.Tag.Service<typeof AgentSession>

const deterministicIdGenerator = (): IdGenerator.Service => {
  let next = 0
  return {
    generateId: () =>
      Effect.sync(() => {
        next += 1
        return `test_${next}`
      }),
  }
}

const userMessage = (text: string): Prompt.UserMessage =>
  Prompt.userMessage({ content: [Prompt.textPart({ text })] })

const collectOutputs = (
  session: LiveAgentSession,
  count: number,
) =>
  session.outputs.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
  )

describe("AcpSessionLive", () => {
  it("firegrid-runtime-boundary-reconciliation.CODEC_SESSION.1 firegrid-runtime-boundary-reconciliation.CODEC_SESSION.2 emits Ready with ACP capabilities after SDK initialize/session setup", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new FixtureAgent(connection))
          const session = yield* openSession(harness.bytes)
          const events = yield* collectOutputs(session, 1)
          return { meta: session.meta, events }
        }),
      ),
    )

    expect(events.meta).toEqual({
      kind: "acp",
      capabilities: AcpCapabilities,
    })
    expect(events.events).toEqual([
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
    expect(agent.newSessionRequests[0]?._meta).toEqual({
      claudeCode: {
        options: {
          settingSources: ["project"],
        },
      },
    })
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.8 source-verifies claude-agent-acp lets _meta claudeCode options override settingSources", () => {
    const source = claudeAgentAcpSource()
    const defaultSettingSourcesIndex = source.indexOf(
      'settingSources: ["user", "project", "local"]',
    )
    const userProvidedOptionsSpreadIndex = source.indexOf(
      "...userProvidedOptions",
      defaultSettingSourcesIndex,
    )

    expect(defaultSettingSourcesIndex).toBeGreaterThanOrEqual(0)
    expect(userProvidedOptionsSpreadIndex).toBeGreaterThan(defaultSettingSourcesIndex)
  })

  it("firegrid-runtime-boundary-reconciliation.CODEC_SESSION.5 firegrid-local-mcp-run.LAUNCH_CONFIG.1 firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.9 lowers MCP declarations through ACP-specific session options", async () => {
    const agent = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const agent = startAgent(harness, connection => new FixtureAgent(connection))
          yield* openSession(harness.bytes, {
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
          })
          return agent
        }),
      ),
    )

    // tf-b6n / A1 (#408 tf-p9s): the codec additively attaches an ACP
    // `_meta` payload re-advertising the runtime-context MCP server under a
    // non-colliding alias with `alwaysLoad:true` (+ `disableBuiltInTools`)
    // so claude-agent-acp loads the Firegrid tools directly instead of
    // deferring them behind ToolSearch. The ACP `mcpServers` advertisement
    // is unchanged (non-claude paths unaffected).
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
        _meta: {
          disableBuiltInTools: true,
          claudeCode: {
            options: {
              settingSources: ["project"],
              mcpServers: {
                "firegrid-runtime-context-alwaysload": {
                  type: "http",
                  url: "http://127.0.0.1:54321/mcp/runtime-context/ctx_test",
                  headers: { authorization: "Bearer test" },
                  alwaysLoad: true,
                },
              },
            },
          },
        },
      },
    ])
  })

  it("firegrid-runtime-boundary-reconciliation.CODEC_SESSION.8 firegrid-runtime-agent-event-pipeline.STAGES.3-8 firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.7 firegrid-runtime-agent-event-pipeline.VALIDATION.6 reports observation_only and maps tool_call/tool_call_update as observations", async () => {
    const result = await Effect.runPromise(
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
          const events = yield* Fiber.join(fiber)
          return { toolUseMode: session.toolUseMode, events }
        }),
      ),
    )

    expect(result.toolUseMode).toBe("observation_only")
    expect(result.events).toEqual([
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
          providerExecuted: true,
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

  it("tf-2p4 surfaces the canonical MCP tool name (not the mcp__server__tool ACP title) for tool_call and tool_call_update", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new McpFiregridToolCallAgent(connection))
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 4).pipe(Effect.fork)
          yield* session.send({
            _tag: "Prompt",
            correlationId: "prompt-1",
            prompt: userMessage("go"),
          })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    const toolUses = result.filter(
      (event): event is Extract<AgentOutputEvent, { _tag: "ToolUse" }> =>
        event._tag === "ToolUse",
    )
    // Both the tool_call and the rawInput-bearing tool_call_update emit a
    // ToolUse, and both surface the CANONICAL name, not the ACP title.
    expect(toolUses.length).toBeGreaterThanOrEqual(2)
    for (const toolUse of toolUses) {
      expect(toolUse.part.name).toBe("wait_for")
      expect(toolUse.part.name).not.toBe("mcp__firegrid-runtime-context__wait_for")
    }
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

  it("firegrid-runtime-boundary-reconciliation.CODEC_SESSION.6 firegrid-runtime-agent-event-pipeline.STAGES.3-10 firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-3 maps requestPermission to a live permission continuation", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          startAgent(harness, connection => new PermissionFixtureAgent(connection))
          const session = yield* openSession(
            harness.bytes,
            {},
            deterministicIdGenerator(),
          )
          let permissionRequestId = ""
          const fiber = yield* session.outputs.pipe(
            Stream.take(5),
            Stream.tap(event => {
              if (event._tag !== "PermissionRequest") {
                return Effect.void
              }
              permissionRequestId = event.permissionRequestId
              return session.send({
                _tag: "PermissionResponse",
                permissionRequestId: event.permissionRequestId,
                decision: { _tag: "Allow", optionId: "allow" },
              })
            },
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
          const events = yield* Fiber.join(fiber)
          const staleResponse = yield* session.send({
            _tag: "PermissionResponse",
            permissionRequestId,
            decision: { _tag: "Deny" },
          }).pipe(Effect.either)
          return { events, permissionRequestId, staleResponse }
        }),
      ),
    )

    expect(result.events[1]).toEqual({
      _tag: "ToolUse",
      part: Prompt.toolCallPart({
        id: "tool-permission",
        name: "edit config",
        params: { path: "config.json" },
        providerExecuted: true,
      }),
    })
    expect(result.events[2]).toEqual({
      _tag: "PermissionRequest",
      permissionRequestId: result.permissionRequestId,
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
    expect(result.permissionRequestId).toBe("permission_test_1")
    expect(result.events[3]?._tag).toBe("TextChunk")
    if (result.events[3]?._tag === "TextChunk") {
      expect(result.events[3].part.id).toBe("test_2")
      expect(result.events[3].part.delta).toBe("selected")
    }
    expect(result.events[4]).toEqual({
      _tag: "TurnComplete",
      finishReason: "stop",
      messageId: "prompt-2",
    })
    expect(result.staleResponse._tag).toBe("Right")
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

  it("firegrid-runtime-agent-event-pipeline.STAGES.3-10 resolves live ACP permission continuations as cancelled before session/cancel", async () => {
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
        providerExecuted: true,
      }),
    })
    const permissionEvent = events[2]
    expect(permissionEvent?._tag).toBe("PermissionRequest")
    if (permissionEvent?._tag !== "PermissionRequest") {
      throw new Error("expected PermissionRequest")
    }
    expect(permissionEvent.permissionRequestId).toMatch(/^permission_id_[0-9A-Za-z]{16}$/)
    expect(permissionEvent).toEqual({
      _tag: "PermissionRequest",
      permissionRequestId: permissionEvent.permissionRequestId,
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
