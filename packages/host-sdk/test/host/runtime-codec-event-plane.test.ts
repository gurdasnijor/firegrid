import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type RuntimeAgentProtocol,
  type RuntimeEventRow,
} from "@firegrid/protocol/launch"
import { RuntimeIngressTable } from "@firegrid/protocol/runtime-ingress"
import { Effect, Fiber, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  decodeRuntimeAgentOutputEnvelope,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import {
  FiregridRuntimeHostWithWorkflowLive,
  appendRuntimeIngress,
  startRuntime,
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

const seedContext = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly argv: ReadonlyArray<string>
  readonly agentProtocol?: RuntimeAgentProtocol
}): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      const contextId = `ctx_${crypto.randomUUID()}`
      const now = new Date().toISOString()
      yield* table.contexts.upsert({
        contextId,
        createdAt: now,
        runtime: normalizeRuntimeIntent(local.jsonl({
          argv: [...input.argv],
          ...(input.agentProtocol === undefined ? {} : { agentProtocol: input.agentProtocol }),
        })),
        host: {
          hostId: input.hostId,
          streamPrefix: makeHostStreamPrefix({
            namespace: input.namespace,
            hostId: input.hostId,
          }),
          boundAtMs: Date.now(),
        },
      })
      return contextId
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: runtimeControlPlaneStreamUrl({
            baseUrl: baseUrl!,
            namespace: input.namespace,
          }),
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ),
  )

const hostLayer = (input: {
  readonly namespace: string
  readonly hostId: HostId
}) =>
  FiregridRuntimeHostWithWorkflowLive({
    durableStreamsBaseUrl: baseUrl!,
    namespace: input.namespace,
    hostId: input.hostId,
    input: true,
  })

const outputTableLayer = (input: {
  readonly namespace: string
  readonly hostId: HostId
}) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: `${baseUrl!}/v1/stream/${makeHostStreamPrefix({
        namespace: input.namespace,
        hostId: input.hostId,
      })}.runtimeOutput`,
      contentType: "application/json",
    },
  })

const queryRawEvents = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  Effect.gen(function* () {
    const table = yield* RuntimeOutputTable
    return yield* table.events.query(coll =>
      coll.toArray
        .filter(row => row.contextId === input.contextId)
        .sort((left, right) => left.sequence - right.sequence))
  }).pipe(
    Effect.provide(outputTableLayer(input)),
    Effect.scoped,
  )

const decodeAgentEvent = (raw: string): AgentOutputEvent | undefined => {
  const decoded = decodeRuntimeAgentOutputEnvelope(raw)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const queryAgentEvents = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  queryRawEvents(input).pipe(
    Effect.map(rows => rows.flatMap(row => {
      const event = decodeAgentEvent(row.raw)
      return event === undefined ? [] : [event]
    })),
  )

const queryIngressInputs = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  Effect.gen(function* () {
    const table = yield* RuntimeIngressTable
    return yield* table.inputs.query(coll =>
      coll.toArray
        .filter(row => row.contextId === input.contextId)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)))
  }).pipe(
    Effect.provide(hostLayer(input)),
    Effect.scoped,
  )

const waitForAgentEvent = (
  table: RuntimeOutputTable["Type"],
  contextId: string,
  predicate: (event: AgentOutputEvent) => boolean,
): Effect.Effect<AgentOutputEvent, Error> => {
  const loop = (remaining: number): Effect.Effect<AgentOutputEvent, Error> =>
    Effect.gen(function* () {
      const rows: ReadonlyArray<RuntimeEventRow> = yield* table.events.query(coll =>
        coll.toArray
          .filter(row => row.contextId === contextId)
          .sort((left, right) => left.sequence - right.sequence))
      const found = rows
        .flatMap(row => {
          const event = decodeAgentEvent(row.raw)
          return event === undefined ? [] : [event]
        })
        .find(predicate)
      if (found !== undefined) return found
      if (remaining <= 0) {
        return yield* Effect.fail(new Error("timed out waiting for agent output event"))
      }
      yield* Effect.sleep("20 millis")
      return yield* loop(remaining - 1)
    })
  return loop(100)
}

