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

describe("ACP stdio edge", () => {
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

  it("firegrid-zed-acp-stdio-external-agent.VALIDATION.5 firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.6 firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.7 routes turns and traces ACP edge requests", async () => {
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
})
