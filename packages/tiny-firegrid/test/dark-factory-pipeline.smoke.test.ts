// tf-se0 evidence smoke: this is intentionally on-demand only
// (`pnpm --filter @firegrid/tiny-firegrid test:smoke`). It records the
// public-surface breakpoints for the real-agent dark-factory choreography
// probe; it must not grow an app-led phase driver.

import * as acp from "@agentclientprotocol/sdk"
import { IdGenerator } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type RuntimeContextSnapshot,
} from "@firegrid/client-sdk/firegrid"
import {
  localProcessSpawnEnvFromHostEnv,
  FiregridAgentToolkit,
} from "@firegrid/host-sdk"
import {
  WaitForToolInputSchema,
} from "@firegrid/protocol/agent-tools"
import {
  AcpSessionLive,
  AgentSession,
} from "@firegrid/runtime/codecs"
import type { AgentByteStream } from "@firegrid/runtime/sources/sandbox"
import {
  Chunk,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  darkFactoryChoreographyEvidencePrompt,
  darkFactoryRealAgentEnvPolicy,
  DarkFactoryEvidenceTable,
  makeDarkFactoryTriggerAcceptedFact,
  tinyDarkFactoryPipeline,
} from "../src/configurations/dark-factory-pipeline.ts"

type AgentOutputObservation = RuntimeContextSnapshot["agentOutputs"][number]

interface AcpHarness {
  readonly bytes: AgentByteStream
  readonly agentInput: ReadableStream<Uint8Array>
  readonly agentOutput: WritableStream<Uint8Array>
  readonly exit: Deferred.Deferred<{ readonly exitCode?: number; readonly signal?: string }, unknown>
}

class LoadCapableFixtureAgent implements acp.Agent {
  readonly newSessionRequests: Array<acp.NewSessionRequest> = []
  readonly loadSessionRequests: Array<acp.LoadSessionRequest> = []
  readonly replayedUpdates: Array<acp.SessionNotification> = []
  private readonly connection: acp.AgentSideConnection

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
      },
    }
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.newSessionRequests.push(params)
    return { sessionId: "acp-session-1" }
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    this.loadSessionRequests.push(params)
    const replay: acp.SessionNotification = {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed-before-tool-call" },
      },
    }
    this.replayedUpdates.push(replay)
    await this.connection.sessionUpdate(replay)
    return {}
  }

  async resumeSession(): Promise<acp.ResumeSessionResponse> {
    return {}
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async cancel(): Promise<void> {}

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "pending-wait-for",
        title: "wait_for approval",
        kind: "read",
        status: "pending",
        rawInput: { source: "approval" },
      },
    })
    return { stopReason: "end_turn" }
  }
}

const makeAcpHarness = Effect.gen(function*() {
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
  } satisfies AcpHarness
})

const startLoadCapableFixtureAgent = (harness: AcpHarness): LoadCapableFixtureAgent => {
  let agent: LoadCapableFixtureAgent | undefined
  const stream = acp.ndJsonStream(harness.agentOutput, harness.agentInput)
  new acp.AgentSideConnection(connection => {
    agent = new LoadCapableFixtureAgent(connection)
    return agent
  }, stream)
  if (agent === undefined) {
    throw new Error("expected ACP fixture agent to initialize synchronously")
  }
  return agent
}

const openAcpSession = (
  bytes: AgentByteStream,
) =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const context = yield* Layer.buildWithScope(
      AcpSessionLive(bytes).pipe(
        Layer.provide(Layer.succeed(
          IdGenerator.IdGenerator,
          IdGenerator.defaultIdGenerator,
        )),
      ),
      scope,
    )
    return Context.get(context, AgentSession)
  })

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

interface RealToolUseAgent {
  readonly agent: string
  readonly argv: ReadonlyArray<string>
  readonly envBindingName: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"
}