const appendPrompt = (contextId: string, prompt: string) =>
  appendRuntimeIngress({
    contextId,
    kind: "message",
    authoredBy: "client",
    payload: prompt,
    idempotencyKey: `runtime-codec-test:${contextId}:prompt`,
  })

describe("Runtime Codec Event Plane", () => {
  it("firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1 preserves raw local-process journaling as the default path", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-raw-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
console.log(JSON.stringify({ type: "raw-probe", ok: true }))
`
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
    })

    const result = await Effect.runPromise(
      startRuntime({ contextId }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const rows = await Effect.runPromise(queryRawEvents({ namespace, hostId, contextId }))
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.raw)).toEqual({ type: "raw-probe", ok: true })
  })

  it("firegrid-runtime-agent-event-pipeline.STAGES.6 firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1 journals stdio-jsonl AgentOutputEvent rows and sends ToolResult back to the codec through authority surfaces", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-stdio-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin })
for await (const line of rl) {
  const message = JSON.parse(line)
  if (message.type === "prompt") {
    console.log(JSON.stringify({ type: "text", text: "prompt-received", messageId: "m1" }))
    console.log(JSON.stringify({ type: "tool_use", toolUseId: "tool-sleep", name: "sleep", input: { durationMs: "not-a-number" } }))
  }
  if (message.type === "tool_result") {
    console.log(JSON.stringify({ type: "text", text: "tool_result:" + String(message.isError), messageId: "m1" }))
    console.log(JSON.stringify({ type: "turn_complete", finishReason: "stop", messageId: "m1" }))
    process.exit(0)
  }
}
`
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      agentProtocol: "stdio-jsonl",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* appendPrompt(contextId, "start")
        return yield* startRuntime({ contextId })
      }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const events = await Effect.runPromise(queryAgentEvents({ namespace, hostId, contextId }))
    expect(events.map(event => event._tag)).toEqual(expect.arrayContaining([
      "Ready",
      "TextChunk",
      "ToolUse",
      "TurnComplete",
      "Terminated",
    ]))
    const toolResultChunk = events.find(event =>
      event._tag === "TextChunk" && event.part.delta === "tool_result:true",
    )
    expect(toolResultChunk).toBeDefined()
  }, 15_000)

  it("firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2 preserves schedule_me workflow registration through runtime host tool routing", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-schedule-me-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin })
