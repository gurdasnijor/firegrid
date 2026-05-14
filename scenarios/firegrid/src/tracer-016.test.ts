import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import {
  FiregridRuntimeHostLive,
  startRuntime,
} from "@firegrid/runtime"
import { Duration, Effect, Fiber, Layer } from "effect"
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

const liveStdinEchoAgent = `
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
    console.log(JSON.stringify({ type: "assistant", text: "input:" + line }))
    if (count >= 1) {
      clearInterval(keepAlive)
      setTimeout(() => process.exit(0), 10)
    }
  }
})
`

describe("firegrid tracer 016 session-plane input control surface", () => {
  it("firegrid-agent-ingress.INGRESS.6 firegrid-agent-ingress.INGRESS.7 firegrid-agent-ingress.DELIVERY.5 firegrid-agent-ingress.HOST.4 appends prompt facts and host-owned runtime loop delivers live input once", async () => {
    if (!baseUrl) throw new Error("durable streams test server not started")
    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-016-${crypto.randomUUID()}`,
      hostId: `tracer-016-${crypto.randomUUID()}`,
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
            argv: [process.execPath, "--input-type=module", "-e", liveStdinEchoAgent],
          }),
        })

        // Fork the runtime so we can interact with it while it's
        // alive (poll snapshot, send live prompt).
        const runtimeFiber = yield* Effect.fork(
          startRuntime({ contextId: handle.contextId }),
        )

        const waitForStarted = Effect.gen(function* () {
          for (let index = 0; index < 100; index += 1) {
            const snapshot = yield* firegrid.open(handle.contextId).snapshot
            if (snapshot.status === "started") return
            yield* Effect.sleep(Duration.millis(25))
          }
          return yield* Effect.die(new Error("timed out waiting for runtime started"))
        })
        yield* waitForStarted

        const first = yield* firegrid.prompt({
          contextId: handle.contextId,
          payload: [{ type: "text", text: "continue live" }],
          idempotencyKey: "tracer-016-live-input",
        })
        const duplicate = yield* firegrid.prompt({
          contextId: handle.contextId,
          payload: [{ type: "text", text: "continue live duplicate" }],
          idempotencyKey: "tracer-016-live-input",
        })

        const runResult = yield* Fiber.join(runtimeFiber)
        const snapshot = yield* firegrid.open(handle.contextId).snapshot
        return { handle, first, duplicate, runResult, snapshot }
      }).pipe(
        Effect.provide(clientLayer),
        Effect.provide(hostLayer),
      ),
    ))

    expect(result.duplicate.inputId).toEqual(result.first.inputId)
    expect(result.runResult).toMatchObject({
      contextId: result.handle.contextId,
      exitCode: 0,
    })

    expect(result.snapshot.events.map(event => event.raw)).toEqual([
      "{\"type\":\"assistant\",\"text\":\"input:continue live\"}",
    ])
  })
})
