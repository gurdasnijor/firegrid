import * as acp from "@agentclientprotocol/sdk"
import { IdGenerator } from "@effect/ai"
import {
  firegridRuntimeContextMcpName,
  HostIdSchema,
  HostSessionIdSchema,
  makeHostSessionRow,
  makeRuntimeContext,
  normalizeRuntimeIntent,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Context, Deferred, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type { AgentByteStream } from "../../src/sources/sandbox/byte-stream.ts"
import {
  defaultCapabilities,
  SandboxProvider,
  SandboxProviderError,
  type Sandbox,
  type SandboxConfig,
  type SandboxCommand,
} from "../../src/sources/sandbox/SandboxProvider.ts"
import { RuntimeEnvResolverPolicy } from "../../src/sources/sandbox/secrets.ts"
import { RuntimeContextSessionAdapter } from "../../src/unified/adapter.ts"
import { ProductionCodecAdapterLive } from "../../src/unified/codec-adapter.ts"
import {
  CodecOutputJournalTag,
  ContextResolverTag,
} from "../../src/tables/codec-adapter-tags.ts"
import {
  FiregridRuntimeContextMcpBaseUrl,
  FiregridRuntimeContextMcpBaseUrlLive,
} from "../../src/unified/mcp-host/runtime-context-mcp-base-url.ts"

interface Harness {
  readonly bytes: AgentByteStream
  readonly agentInput: ReadableStream<Uint8Array>
  readonly agentOutput: WritableStream<Uint8Array>
  readonly exit: Deferred.Deferred<{ readonly exitCode?: number; readonly signal?: string }, unknown>
}

class NewSessionRecorderAgent implements acp.Agent {
  readonly newSessionRequests: Array<acp.NewSessionRequest> = []

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
    return { sessionId: "session-marker" }
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async prompt(): Promise<acp.PromptResponse> {
    return { stopReason: "end_turn" }
  }

  async cancel(): Promise<void> {}
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

const startAgent = (harness: Harness): NewSessionRecorderAgent => {
  let agent: NewSessionRecorderAgent | undefined
  const stream = acp.ndJsonStream(harness.agentOutput, harness.agentInput)
  new acp.AgentSideConnection((_connection) => {
    agent = new NewSessionRecorderAgent()
    return agent
  }, stream)
  if (agent === undefined) {
    throw new Error("expected ACP fixture agent to initialize synchronously")
  }
  return agent
}

const makeContext = (contextId: string, mcpEnabled: boolean): RuntimeContext =>
  {
    const hostId = Schema.decodeSync(HostIdSchema)("host_marker")
    const hostSessionId = Schema.decodeSync(HostSessionIdSchema)("host_marker_session")
    return makeRuntimeContext({
      contextId,
      createdAtMs: 0,
      runtime: normalizeRuntimeIntent({
        provider: "local-process",
        config: {
          argv: ["codex-acp-fixture"],
          agentProtocol: "acp",
          ...(mcpEnabled ? { runtimeContextMcp: { enabled: true } } : {}),
        },
      }),
      host: {
        hostId,
        streamPrefix: makeHostSessionRow({
          hostId,
          hostSessionId,
          namespace: "marker-test",
          startedAtMs: 0,
        }).streamPrefix,
        boundAtMs: 0,
      },
    })
  }

const sandboxProviderLayer = (harness: Harness): Layer.Layer<SandboxProvider> => {
  const sandbox: Sandbox = {
    id: "sandbox-marker",
    provider: "marker-test",
    state: "running",
    labels: {},
    connectionInfo: {},
    metadata: {},
  }
  return SandboxProvider.layer({
    name: "marker-test",
    capabilities: defaultCapabilities,
    create: (_config: SandboxConfig) => Effect.succeed(sandbox),
    getOrCreate: (_config: SandboxConfig) => Effect.succeed(sandbox),
    find: (_labels: Record<string, string>) => Effect.sync(() => undefined),
    execute: (_sandbox: Sandbox, _command: SandboxCommand) =>
      Effect.fail(new SandboxProviderError({
        provider: "marker-test",
        op: "execute",
        message: "execute not used in marker test",
      })),
    executeMany: (_sandbox: Sandbox, _commands: ReadonlyArray<SandboxCommand>) =>
      Effect.succeed([]),
    stream: (_sandbox: Sandbox, _command: SandboxCommand) =>
      Stream.die("stream not used in marker test"),
    openBytePipe: (_sandbox: Sandbox, _command: SandboxCommand) =>
      Effect.succeed(harness.bytes),
    upload: () => Effect.void,
    download: () => Effect.void,
    destroy: () => Effect.succeed(true),
  })
}

const adapterLayer = (
  harness: Harness,
  context: RuntimeContext,
): Layer.Layer<RuntimeContextSessionAdapter, never, FiregridRuntimeContextMcpBaseUrl> =>
  ProductionCodecAdapterLive.pipe(
    Layer.provide(sandboxProviderLayer(harness)),
    Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
    Layer.provide(Layer.succeed(ContextResolverTag, {
      resolve: (contextId: string) =>
        Effect.succeed(contextId === context.contextId ? Option.some(context) : Option.none()),
    })),
    Layer.provide(Layer.succeed(CodecOutputJournalTag, {
      append: () => Effect.void,
    })),
    Layer.provide(RuntimeEnvResolverPolicy.denyAll),
  )

const startAdapter = (
  harness: Harness,
  context: RuntimeContext,
  mcpBase?: { readonly address: string; readonly basePath: "/mcp" },
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const agent = startAgent(harness)
      const contextServices = yield* Layer.buildWithScope(
        adapterLayer(harness, context).pipe(
          Layer.provideMerge(FiregridRuntimeContextMcpBaseUrlLive),
        ),
        yield* Effect.scope,
      )
      if (mcpBase !== undefined) {
        const baseUrl = Context.get(contextServices, FiregridRuntimeContextMcpBaseUrl)
        yield* baseUrl.publish(mcpBase)
      }
      const adapter = Context.get(contextServices, RuntimeContextSessionAdapter)
      const exit = yield* adapter.startOrAttach(context.contextId, 1).pipe(Effect.exit)
      return { agent, exit }
    }),
  )