const selectRealToolUseAgent = (): RealToolUseAgent | undefined => {
  if (
    typeof globalThis.process.env.OPENAI_API_KEY === "string" &&
    globalThis.process.env.OPENAI_API_KEY.length > 0
  ) {
    return {
      agent: "codex-acp",
      argv: ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
      envBindingName: "OPENAI_API_KEY",
    }
  }
  if (
    typeof globalThis.process.env.ANTHROPIC_API_KEY === "string" &&
    globalThis.process.env.ANTHROPIC_API_KEY.length > 0
  ) {
    return {
      agent: "claude-acp",
      argv: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.34.1"],
      envBindingName: "ANTHROPIC_API_KEY",
    }
  }
  return undefined
}

const realAgent = selectRealToolUseAgent()

if (realAgent === undefined) {
  console.warn(
    "Skipping dark-factory real-agent evidence smoke: OPENAI_API_KEY or ANTHROPIC_API_KEY is not set.",
  )
}

const localProcessEnv = () => {
  const base = localProcessSpawnEnvFromHostEnv(globalThis.process.env)
  const baselineEnvVars = { ...(base.baselineEnvVars ?? {}) }
  for (const key of [
    "HOME",
    "TMPDIR",
    "TEMP",
    "USER",
    "LOGNAME",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ]) {
    const value = globalThis.process.env[key]
    if (value !== undefined && value.length > 0) baselineEnvVars[key] = value
  }
  return {
    ...base,
    baselineEnvVars,
  }
}

const provideClient = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Effect.Effect<A, E | DurableTableError | FiregridConfigError, Exclude<R, Firegrid>> =>
  self.pipe(
    Effect.provide(FiregridStandaloneLive),
    Effect.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: input.baseUrl,
      namespace: input.namespace,
    })),
  )

const waitForAgentOutputMatching = (
  sessionId: string,
  input: {
    readonly baseUrl: string
    readonly namespace: string
    readonly afterSequence?: number
    readonly timeoutMs: number
  },
) =>
  provideClient(
    Effect.gen(function*() {
      const firegrid = yield* Firegrid
      const session = yield* firegrid.sessions.attach({ sessionId })
      return yield* session.wait.forAgentOutput({
        ...(input.afterSequence === undefined
          ? {}
          : { afterSequence: input.afterSequence }),
        timeoutMs: input.timeoutMs,
      })
    }),
    input,
  ).pipe(
    Effect.retry(
      Schedule.intersect(
        Schedule.spaced("1000 millis"),
        Schedule.recurs(5),
      ),
    ),
  )

const collectEvidence = (
  sessionId: string,
  input: {
    readonly baseUrl: string
    readonly namespace: string
    readonly timeoutMs: number
  },
) =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + input.timeoutMs
    let afterSequence: number | undefined
    let text = ""
    let sawReady = false
    const toolUses: Array<{ readonly name: string; readonly params: unknown }> = []
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const remaining = Math.max(1, deadline - (yield* Clock.currentTimeMillis))
      const next = yield* waitForAgentOutputMatching(sessionId, {
        baseUrl: input.baseUrl,
        namespace: input.namespace,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: Math.min(remaining, 15_000),
      })
      if (!next.matched) continue
      const observation: AgentOutputObservation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      if (event._tag === "Ready") sawReady = true
      if (event._tag === "ToolUse") {
        toolUses.push({ name: event.part.name, params: event.part.params })
        if (event.part.name === "wait_for") break
      }
      if (event._tag === "TextChunk") {
        text += event.part.delta
        if (text.includes("DARK_FACTORY_EVIDENCE_DONE")) break
      }
    }
    return { sawReady, toolUses, text }
  })

