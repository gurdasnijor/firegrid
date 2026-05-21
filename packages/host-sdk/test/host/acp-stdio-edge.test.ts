import * as acp from "@agentclientprotocol/sdk"
import { DurableStreamTestServer } from "@durable-streams/server"
import { local } from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
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

describe("ACP stdio edge", () => {
  it("firegrid-zed-acp-stdio-external-agent.VALIDATION.5 routes newSession and prompt through the host edge", async () => {
    const harness = makeInMemoryAcpHarness()
    const namespace = `acp-edge-${crypto.randomUUID()}`
    const updates: Array<acp.SessionNotification> = []

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
  })
})