describe("runtimeContextMcp marker auto-provisioning", () => {
  it("injects the host-bound runtime-context MCP URL into ACP newSession", async () => {
    const context = makeContext("ctx marker/slash", true)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const harness = yield* makeHarness
        return yield* startAdapter(harness, context, {
          address: "http://127.0.0.1:65432",
          basePath: "/mcp",
        })
      }),
    )

    expect(Exit.isSuccess(result.exit)).toBe(true)
    expect(result.agent.newSessionRequests).toHaveLength(1)
    expect(result.agent.newSessionRequests[0]?.mcpServers).toEqual([
      {
        type: "http",
        name: firegridRuntimeContextMcpName,
        url: "http://127.0.0.1:65432/mcp/runtime-context/ctx%20marker%2Fslash",
        headers: [],
      },
    ])
    expect(result.agent.newSessionRequests[0]?._meta).toMatchObject({
      claudeCode: {
        options: {
          mcpServers: {
            "firegrid-runtime-context-alwaysload": {
              type: "http",
              url: "http://127.0.0.1:65432/mcp/runtime-context/ctx%20marker%2Fslash",
              alwaysLoad: true,
            },
          },
        },
      },
    })
  })

  it("fails before spawning when the marker is set but no MCP listener is bound", async () => {
    const context = makeContext("ctx-no-listener", true)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const harness = yield* makeHarness
        return yield* startAdapter(harness, context)
      }),
    )

    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(result.agent.newSessionRequests).toHaveLength(0)
  })
})
