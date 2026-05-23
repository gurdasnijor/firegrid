import * as acp from "@agentclientprotocol/sdk"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  HostContextsChannel,
  HostContextsChannelTarget,
  HostPermissionRespondChannelTarget,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsStartChannelTarget,
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  SessionPromptChannelTarget,
  UnknownChannelTarget,
} from "@firegrid/protocol/channels"
import {
  HostIdSchema,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  RuntimeContextSchema,
} from "@firegrid/protocol/launch"
import { FiregridRuntimeObservationSourceNames } from "@firegrid/protocol/observations"
import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import { RuntimeAgentOutputObservationSchema } from "@firegrid/protocol/session-facade"
import { HostPlaneChannelRouter } from "@firegrid/runtime/channels"
import { Effect, Layer, Schema, Stream, Tracer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AcpStdioEdgeLive,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
} from "../../src/host/index.ts"
import { classifyTurnIdleTimeoutReason } from "../../src/host/acp-stdio-edge.ts"

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

interface InMemoryAcpHarness {
  readonly edgeInput: ReadableStream<Uint8Array>
  readonly edgeOutput: WritableStream<Uint8Array>
  readonly clientInput: ReadableStream<Uint8Array>
  readonly clientOutput: WritableStream<Uint8Array>
}

const makeInMemoryAcpHarness = (): InMemoryAcpHarness => {
  const clientToEdge = new TransformStream<Uint8Array, Uint8Array>()
  const edgeToClient = new TransformStream<Uint8Array, Uint8Array>()
  return {
    edgeInput: clientToEdge.readable,
    edgeOutput: edgeToClient.writable,
    clientInput: edgeToClient.readable,
    clientOutput: clientToEdge.writable,
  }
}

const backingAgentProgram = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let turn = 0
const write = value => process.stdout.write(JSON.stringify(value) + "\\n")
rl.on("line", line => {
  turn += 1
  write({ type: "status", kind: turn === 1 ? "available_commands_update" : "tool_call_update" })
  write({ type: "text", messageId: "edge-message-" + turn, text: "host-sdk acp edge turn " + turn })
  write({ type: "turn_complete", messageId: "edge-message-" + turn, finishReason: "stop" })
})
`

const backingAcpAgentProgram = `
import * as acp from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"