for await (const line of rl) {
  const message = JSON.parse(line)
  if (message.type === "prompt") {
    console.log(JSON.stringify({
      type: "tool_use",
      toolUseId: "tool-schedule-me",
      name: "schedule_me",
      input: { when: 0, prompt: "scheduled follow-up" }
    }))
  }
  if (message.type === "tool_result") {
    console.log(JSON.stringify({ type: "text", text: "schedule_result:" + String(message.isError), messageId: "m1" }))
    console.log(JSON.stringify({ type: "turn_complete", finishReason: "stop", messageId: "m1" }))
    process.exit(0)
  }
}
`
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      agentProtocol: "stdio-jsonl",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* appendPrompt(contextId, "start")
        return yield* startRuntime({ contextId })
      }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const events = await Effect.runPromise(queryAgentEvents({ namespace, hostId, contextId }))
    expect(events).toContainEqual(expect.objectContaining({ _tag: "ToolUse" }))
    expect(events.find(event =>
      event._tag === "TextChunk" && event.part.delta === "schedule_result:false",
    )).toBeDefined()
  }, 15_000)

  it("firegrid-runtime-agent-event-pipeline.INGREDIENTS.6 commits Terminated before returning terminal exit evidence", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-missing-terminal-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
console.log(JSON.stringify({ type: "text", text: "before-terminal", messageId: "m1" }))
`
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      agentProtocol: "stdio-jsonl",
    })

    const result = await Effect.runPromise(
      startRuntime({ contextId }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const events = await Effect.runPromise(queryAgentEvents({ namespace, hostId, contextId }))
    expect(events).toContainEqual(expect.objectContaining({ _tag: "Ready" }))
    expect(events).toContainEqual(expect.objectContaining({ _tag: "TextChunk" }))
    expect(events.at(-1)).toMatchObject({ _tag: "Terminated", exitCode: 0 })

    const runs = await Effect.runPromise(Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      return yield* table.runs.query(coll =>
        coll.toArray
          .filter(row => row.contextId === contextId)
          .map(row => row.status),
      )
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: runtimeControlPlaneStreamUrl({
            baseUrl,
            namespace,
          }),
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))
    expect(runs).toEqual(expect.arrayContaining(["started", "exited"]))
  }, 15_000)

  it("firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1 journals ACP PermissionRequest and resumes it through RuntimeIngress PermissionResponse", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-acp-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
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
    return { sessionId: "session-1" }
  }
  async authenticate() {
    return {}
  }
  async prompt(params) {
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
    setTimeout(() => process.exit(0), 10)
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
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      agentProtocol: "acp",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* appendPrompt(contextId, "requires permission")
        const fiber = yield* startRuntime({ contextId }).pipe(Effect.fork)
        const outputTable = yield* RuntimeOutputTable
        const permission = yield* waitForAgentEvent(
          outputTable,
          contextId,
          event => event._tag === "PermissionRequest",
        )
        if (permission._tag !== "PermissionRequest") {
          return yield* Effect.fail(new Error("expected PermissionRequest"))
        }
        yield* appendRuntimeIngress({
          contextId,
          kind: "control",
          authoredBy: "client",
          payload: {
            _tag: "PermissionResponse",
            permissionRequestId: permission.permissionRequestId,
            decision: { _tag: "Allow", optionId: "allow" },
          },
          idempotencyKey: `runtime-codec-test:${contextId}:permission-response`,
        })
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const events = await Effect.runPromise(queryAgentEvents({ namespace, hostId, contextId }))
    const permissionEvent = events.find(event =>
      event._tag === "PermissionRequest" && event.toolUseId === "tool-permission",
    )
    expect(permissionEvent).toBeDefined()
    if (permissionEvent === undefined || permissionEvent._tag !== "PermissionRequest") {
      throw new Error("expected PermissionRequest")
    }
    expect(permissionEvent.permissionRequestId).toMatch(/^permission_id_[0-9A-Za-z]{16}$/)
    const selectedChunk = events.find(event =>
      event._tag === "TextChunk" && event.part.delta === "selected",
    )
    expect(selectedChunk).toBeDefined()
    expect(events.filter(event => event._tag === "Error")).toEqual([])
    expect(events.some(event => event._tag === "Terminated")).toBe(true)
  })

  it("firegrid-runtime-agent-event-pipeline.STAGES.6 firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.7 journals ACP tool_call observations without routing them to agent-tool lowering", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-acp-tool-observation-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
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
    return { sessionId: "session-1" }
  }
  async authenticate() {
    return {}
  }
  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "acp-tool-observation",
        title: "sleep",
        kind: "read",
        status: "pending",
        rawInput: { durationMs: 1 },
      },
    })
    setTimeout(() => process.exit(0), 10)
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
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      agentProtocol: "acp",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* appendPrompt(contextId, "observe tool")
        return yield* startRuntime({ contextId })
      }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const events = await Effect.runPromise(queryAgentEvents({ namespace, hostId, contextId }))
    const observedToolUse = events.find(event =>
      event._tag === "ToolUse" &&
      event.part.id === "acp-tool-observation" &&
      event.part.name === "sleep",
    )
    expect(observedToolUse).toBeDefined()

    const inputs = await Effect.runPromise(queryIngressInputs({ namespace, hostId, contextId }))
    expect(inputs.some(row => row.kind === "tool_result" && row.authoredBy === "tool")).toBe(false)
  })
})
