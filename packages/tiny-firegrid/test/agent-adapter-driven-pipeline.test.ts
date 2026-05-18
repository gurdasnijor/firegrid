import * as acp from "@agentclientprotocol/sdk"
import { Response } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { FiregridHost } from "@firegrid/host-sdk"
import {
  CurrentHostSession,
  makeLocalRuntimeContextForHostSession,
  normalizeRuntimeIntent,
  RuntimeControlPlaneTable,
  type CurrentHostStopped,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  sessionContextIdForExternalKey,
  type FiregridSessionId,
} from "@firegrid/protocol/session-facade"
import {
  AcpAdapterCapabilities,
  AcpAgentAdapter,
  AgentAdapter,
} from "@firegrid/runtime/agent-adapters"
import type { AgentByteStream } from "@firegrid/runtime/sources/sandbox"
import {
  Chunk,
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Stream,
} from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { createServer } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  agentAdapterDrivenMcpUrl,
  tinyAgentAdapterDrivenPipeline,
} from "../src/configurations/agent-adapter-driven-pipeline.ts"

interface Harness {
  readonly bytes: AgentByteStream
  readonly agentInput: ReadableStream<Uint8Array>
  readonly agentOutput: WritableStream<Uint8Array>
  readonly exit: Deferred.Deferred<
    { readonly exitCode?: number; readonly signal?: string },
    unknown
  >
}

class AgentAdapterFixtureAgent implements acp.Agent {
  readonly newSessionRequests: Array<acp.NewSessionRequest> = []
  readonly prompts: Array<acp.PromptRequest> = []

  constructor(readonly connection: acp.AgentSideConnection) {}

  initialize(): Promise<acp.InitializeResponse> {
    return Promise.resolve({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    })
  }

  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.newSessionRequests.push(params)
    return Promise.resolve({ sessionId: "session-agent-adapter" })
  }

  authenticate(): Promise<acp.AuthenticateResponse> {
    return Promise.resolve({})
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    const prompt = params.prompt[0]?.type === "text" ? params.prompt[0].text : ""
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: {
          type: "text",
          text: `adapter received ${prompt}`,
        },
      },
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "inspect_runtime_context",
        kind: "read",
        status: "pending",
        rawInput: { context: "current" },
      },
    })
    return { stopReason: "end_turn" }
  }

  cancel(): Promise<void> {
    return Promise.resolve()
  }
}

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

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

const startFixtureAgent = (harness: Harness): AgentAdapterFixtureAgent => {
  let agent: AgentAdapterFixtureAgent | undefined
  const stream = acp.ndJsonStream(harness.agentOutput, harness.agentInput)
  new acp.AgentSideConnection(connection => {
    agent = new AgentAdapterFixtureAgent(connection)
    return agent
  }, stream)
  if (agent === undefined) {
    throw new Error("expected ACP fixture agent to initialize synchronously")
  }
  return agent
}

const reserveLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = createServer()
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      if (address === null || typeof address === "string") {
        socket.close(() => reject(new Error("expected TCP address")))
        return
      }
      const port = address.port
      socket.close(error => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })

const createHostBoundRuntimeContext = (
  input: {
    readonly contextId: FiregridSessionId
    readonly hostContext: Context.Context<FiregridHost>
  },
): Effect.Effect<RuntimeContext, DurableTableError | CurrentHostStopped, never> =>
  Effect.gen(function*() {
    // TFIND-038: temporary reach-past until client session creation can
    // express full public runtime intent without host-bound row construction.
    const table = Context.get(input.hostContext, RuntimeControlPlaneTable)
    const session = Context.get(input.hostContext, CurrentHostSession)
    const createdAtMs = yield* Clock.currentTimeMillis
    const runtimeContext = yield* makeLocalRuntimeContextForHostSession(
      session,
      normalizeRuntimeIntent(local.jsonl({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
        agent: "fixture-acp-adapter",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
      })),
      {
        contextId: input.contextId,
        createdAtMs,
        createdBy: "tiny-firegrid",
      },
    )
    yield* table.contexts.upsert(runtimeContext)
    return runtimeContext
  }).pipe(
    Effect.provide(input.hostContext),
  )

describe("tiny-firegrid agent-adapter-driven pipeline", () => {
  it("firegrid-effect-ai-native-agents.ACP_ADAPTER.14 firegrid-effect-ai-native-agents.VALIDATION.13 composes the production host/MCP surface with an ACP AgentAdapter session", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const namespace = `tiny-agent-adapter-${crypto.randomUUID()}`
    const mcpPort = await reserveLoopbackPort()
    const contextId = sessionContextIdForExternalKey({
      source: "tiny-firegrid",
      id: "agent-adapter",
    })
    const mcpUrl = agentAdapterDrivenMcpUrl({
      host: "127.0.0.1",
      port: mcpPort,
      path: "/mcp",
      contextId,
    })
    const hostLayer = tinyAgentAdapterDrivenPipeline({
      baseUrl,
      namespace,
      mcpPort,
    })

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const hostContext = yield* Layer.build(hostLayer)
      const runtimeContext = yield* createHostBoundRuntimeContext({
        contextId,
        hostContext,
      })
      const harness = yield* makeHarness
      const fixture = startFixtureAgent(harness)
      const parts = yield* Effect.gen(function*() {
        // TFIND-024: runtime host execution does not yet select AgentAdapter
        // services; this configuration exercises the adapter and host/MCP
        // surfaces as sibling public surfaces until registry integration lands.
        const adapter = yield* AgentAdapter
        const generated = yield* adapter.languageModel.generateText({
          prompt: "inspect this Firegrid runtime context",
        })
        const streamed = yield* adapter.languageModel.streamText({
          prompt: "stream this Firegrid runtime context",
        }).pipe(Stream.runCollect)
        return {
          capabilities: adapter.capabilities,
          generated,
          streamed: Chunk.toReadonlyArray(streamed),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(AcpAgentAdapter.layer({
          bytes: harness.bytes,
          session: {
            cwd: globalThis.process.cwd(),
            mcpServers: [{
              type: "http",
              name: "firegrid-runtime-context",
              url: mcpUrl,
              headers: [],
            }],
          },
        })),
      )
      return { runtimeContext, fixture, parts }
    })))

    expect(result.runtimeContext.contextId).toBe(contextId)
    expect(result.parts.capabilities).toEqual(AcpAdapterCapabilities)
    expect(result.fixture.newSessionRequests).toHaveLength(1)
    expect(result.fixture.newSessionRequests[0]?.mcpServers).toEqual([{
      type: "http",
      name: "firegrid-runtime-context",
      url: mcpUrl,
      headers: [],
    }])
    expect(result.parts.generated.text).toBe(
      "adapter received inspect this Firegrid runtime context",
    )
    expect(result.parts.generated.content).toContainEqual(
      Response.toolCallPart({
        id: "tool-1",
        name: "inspect_runtime_context",
        params: { context: "current" },
        providerExecuted: true,
      }),
    )
    expect(result.parts.streamed).toContainEqual(
      Response.textDeltaPart({
        id: "message-1",
        delta: "adapter received stream this Firegrid runtime context",
      }),
    )
    expect(result.parts.streamed).toContainEqual(
      Response.toolCallPart({
        id: "tool-1",
        name: "inspect_runtime_context",
        params: { context: "current" },
        providerExecuted: true,
      }),
    )
  })
})
