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

const waitFor = async (
  check: () => Promise<boolean>,
): Promise<void> => {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error("timed out waiting for runtime state")
}

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
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-016-${crypto.randomUUID()}`,
    }

    const handle = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", liveStdinEchoAgent],
          }),
        })
      }).pipe(
        Effect.provide(
          FiregridLive.pipe(
            Layer.provide(Layer.succeed(FiregridConfig, {
              ...firegridConfig,
            })),
          ),
        ),
      ),
    ))

    const host = FiregridRuntimeHostLive({
      ...firegridConfig,
      input: true,
    })

    const runtime = Effect.runPromise(
      startRuntime({ contextId: handle.contextId }).pipe(
        Effect.provide(host),
      ),
    )

    await waitFor(async () => {
      const snapshot = await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          return yield* firegrid.open(handle.contextId).snapshot
        }).pipe(
          Effect.provide(
            FiregridLive.pipe(
              Layer.provide(Layer.succeed(FiregridConfig, {
                ...firegridConfig,
              })),
            ),
          ),
        ),
      ))
      return snapshot.status === "started"
    })

    const prompt = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
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
        return { first, duplicate }
      }).pipe(
        Effect.provide(
          FiregridLive.pipe(
            Layer.provide(Layer.succeed(FiregridConfig, {
              ...firegridConfig,
            })),
          ),
        ),
      ),
    ))

    expect(prompt.duplicate.inputId).toEqual(prompt.first.inputId)

    const result = await runtime
    expect(result).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const snapshot = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }).pipe(
        Effect.provide(
          FiregridLive.pipe(
            Layer.provide(Layer.succeed(FiregridConfig, {
              ...firegridConfig,
            })),
          ),
        ),
      ),
    ))

    expect(snapshot.events.map(event => event.raw)).toEqual([
      "{\"type\":\"assistant\",\"text\":\"input:continue live\"}",
    ])
  })
})
