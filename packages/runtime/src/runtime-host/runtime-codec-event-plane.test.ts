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
import { Effect, Fiber, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AgentOutputEventSchema,
  type AgentOutputEvent,
} from "../agent-io/index.ts"
import {
  FiregridRuntimeHostWithWorkflowLive,
  appendRuntimeIngress,
  startRuntime,
} from "./index.ts"

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

const ingressTableLayer = (input: {
  readonly namespace: string
  readonly hostId: HostId
}) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: `${baseUrl!}/v1/stream/${makeHostStreamPrefix({
        namespace: input.namespace,
        hostId: input.hostId,
      })}.runtimeIngress`,
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
  const decoded = Schema.decodeUnknownEither(AgentOutputEventSchema)(
    (JSON.parse(raw) as { readonly event?: unknown }).event,
  )
  return decoded._tag === "Right" ? decoded.right : undefined
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

const appendPrompt = (
  contextId: string,
  prompt: string,
  idempotencyKey = `runtime-codec-test:${contextId}:prompt`,
) =>
  appendRuntimeIngress({
    contextId,
    kind: "message",
    authoredBy: "client",
    payload: prompt,
    idempotencyKey,
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

  it("firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1 journals stdio-jsonl AgentOutputEvent rows and sends ToolResult back to the codec", async () => {
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

  it("firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1 firegrid-dark-factory-app.PLATFORM_PRIMITIVES.2 firegrid-dark-factory-app.SESSION_TOOLS.2 keeps one RuntimeContext alive for two RuntimeIngress turns and journals stateful output", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-multiturn-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin })
const prompts = []
const findText = (value) => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findText(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value === "object" && value !== null) {
    if (typeof value.text === "string") return value.text
    if ("content" in value) {
      const found = findText(value.content)
      if (found !== undefined) return found
    }
    for (const item of Object.values(value)) {
      const found = findText(item)
      if (found !== undefined) return found
    }
  }
  return undefined
}

for await (const line of rl) {
  const message = JSON.parse(line)
  if (message.type !== "prompt") continue
  const prompt = findText(message.prompt) ?? "<missing prompt>"
  prompts.push(prompt)
  if (prompts.length === 1) {
    console.log(JSON.stringify({ type: "text", text: "turn1 accepted " + prompt, messageId: "turn-1" }))
    console.log(JSON.stringify({ type: "turn_complete", finishReason: "stop", messageId: "turn-1" }))
    continue
  }
  console.log(JSON.stringify({ type: "text", text: "turn2 saw prior=" + prompts[0] + "; current=" + prompt, messageId: "turn-2" }))
  console.log(JSON.stringify({ type: "turn_complete", finishReason: "stop", messageId: "turn-2" }))
  process.exit(0)
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
        yield* appendPrompt(
          contextId,
          "alpha-turn-one",
          `runtime-codec-test:${contextId}:prompt-1`,
        )
        const runtimeFiber = yield* startRuntime({ contextId }).pipe(Effect.fork)
        const outputTable = yield* RuntimeOutputTable
        const turnOne = yield* waitForAgentEvent(
          outputTable,
          contextId,
          event =>
            event._tag === "TextChunk" &&
            event.part.delta === "turn1 accepted alpha-turn-one",
        )
        expect(turnOne).toMatchObject({ _tag: "TextChunk" })
        yield* appendPrompt(
          contextId,
          "beta-turn-two",
          `runtime-codec-test:${contextId}:prompt-2`,
        )
        return yield* Fiber.join(runtimeFiber)
      }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })

    const retained = await Effect.runPromise(Effect.gen(function* () {
      const output = yield* RuntimeOutputTable
      const ingress = yield* RuntimeIngressTable
      const events = yield* output.events.query(coll =>
        coll.toArray
          .filter(row => row.contextId === contextId)
          .sort((left, right) => left.sequence - right.sequence))
      const inputs = yield* ingress.inputs.query(coll =>
        coll.toArray
          .filter(row => row.contextId === contextId)
          .sort((left, right) =>
            (left.sequence ?? Number.MAX_SAFE_INTEGER) -
              (right.sequence ?? Number.MAX_SAFE_INTEGER)))
      return { events, inputs }
    }).pipe(
      Effect.provide(outputTableLayer({ namespace, hostId })),
      Effect.provide(ingressTableLayer({ namespace, hostId })),
      Effect.scoped,
    ))

    expect(retained.inputs).toEqual([
      expect.objectContaining({
        contextId,
        status: "sequenced",
        sequence: 0,
        payload: "alpha-turn-one",
        idempotencyKey: `runtime-codec-test:${contextId}:prompt-1`,
      }),
      expect.objectContaining({
        contextId,
        status: "sequenced",
        sequence: 1,
        payload: "beta-turn-two",
        idempotencyKey: `runtime-codec-test:${contextId}:prompt-2`,
      }),
    ])

    const events = retained.events.flatMap(row => {
      const event = decodeAgentEvent(row.raw)
      return event === undefined ? [] : [event]
    })
    const textDeltas = events.flatMap(event =>
      event._tag === "TextChunk" ? [event.part.delta] : [],
    )
    expect(textDeltas).toEqual(expect.arrayContaining([
      "turn1 accepted alpha-turn-one",
      "turn2 saw prior=alpha-turn-one; current=beta-turn-two",
    ]))
    expect(events.some(event => event._tag === "Terminated")).toBe(true)
    expect(events.filter(event => event._tag === "TurnComplete")).toHaveLength(2)
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
    expect(events).toContainEqual(expect.objectContaining({
      _tag: "PermissionRequest",
      permissionRequestId: "permission-1",
      toolUseId: "tool-permission",
    }))
    const selectedChunk = events.find(event =>
      event._tag === "TextChunk" && event.part.delta === "selected",
    )
    expect(selectedChunk).toBeDefined()
    expect(events.some(event => event._tag === "Terminated")).toBe(true)
  })
})