describe("tiny-firegrid dark-factory evidence smoke", () => {
  it("documents the current public tool surface precisely enough to avoid over-broad findings", async () => {
    const toolNames = Object.keys(FiregridAgentToolkit.tools).sort()
    expect(toolNames).toEqual([
      "execute",
      "schedule_me",
      "session_cancel",
      "session_close",
      "session_new",
      "session_prompt",
      "sleep",
      "wait_for",
    ])

    const invalidCallerFactWait = await Effect.runPromiseExit(
      Schema.decodeUnknown(WaitForToolInputSchema)({
        waitQuery: {
          source: { _tag: "DarkFactoryFact" },
          whereFields: {
            eventType: "factory.permission.resolved",
            factoryRunKey: "factory-run-evidence",
          },
        },
        timeoutMs: 1,
      }),
    )
    expect(Exit.isFailure(invalidCallerFactWait)).toBe(true)

    const validRuntimeWait = await Effect.runPromiseExit(
      Schema.decodeUnknown(WaitForToolInputSchema)({
        waitQuery: {
          source: { _tag: "AgentOutput" },
          whereFields: {
            contextId: "ctx_example",
            _tag: "TextChunk",
          },
        },
        timeoutMs: 1,
      }),
    )
    expect(Exit.isSuccess(validRuntimeWait)).toBe(true)
  })

  it("classifies the ACP session/load crux as a narrow Firegrid surface gap before protocol mismatch", async () => {
    const evidence = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const harness = yield* makeAcpHarness
        const agent = startLoadCapableFixtureAgent(harness)
        const session = yield* openAcpSession(harness.bytes)
        const first = yield* session.outputs.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(Chunk.toReadonlyArray),
        )
        return {
          acpSdkHasLoadSession:
            typeof acp.ClientSideConnection.prototype.loadSession === "function",
          acpSdkHasResumeSession:
            typeof acp.ClientSideConnection.prototype.resumeSession === "function",
          firegridCodecCalledNewSession: agent.newSessionRequests.length,
          firegridCodecCalledLoadSession: agent.loadSessionRequests.length,
          agentSessionMeta: session.meta,
          first,
          cruxQuestions: {
            hostCanInvokeSessionLoadThroughPublicSurface: false,
            resumedConversationObservation:
              "not-reached-firegrid-does-not-invoke-session-load",
            pendingToolResultDelivery:
              "not-reached-firegrid-does-not-invoke-session-load",
          },
          acpSpec: {
            url: "https://agentclientprotocol.com/protocol/session-setup#resuming-sessions",
            loadSessionReplay:
              "ACP session/load replays the entire conversation with session/update notifications before the load response; session/resume reconnects without replay.",
          },
          classification: "b:narrow-surface-exposure-gap",
        }
      })),
    )

    console.error("[dark-factory-session-load-evidence]", JSON.stringify(evidence, null, 2))

    expect(evidence.acpSdkHasLoadSession).toBe(true)
    expect(evidence.acpSdkHasResumeSession).toBe(true)
    expect(evidence.firegridCodecCalledNewSession).toBe(1)
    expect(evidence.firegridCodecCalledLoadSession).toBe(0)
    expect(evidence.agentSessionMeta).not.toHaveProperty("sessionId")
    expect(evidence.cruxQuestions.hostCanInvokeSessionLoadThroughPublicSurface).toBe(false)
    expect(evidence.classification).toBe("b:narrow-surface-exposure-gap")
  })

  const maybeIt = realAgent === undefined ? it.skip : it

  maybeIt(
    "hands a real tool-use agent the runtime-context MCP surface and records the dark-factory choreography breakpoints",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")
      if (realAgent === undefined) throw new Error("real agent env not selected")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-dark-factory-${crypto.randomUUID()}`
      const factoryRunKey = `factory-run-${crypto.randomUUID()}`
      const triggerFact = makeDarkFactoryTriggerAcceptedFact({
        factoryRunKey,
        externalEventKey: "mock-trigger-1",
        externalEntityKey: "ticket-DF-1",
        createdAt: new Date().toISOString(),
        payload: {
          title: "Open a PR after approval",
          repository: "gurdasnijor/firegrid",
        },
      })
      const approvalSignalExternalKey = {
        source: "tiny-firegrid",
        id: `approval-signal-${factoryRunKey}`,
      }
      let hostScope: Scope.CloseableScope | undefined

      const evidence = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          hostScope = yield* Scope.make()
          yield* Effect.addFinalizer(() =>
            hostScope === undefined
              ? Effect.void
              : Scope.close(hostScope, Exit.void).pipe(
                  Effect.tap(() => Effect.sync(() => {
                    hostScope = undefined
                  })),
                )
          )
          const hostLayer = tinyDarkFactoryPipeline({
            baseUrl: durableStreamsBaseUrl,
            namespace,
            localProcessEnv: localProcessEnv(),
            envPolicy: darkFactoryRealAgentEnvPolicy(globalThis.process.env),
          })
          const hostContext = yield* Layer.buildWithScope(hostLayer, hostScope)
          const table = Context.get(hostContext, DarkFactoryEvidenceTable)
          yield* table.facts.insertOrGet(triggerFact)

          const sessionContextId = yield* provideClient(
            Effect.gen(function*() {
              const firegrid = yield* Firegrid
              const approvalSignal = yield* firegrid.sessions.createOrLoad({
                externalKey: approvalSignalExternalKey,
                runtime: local.jsonl({
                  argv: [
                    process.execPath,
                    "-e",
                    "process.stdin.resume()",
                  ],
                  agent: "approval-signal",
                  agentProtocol: "stdio-jsonl",
                  cwd: globalThis.process.cwd(),
                }),
                createdBy: "tiny-firegrid",
              })
              const planner = yield* firegrid.sessions.createOrLoad({
                externalKey: {
                  source: "tiny-firegrid",
                  id: `dark-factory-${factoryRunKey}`,
                },
                runtime: local.jsonl({
                  argv: [...realAgent.argv],
                  agent: realAgent.agent,
                  agentProtocol: "acp",
                  cwd: globalThis.process.cwd(),
                  envBindings: [
                    {
                      name: realAgent.envBindingName,
                      ref: `env:${realAgent.envBindingName}`,
                    },
                  ],
                  runtimeContextMcp: { enabled: true },
                }),
                createdBy: "tiny-firegrid",
              })
              yield* planner.prompt({
                payload: darkFactoryChoreographyEvidencePrompt({
                  factoryRunKey,
                  triggerFact,
                  approvalSignalContextId: approvalSignal.contextId,
                  implementerAgentKind: realAgent.agent,
                }),
                idempotencyKey: `dark-factory-evidence:${factoryRunKey}:prompt`,
              }).pipe(
                Effect.retry(
                  Schedule.intersect(
                    Schedule.spaced("1000 millis"),
                    Schedule.recurs(60),
                  ),
                ),
              )
              yield* planner.start()
              return planner.contextId
            }),
            { baseUrl: durableStreamsBaseUrl, namespace },
          )

          const beforeCrash = yield* collectEvidence(sessionContextId, {
            baseUrl: durableStreamsBaseUrl,
            namespace,
            timeoutMs: 240_000,
          })

          yield* Scope.close(hostScope, Exit.void)
          hostScope = undefined

          return {
            factoryRunKey,
            plannerContextId: sessionContextId,
            beforeCrash,
            publicSurface: {
              tools: Object.keys(FiregridAgentToolkit.tools).sort(),
              callerFactWaitSourceAccepted: false,
              localProcessPersistent: false,
              realAgentUsedTool:
                beforeCrash.toolUses.length > 0,
              realAgentCompletedWithoutToolUse:
                beforeCrash.toolUses.length === 0 &&
                beforeCrash.text.includes("DARK_FACTORY_EVIDENCE_DONE"),
            },
          }
        })),
      )

      console.error("[dark-factory-evidence]", JSON.stringify(evidence, null, 2))

      expect(evidence.beforeCrash.sawReady).toBe(true)
      expect(
        evidence.publicSurface.realAgentUsedTool ||
          evidence.publicSurface.realAgentCompletedWithoutToolUse,
      ).toBe(true)
      expect(evidence.publicSurface.callerFactWaitSourceAccepted).toBe(false)
      expect(evidence.publicSurface.localProcessPersistent).toBe(false)
    },
    300_000,
  )
})
