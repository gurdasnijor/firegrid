import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  appendRuntimeIngress,
  FiregridRuntimeHostLive,
  startRuntime,
} from "@firegrid/runtime"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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

const stdinEchoAgent = `
let buffered = ""
let count = 0
const keepAlive = setInterval(() => {}, 1000)
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffered += chunk
  while (buffered.includes("\\n")) {
    const index = buffered.indexOf("\\n")
    const line = buffered.slice(0, index).trim()
    buffered = buffered.slice(index + 1)
    if (line.length === 0) continue
    count += 1
    console.log(JSON.stringify({ type: "assistant", text: "ingress:" + line }))
    if (count >= 2) {
      clearInterval(keepAlive)
      setTimeout(() => process.exit(0), 10)
    }
  }
})
`

describe("firegrid tracer 012 runtime ingress", () => {
  it("firegrid-agent-ingress.INGRESS.1 firegrid-agent-ingress.INGRESS.2 firegrid-agent-ingress.INGRESS.3 firegrid-agent-ingress.INGRESS.4 firegrid-agent-ingress.INGRESS.5 firegrid-agent-ingress.DELIVERY.1 firegrid-agent-ingress.DELIVERY.2 firegrid-agent-ingress.DELIVERY.3 firegrid-agent-ingress.DELIVERY.4 firegrid-agent-ingress.HOST.1 firegrid-agent-ingress.HOST.2 firegrid-agent-ingress.HOST.3 firegrid-agent-ingress.SUBSCRIBERS.1 firegrid-agent-ingress.SUBSCRIBERS.2 firegrid-agent-ingress.SUBSCRIBERS.3 firegrid-agent-ingress.BOUNDARY.1 firegrid-agent-ingress.BOUNDARY.2 firegrid-agent-ingress.BOUNDARY.3 firegrid-agent-ingress.BOUNDARY.4 firegrid-agent-ingress.BOUNDARY.5 delivers durable ingress once to local process stdin and journals output", async () => {
    if (!baseUrl) throw new Error("scenario test server not started")
    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-012-${crypto.randomUUID()}`,
      hostId: `tracer-012-${crypto.randomUUID()}`,
    }

    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
    const hostLayer = FiregridRuntimeHostLive({
      ...firegridConfig,
      input: true,
    })
    const clientLayer = FiregridLive.pipe(
      Layer.provide(Layer.succeed(FiregridConfig, firegridConfig)),
    )

    const result = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", stdinEchoAgent],
          }),
        })

        const initial = yield* appendRuntimeIngress({
          contextId: handle.contextId,
          kind: "message",
          authoredBy: "client",
          payload: [{ type: "text", text: "start here" }],
          idempotencyKey: "tracer-012-initial",
          metadata: { source: "scenario", phase: "initial" },
        })
        const followUp = yield* appendRuntimeIngress({
          contextId: handle.contextId,
          kind: "message",
          authoredBy: "client",
          payload: [{ type: "text", text: "continue once" }],
          idempotencyKey: "tracer-012-continue",
          metadata: { source: "scenario" },
        })
        const duplicate = yield* appendRuntimeIngress({
          contextId: handle.contextId,
          kind: "message",
          authoredBy: "client",
          payload: [{ type: "text", text: "continue once duplicate" }],
          idempotencyKey: "tracer-012-continue",
        })

        const runResult = yield* startRuntime({ contextId: handle.contextId })
        const snapshot = yield* firegrid.open(handle.contextId).snapshot
        return { handle, initial, followUp, duplicate, runResult, snapshot }
      }).pipe(
        Effect.provide(clientLayer),
        Effect.provide(hostLayer),
      ),
    ))

    expect(result.duplicate.inputId).toBe(result.followUp.inputId)
    expect(result.runResult).toMatchObject({
      contextId: result.handle.contextId,
      exitCode: 0,
    })

    expect(result.snapshot.events.map(event => event.raw)).toEqual([
      "{\"type\":\"assistant\",\"text\":\"ingress:start here\"}",
      "{\"type\":\"assistant\",\"text\":\"ingress:continue once\"}",
    ])
    expect(result.initial.inputId).not.toEqual(result.followUp.inputId)
  })
})