class Agent {
  constructor(connection) {
    this.connection = connection
  }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }
  }
  async newSession() {
    return { sessionId: "backing-acp-session" }
  }
  async authenticate() {
    return {}
  }
  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "linked:" + params.messageId },
      },
    })
    return { stopReason: "end_turn", userMessageId: params.messageId }
  }
  async cancel() {}
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
)
new acp.AgentSideConnection(connection => new Agent(connection), stream)
`

const textFromUpdates = (
  updates: ReadonlyArray<acp.SessionNotification>,
): ReadonlyArray<string> =>
  updates.flatMap(notification => {
    const update = notification.update
    return update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ? [update.content.text]
      : []
  })

const makeClient = (
  updates: Array<acp.SessionNotification>,
): acp.Client => ({
  sessionUpdate: async params => {
    updates.push(params)
  },
  requestPermission: async params => ({
    outcome: {
      outcome: "selected",
      optionId: params.options[0]?.optionId ?? "allow",
    },
  }),
})

const fakeRuntimeContext = (contextId: string) =>
  Schema.decodeUnknownSync(RuntimeContextSchema)({
    contextId,
    createdAt: new Date(0).toISOString(),
    runtime: normalizeRuntimeIntent(local.jsonl({
      argv: [globalThis.process.execPath, "-e", ""],
      agent: "fake-agent",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
    })),
    host: {
      hostId: Schema.decodeUnknownSync(HostIdSchema)("host-test"),
      streamPrefix: makeHostStreamPrefix({
        namespace: "test",
        hostId: Schema.decodeUnknownSync(HostIdSchema)("host-test"),
      }),
      boundAtMs: 0,
    },
  })

const permissionRequestOutput = (
  contextId: string,
): RuntimeAgentOutputObservation =>
  Schema.decodeUnknownSync(RuntimeAgentOutputObservationSchema)({
    _tag: "PermissionRequest",
    source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
    sessionId: contextId,
    contextId,
    activityAttempt: 1,
    sequence: 0,
    permissionRequestId: "permission-test",
    toolUseId: "tool-test",
    options: [{
      optionId: "allow-once",
      kind: "allow_once",
      name: "Allow once",
    }],
    event: {
      _tag: "PermissionRequest",
      permissionRequestId: "permission-test",
      toolUseId: "tool-test",
      options: [{
        optionId: "allow-once",
        kind: "allow_once",
        name: "Allow once",
      }],
    },
  })

const turnCompleteOutput = (
  contextId: string,
): RuntimeAgentOutputObservation =>
  Schema.decodeUnknownSync(RuntimeAgentOutputObservationSchema)({
    _tag: "TurnComplete",
    source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
    sessionId: contextId,
    contextId,
    activityAttempt: 1,
    sequence: 1,
    event: {
      _tag: "TurnComplete",
      finishReason: "stop",
    },
  })

const toolUseOutput = (
  contextId: string,
): RuntimeAgentOutputObservation =>
  Schema.decodeUnknownSync(RuntimeAgentOutputObservationSchema)({
    _tag: "ToolUse",
    source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
    sessionId: contextId,
    contextId,
    activityAttempt: 1,
    sequence: 0,
    toolUseId: "tool-test",
    toolName: "not_a_real_tool",
    event: {
      _tag: "ToolUse",
      part: {
        type: "tool-call",
        id: "tool-test",
        name: "not_a_real_tool",
        params: {},
        providerExecuted: false,
      },
    },
  })

const acpEdgeOutputHandlingIntentions = {
  Ready: "no-op",
  TextChunk: "forward",
  ToolUse: "forward",
  PermissionRequest: "answer",
  TurnComplete: "terminal",
  Status: "no-op",
  Error: "terminal",
  Terminated: "terminal",
} as const satisfies Record<
  RuntimeAgentOutputObservation["_tag"],
  "answer" | "forward" | "no-op" | "terminal"
>

interface CapturedSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
}

const capturingTracerLayer = (
  capturedSpans: Array<CapturedSpan>,
): Layer.Layer<never> => {
  const tracer: Tracer.Tracer = {
    [Tracer.TracerTypeId]: Tracer.TracerTypeId,
    span: (name, parent, context, links, startTime, kind) => {
      const attributes: Record<string, unknown> = {}
      capturedSpans.push({ name, attributes })
      const span: Tracer.Span = {
        _tag: "Span",
        name,
        spanId: `acp-edge-${crypto.randomUUID()}`,
        traceId: "acp-edge-test",
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes: new Map<string, unknown>(),
        links,
        sampled: true,
        kind,
        end: () => {},
        attribute: (key, value) => {
          attributes[key] = value
        },
        event: () => {},
        addLinks: () => {},
      }
      return span
    },
    context: f => f(),
  }
  return Layer.setTracer(tracer)
}

// tf-lgb1: drive a single ACP turn against fully-mocked router + output
// channel so a test controls the exact output observation sequence. An
// `outputStream` that never emits a terminal (use Stream.never to stay open)
// forces the idle timeout; the classified reason lands on the
// `firegrid.acp_stdio_edge.turn_output` span.
const runMockEdgeTurn = (options: {
  readonly contextId: string
  readonly turnTimeoutMs: number
  readonly outputStream: Stream.Stream<RuntimeAgentOutputObservation>
}): Promise<{
  readonly capturedSpans: ReadonlyArray<CapturedSpan>
  readonly promptResolved: boolean
}> => {
  const harness = makeInMemoryAcpHarness()
  const { contextId } = options
  const capturedSpans: Array<CapturedSpan> = []
  const layer = AcpStdioEdgeLive({
    input: harness.edgeInput,
    output: harness.edgeOutput,
    turnTimeoutMs: options.turnTimeoutMs,
    runtime: local.jsonl({
      argv: [globalThis.process.execPath, "-e", ""],
      agent: "mock-agent",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
    }),
  }).pipe(
    Layer.provideMerge(
      Layer.succeed(HostPlaneChannelRouter, {
        descriptor: { routes: [], metadata: [] },
        metadata: [],
        route: target => Effect.fail(new UnknownChannelTarget({ target: String(target) })),
        dispatch: request =>
          Effect.sync(() => {
            switch (String(request.target)) {
              case String(HostSessionsCreateOrLoadChannelTarget):
                return { contextId, sessionId: contextId }
              case String(SessionPromptChannelTarget):
              case String(HostSessionsStartChannelTarget):
              case String(HostPermissionRespondChannelTarget):
                return { accepted: true }
              default:
                throw new Error(`unexpected dispatch target ${String(request.target)}`)
            }
          }),
      } satisfies HostPlaneChannelRouter["Type"]),
    ),
    Layer.provideMerge(
      Layer.succeed(HostContextsChannel, makeIngressChannel({
        target: HostContextsChannelTarget,
        schema: RuntimeContextSchema,
        stream: Stream.make(fakeRuntimeContext(contextId)),
      })),
    ),
    Layer.provideMerge(
      Layer.succeed(SessionAgentOutputChannel, {
        forContext: () =>
          makeIngressChannel({
            target: SessionAgentOutputChannelTarget,
            schema: RuntimeAgentOutputObservationSchema,
            stream: options.outputStream,
          }),
      } satisfies SessionAgentOutputChannel["Type"]),
    ),
    Layer.provideMerge(capturingTracerLayer(capturedSpans)),
  )
  return Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      yield* Layer.build(layer)
      const stream = acp.ndJsonStream(harness.clientOutput, harness.clientInput)
      const connection = new acp.ClientSideConnection(() => makeClient([]), stream)
      yield* Effect.promise(() =>
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }))
      const session = yield* Effect.promise(() =>
        connection.newSession({ cwd: globalThis.process.cwd(), mcpServers: [] }))
      const promptResolved = yield* Effect.promise(() =>
        connection.prompt({
          sessionId: session.sessionId,
          messageId: "mock-turn",
          prompt: [{ type: "text", text: "go" }],
        }).then(() => true, () => false))
      return { capturedSpans, promptResolved }
    }),
  ))
}

const turnTimeoutReason = (
  spans: ReadonlyArray<CapturedSpan>,
): unknown =>
  spans.find(span => span.name === "firegrid.acp_stdio_edge.turn_output")
    ?.attributes["firegrid.acp.turn.timeout_reason"]

// tf-l5px: drive one permission turn end-to-end through the real edge with a
// caller-supplied ACP client (Zed side) + policy, returning the host-plane
// dispatches so a test can assert the decision the edge mapped back.
const runPermissionScenario = (input: {
  readonly client: acp.Client
  readonly permissionPolicy?: "forward" | "deny" | "allow"
  readonly output?: (contextId: string) => RuntimeAgentOutputObservation
}) =>
  Effect.scoped(Effect.gen(function*() {
    const harness = makeInMemoryAcpHarness()
    const contextId = `ctx-${crypto.randomUUID()}`
    const dispatched: Array<{ readonly target: string; readonly verb: string; readonly payload: unknown }> = []
    const permissionOutput = (input.output ?? permissionRequestOutput)(contextId)
    const layer = AcpStdioEdgeLive({
      input: harness.edgeInput,
      output: harness.edgeOutput,
      turnTimeoutMs: 1_000,
      ...(input.permissionPolicy === undefined ? {} : { permissionPolicy: input.permissionPolicy }),
      runtime: local.jsonl({
        argv: [globalThis.process.execPath, "-e", backingAgentProgram],
        agent: "host-sdk-acp-edge-test-agent",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
    }).pipe(
      Layer.provideMerge(Layer.succeed(HostPlaneChannelRouter, {
        descriptor: { routes: [], metadata: [] },
        metadata: [],
        route: target => Effect.fail(new UnknownChannelTarget({ target: String(target) })),
        dispatch: request =>
          Effect.sync(() => {
            dispatched.push({ target: String(request.target), verb: request.verb, payload: request.payload })
            switch (String(request.target)) {
              case String(HostSessionsCreateOrLoadChannelTarget):
                return { contextId, sessionId: contextId }
              case String(SessionPromptChannelTarget):
                return { accepted: true }
              case String(HostSessionsStartChannelTarget):
                return { accepted: true }
              case String(HostPermissionRespondChannelTarget):
                return { accepted: true }
              default:
                throw new Error(`unexpected dispatch target ${String(request.target)}`)
            }
          }),
      } satisfies HostPlaneChannelRouter["Type"])),
      Layer.provideMerge(Layer.succeed(HostContextsChannel, makeIngressChannel({
        target: HostContextsChannelTarget,
        schema: RuntimeContextSchema,
        stream: Stream.make(fakeRuntimeContext(contextId)),
      }))),
      Layer.provideMerge(Layer.succeed(SessionAgentOutputChannel, {
        forContext: () =>
          makeIngressChannel({
            target: SessionAgentOutputChannelTarget,
            schema: RuntimeAgentOutputObservationSchema,
            stream: Stream.make(permissionOutput, turnCompleteOutput(contextId)),
          }),
      } satisfies SessionAgentOutputChannel["Type"])),
    )
    yield* Layer.build(layer)
    const stream = acp.ndJsonStream(harness.clientOutput, harness.clientInput)
    const connection = new acp.ClientSideConnection(() => input.client, stream)
    yield* Effect.promise(() =>
      connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }))
    const session = yield* Effect.promise(() =>
      connection.newSession({ cwd: globalThis.process.cwd(), mcpServers: [] }))
    const prompt = yield* Effect.promise(() =>
      connection.prompt({
        sessionId: session.sessionId,
        messageId: "host-sdk-acp-edge-permission",
        prompt: [{ type: "text", text: "run a tool" }],
      }))
    return { dispatched, contextId, stopReason: prompt.stopReason }
  }))

const permissionDecision = (
  dispatched: ReadonlyArray<{ readonly target: string; readonly payload: unknown }>,
): unknown => {
  const payload = dispatched.find(d => d.target === String(HostPermissionRespondChannelTarget))?.payload
  return (payload as { readonly decision?: unknown } | undefined)?.decision
}

describe("ACP stdio edge", () => {
  it("tf-lgb1 classifies an idle turn timeout from the last output observation", () => {
    expect(classifyTurnIdleTimeoutReason(undefined)).toBe("agent_silent")
    expect(classifyTurnIdleTimeoutReason("TextChunk")).toBe("agent_silent")
    expect(classifyTurnIdleTimeoutReason("Status")).toBe("agent_silent")
    expect(classifyTurnIdleTimeoutReason("Ready")).toBe("agent_silent")
    expect(classifyTurnIdleTimeoutReason("ToolUse")).toBe("tool_call_in_flight")
    expect(classifyTurnIdleTimeoutReason("PermissionRequest")).toBe("permission_unanswered")
  })

  it("tf-lgb1 agent_silent: a turn with no output times out as agent_silent", async () => {
    const contextId = `ctx-${crypto.randomUUID()}`
    const { capturedSpans, promptResolved } = await runMockEdgeTurn({
      contextId,
      turnTimeoutMs: 250,
      outputStream: Stream.never,
    })
    expect(promptResolved).toBe(false)
    expect(turnTimeoutReason(capturedSpans)).toBe("agent_silent")
  })

  it("tf-lgb1 tool_call_in_flight: a ToolUse then silence times out as tool_call_in_flight", async () => {
    const contextId = `ctx-${crypto.randomUUID()}`
    const { capturedSpans, promptResolved } = await runMockEdgeTurn({
      contextId,
      turnTimeoutMs: 250,
      outputStream: Stream.concat(Stream.make(toolUseOutput(contextId)), Stream.never),
    })
    expect(promptResolved).toBe(false)
    expect(turnTimeoutReason(capturedSpans)).toBe("tool_call_in_flight")
  })

  it("tf-lgb1 permission_unanswered: a PermissionRequest then silence times out as permission_unanswered", async () => {
    const contextId = `ctx-${crypto.randomUUID()}`
    const { capturedSpans, promptResolved } = await runMockEdgeTurn({
      contextId,
      turnTimeoutMs: 250,
      outputStream: Stream.concat(
        Stream.make(permissionRequestOutput(contextId)),
        Stream.never,
      ),
    })
    expect(promptResolved).toBe(false)
    expect(turnTimeoutReason(capturedSpans)).toBe("permission_unanswered")
  })

  it("firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.8 names every RuntimeAgentOutputObservation handling intention", () => {
    expect(acpEdgeOutputHandlingIntentions).toEqual({
      Ready: "no-op",
      TextChunk: "forward",
      ToolUse: "forward",
      PermissionRequest: "answer",
      TurnComplete: "terminal",
      Status: "no-op",
      Error: "terminal",
      Terminated: "terminal",
    })
  })

  it("tf-46i4 answers PermissionRequest observations through host.permissions.respond so ACP tool calls cannot deadlock silently", async () => {
    const harness = makeInMemoryAcpHarness()
    const contextId = `ctx-${crypto.randomUUID()}`
    const dispatched: Array<{ readonly target: string; readonly verb: string; readonly payload: unknown }> = []
    const layer = AcpStdioEdgeLive({
      input: harness.edgeInput,
      output: harness.edgeOutput,
      turnTimeoutMs: 1_000,
      // tf-l5px: the auto-allow stopgap is retained only behind explicit policy.
      // The {_tag:"Allow"} assertion below (no optionId) proves auto-grant, not
      // the forward path (which would carry the selected optionId).
      permissionPolicy: "allow",
      runtime: local.jsonl({
        argv: [globalThis.process.execPath, "-e", backingAgentProgram],
        agent: "host-sdk-acp-edge-test-agent",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
    }).pipe(
      Layer.provideMerge(
        Layer.succeed(HostPlaneChannelRouter, {
          descriptor: { routes: [], metadata: [] },
          metadata: [],
          route: target => Effect.fail(new UnknownChannelTarget({ target: String(target) })),
          dispatch: request =>
            Effect.sync(() => {
              dispatched.push({
                target: String(request.target),
                verb: request.verb,
                payload: request.payload,
              })
              switch (String(request.target)) {
                case String(HostSessionsCreateOrLoadChannelTarget):
                  return { contextId, sessionId: contextId }
                case String(SessionPromptChannelTarget):
                  return { accepted: true }
                case String(HostSessionsStartChannelTarget):
                  return { accepted: true }
                case String(HostPermissionRespondChannelTarget):
                  return { accepted: true }
                default:
                  throw new Error(`unexpected dispatch target ${String(request.target)}`)
              }
            }),
        } satisfies HostPlaneChannelRouter["Type"]),
      ),
      Layer.provideMerge(
        Layer.succeed(
          HostContextsChannel,
          makeIngressChannel({
            target: HostContextsChannelTarget,
            schema: RuntimeContextSchema,
            stream: Stream.make(fakeRuntimeContext(contextId)),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(SessionAgentOutputChannel, {
          forContext: () =>
            makeIngressChannel({
              target: SessionAgentOutputChannelTarget,
              schema: RuntimeAgentOutputObservationSchema,
              stream: Stream.make(
                permissionRequestOutput(contextId),
                turnCompleteOutput(contextId),
              ),
            }),
        } satisfies SessionAgentOutputChannel["Type"]),
      ),
    )

    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        yield* Layer.build(layer)
        const stream = acp.ndJsonStream(
          harness.clientOutput,
          harness.clientInput,
        )
        const connection = new acp.ClientSideConnection(
          () => makeClient([]),
          stream,
        )
        yield* Effect.promise(() =>
          connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          }))
        const session = yield* Effect.promise(() =>
          connection.newSession({
            cwd: globalThis.process.cwd(),
            mcpServers: [],
          }))
        const prompt = yield* Effect.promise(() =>
          connection.prompt({
            sessionId: session.sessionId,
            messageId: "host-sdk-acp-edge-permission",
            prompt: [{ type: "text", text: "run a tool" }],
          }))

        expect(prompt.stopReason).toBe("end_turn")
      }),
    ))

    expect(dispatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: String(HostPermissionRespondChannelTarget),
          verb: "call",
          payload: {
            contextId,
            permissionRequestId: "permission-test",
            decision: { _tag: "Allow" },
          },
        }),
      ]),
    )
  })

  it("tf-l5px forwards PermissionRequest to the ACP client and maps a selected allow option back through host.permissions.respond", async () => {
    const requested: Array<acp.RequestPermissionRequest> = []
    const client: acp.Client = {
      sessionUpdate: async () => {},
      requestPermission: async params => {
        requested.push(params)
        return { outcome: { outcome: "selected", optionId: params.options[0]!.optionId } }
      },
    }
    const result = await Effect.runPromise(runPermissionScenario({ client }))

    expect(result.stopReason).toBe("end_turn")
    // forwarded to the client with the tool + options (Zed's native UI)
    expect(requested).toHaveLength(1)
    expect(requested[0]?.toolCall.toolCallId).toBe("tool-test")
    expect(requested[0]?.options.map(option => option.optionId)).toEqual(["allow-once"])
    // human "allow" mapped back through host.permissions.respond
    expect(permissionDecision(result.dispatched)).toEqual({ _tag: "Allow", optionId: "allow-once" })
  })

  it("tf-l5px maps a selected reject option to a Deny decision", async () => {
    const rejectOutput = (contextId: string): RuntimeAgentOutputObservation =>
      Schema.decodeUnknownSync(RuntimeAgentOutputObservationSchema)({
        _tag: "PermissionRequest",
        source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
        sessionId: contextId,
        contextId,
        activityAttempt: 1,
        sequence: 0,
        permissionRequestId: "permission-test",
        toolUseId: "tool-test",
        options: [
          { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject-once", kind: "reject_once", name: "Reject" },
        ],
        event: {
          _tag: "PermissionRequest",
          permissionRequestId: "permission-test",
          toolUseId: "tool-test",
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject-once", kind: "reject_once", name: "Reject" },
          ],
        },
      })
    const client: acp.Client = {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "reject-once" } }),
    }
    const result = await Effect.runPromise(runPermissionScenario({ client, output: rejectOutput }))

    expect(permissionDecision(result.dispatched)).toEqual({ _tag: "Deny" })
  })

  it("tf-l5px maps a cancelled outcome to a Cancelled decision (ACP still owed a response)", async () => {
    const client: acp.Client = {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    }
    const result = await Effect.runPromise(runPermissionScenario({ client }))

    expect(result.stopReason).toBe("end_turn")
    expect(permissionDecision(result.dispatched)).toEqual({ _tag: "Cancelled" })
  })

  it("tf-l5px defaults to Cancelled when the client cannot answer, so ACP is never left hanging", async () => {
    const client: acp.Client = {
      sessionUpdate: async () => {},
      requestPermission: async () => {
        throw new Error("client has no permission surface")
      },
    }
    const result = await Effect.runPromise(runPermissionScenario({ client }))

    expect(permissionDecision(result.dispatched)).toEqual({ _tag: "Cancelled" })
  })

  it("tf-jvjm permissionPolicy:'deny' rejects without prompting the ACP client", async () => {
    let requested = 0
    const client: acp.Client = {
      sessionUpdate: async () => {},
      requestPermission: async () => {
        requested += 1
        return { outcome: { outcome: "selected", optionId: "allow-once" } }
      },
    }
    const result = await Effect.runPromise(
      runPermissionScenario({ client, permissionPolicy: "deny" }),
    )

    // "deny" answers without forwarding to the client's native UI.
    expect(requested).toBe(0)
    expect(permissionDecision(result.dispatched)).toEqual({ _tag: "Deny" })
  })

  // Wave D-A (PR #714) PARK — STALE LEGACY: this test exercises the legacy
  // workflow-body / mailbox / RuntimeInputIntentDispatcher path that the
  // D-A cutover removed from production composition. The Shape C
  // subscriber + RuntimeContextInputFacts is the new input route; this
  // test asserts the body-side trace/route shape that no longer fires.
  // Grep blocker for retirement (with the body in D-E):
  //   grep -rn "runtimeInputDeferred\|appendRuntimeInputDeferred" packages/runtime
  it.skip("firegrid-zed-acp-stdio-external-agent.VALIDATION.5 firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.6 firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.7 routes turns and traces ACP edge requests", async () => {
    const harness = makeInMemoryAcpHarness()
    const namespace = `acp-edge-${crypto.randomUUID()}`
    const updates: Array<acp.SessionNotification> = []
    const capturedSpans: Array<CapturedSpan> = []

    const layer = AcpStdioEdgeLive({
      input: harness.edgeInput,
      output: harness.edgeOutput,
      turnTimeoutMs: 10_000,
      runtime: ({ request }) =>
        local.jsonl({
          argv: [
            globalThis.process.execPath,
            "-e",
            backingAgentProgram,
          ],
          agent: "host-sdk-acp-edge-test-agent",
          agentProtocol: "stdio-jsonl",
          cwd: request.cwd,
        }),
    }).pipe(
      Layer.provideMerge(
        FiregridLocalHostLive({
          durableStreamsBaseUrl: baseUrl!,
          namespace,
          input: true,
        }).pipe(
          Layer.provide(FiregridLocalProcessFromEnv(globalThis.process.env)),
        ),
      ),
      Layer.provideMerge(capturingTracerLayer(capturedSpans)),
    )

    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        yield* Layer.build(layer)
        const stream = acp.ndJsonStream(
          harness.clientOutput,
          harness.clientInput,
        )
        const connection = new acp.ClientSideConnection(
          () => makeClient(updates),
          stream,
        )
        const initialized = yield* Effect.promise(() =>
          connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          }))
        const session = yield* Effect.promise(() =>
          connection.newSession({
            cwd: globalThis.process.cwd(),
            mcpServers: [],
          }))
        const first = yield* Effect.promise(() =>
          connection.prompt({
            sessionId: session.sessionId,
            messageId: "host-sdk-acp-edge-turn-1",
            prompt: [{ type: "text", text: "first turn" }],
          }))
        const second = yield* Effect.promise(() =>
          connection.prompt({
            sessionId: session.sessionId,
            messageId: "host-sdk-acp-edge-turn-2",
            prompt: [{ type: "text", text: "second turn" }],
          }))

        expect(initialized.protocolVersion).toBe(acp.PROTOCOL_VERSION)
        expect(first.stopReason).toBe("end_turn")
        expect(second.stopReason).toBe("end_turn")
        expect(session.sessionId).toMatch(/^acp_/)
      }),
    ))

    const texts = textFromUpdates(updates)
    expect(texts).toEqual([
      "host-sdk acp edge turn 1",
      "host-sdk acp edge turn 2",
    ])
    // tf-t7rb: the edge opens ONE long-lived SessionAgentOutput subscription per
    // turn, not one per output. Each backing turn emits status + text +
    // turn_complete (3 outputs); the prior runHead-per-output loop re-subscribed
    // ~once per output. The session_agent_output channel span fires once per
    // subscription, so two prompt turns => exactly two subscriptions.
    const outputSubscriptions = capturedSpans.filter(span =>
      span.name === "firegrid.host.channel.session_agent_output")
    expect(outputSubscriptions).toHaveLength(2)
    expect(capturedSpans.map(span => span.name)).toEqual(
      expect.arrayContaining([
        "firegrid.acp_stdio_edge.initialize",
        "firegrid.acp_stdio_edge.new_session",
        "firegrid.acp_stdio_edge.prompt",
      ]),
    )
    const promptSpans = capturedSpans.filter(span =>
      span.name === "firegrid.acp_stdio_edge.prompt")
    expect(promptSpans).toHaveLength(2)
    expect(promptSpans[0]?.attributes["firegrid.acid"]).toBe(
      "firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.7",
    )
  })

  // Wave D-A (PR #714) PARK — STALE LEGACY: see ACP_STDIO_EDGE.6/7 PARK
  // note above. Span-link assertion targets the legacy body's subprocess
  // span chain; retires with the body in D-E.
  it.skip("firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.9 links ACP edge prompt spans to subprocess byte spans", async () => {
    const harness = makeInMemoryAcpHarness()
    const namespace = `acp-edge-byte-link-${crypto.randomUUID()}`
    const updates: Array<acp.SessionNotification> = []
    const capturedSpans: Array<CapturedSpan> = []
    const promptId = "host-sdk-acp-edge-trace-link"

    const layer = AcpStdioEdgeLive({
      input: harness.edgeInput,
      output: harness.edgeOutput,
      turnTimeoutMs: 10_000,
      runtime: ({ request }) =>
        local.jsonl({
          argv: [
            globalThis.process.execPath,
            "--input-type=module",
            "-e",
            backingAcpAgentProgram,
          ],
          agent: "host-sdk-acp-edge-test-acp-agent",
          agentProtocol: "acp",
          cwd: request.cwd,
        }),
    }).pipe(
      Layer.provideMerge(
        FiregridLocalHostLive({
          durableStreamsBaseUrl: baseUrl!,
          namespace,
          input: true,
        }).pipe(
          Layer.provide(FiregridLocalProcessFromEnv(globalThis.process.env)),
        ),
      ),
      Layer.provideMerge(capturingTracerLayer(capturedSpans)),
    )

    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        yield* Layer.build(layer)
        const stream = acp.ndJsonStream(
          harness.clientOutput,
          harness.clientInput,
        )
        const connection = new acp.ClientSideConnection(
          () => makeClient(updates),
          stream,
        )
        yield* Effect.promise(() =>
          connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          }))
        const session = yield* Effect.promise(() =>
          connection.newSession({
            cwd: globalThis.process.cwd(),
            mcpServers: [],
          }))
        const response = yield* Effect.promise(() =>
          connection.prompt({
            sessionId: session.sessionId,
            messageId: promptId,
            prompt: [{ type: "text", text: "trace linkage" }],
          }))

        expect(response.stopReason).toBe("end_turn")
      }),
    ))

    const edgePromptSpan = capturedSpans.find(span =>
      span.name === "firegrid.acp_stdio_edge.prompt" &&
      span.attributes["firegrid.acp.client_prompt_id"] === promptId)
    const contextId = edgePromptSpan?.attributes["firegrid.context.id"]
    const turnId = edgePromptSpan?.attributes["firegrid.acp.turn_id"]
    expect(typeof contextId).toBe("string")
    expect(typeof turnId).toBe("string")
    expect(edgePromptSpan?.attributes["firegrid.acp.prompt_id"]).toBe(turnId)
    expect(edgePromptSpan?.attributes["firegrid.input.correlation_id"]).toBe(turnId)
    expect(textFromUpdates(updates)).toEqual([`linked:${String(turnId)}`])

    const codecPromptSpan = capturedSpans.find(span =>
      span.name === "firegrid.agent_event_pipeline.acp.prompt" &&
      span.attributes["firegrid.acp.prompt_id"] === turnId)
    expect(codecPromptSpan?.attributes["firegrid.input.correlation_id"]).toBe(turnId)

    const linkedByteSpans = capturedSpans.filter(span =>
      (
        span.name === "firegrid.agent_event_pipeline.source.local_process.stdin_bytes" ||
        span.name === "firegrid.agent_event_pipeline.source.local_process.stdout_bytes"
      ) &&
      span.attributes["firegrid.acp.prompt_id"] === turnId)
    expect(linkedByteSpans.map(span => span.name)).toEqual(
      expect.arrayContaining([
        "firegrid.agent_event_pipeline.source.local_process.stdin_bytes",
        "firegrid.agent_event_pipeline.source.local_process.stdout_bytes",
      ]),
    )
    expect(linkedByteSpans.every(span =>
      span.attributes["firegrid.context.id"] === contextId &&
      span.attributes["firegrid.acp.turn_id"] === turnId,
    )).toBe(true)
  }, 15_000)
})
