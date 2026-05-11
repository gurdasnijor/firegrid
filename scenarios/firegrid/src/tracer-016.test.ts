import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
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

let server: DurableStreamsTestServerHandle | undefined

beforeEach(async () => {
  server = await startDurableStreamsTestServer()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("durable streams test server not started")
  return server.createStreamUrl(name)
}

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
    const controlPlaneStreamUrl = await createStreamUrl("tracer-016-runtime-control")
    const dataPlaneStreamUrl = await createStreamUrl("tracer-016-runtime-output")
    const workflowStreamUrl = await createStreamUrl("tracer-016-workflow")
    const inputStreamUrl = await createStreamUrl("tracer-016-runtime-ingress")

    const handle = await Effect.runPromise(
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
              runtimeStreamUrl: controlPlaneStreamUrl,
              controlPlaneStreamUrl,
              dataPlaneStreamUrl,
              inputStreamUrl,
            })),
          ),
        ),
      ),
    )

    const host = FiregridRuntimeHostLive({
      streams: {
        workflow: workflowStreamUrl,
        controlPlane: controlPlaneStreamUrl,
        runtimeOutput: dataPlaneStreamUrl,
        runtimeIngress: inputStreamUrl,
      },
    })

    const runtime = Effect.runPromise(
      startRuntime({ contextId: handle.contextId }).pipe(
        Effect.provide(host),
      ),
    )

    await waitFor(async () => {
      const snapshot = await Effect.runPromise(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          return yield* firegrid.open(handle.contextId).snapshot
        }).pipe(
          Effect.provide(
            FiregridLive.pipe(
              Layer.provide(Layer.succeed(FiregridConfig, {
                runtimeStreamUrl: controlPlaneStreamUrl,
                controlPlaneStreamUrl,
                dataPlaneStreamUrl,
                inputStreamUrl,
              })),
            ),
          ),
        ),
      )
      return snapshot.status === "started"
    })

    const prompt = await Effect.runPromise(
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
              runtimeStreamUrl: controlPlaneStreamUrl,
              controlPlaneStreamUrl,
              dataPlaneStreamUrl,
              inputStreamUrl,
            })),
          ),
        ),
      ),
    )

    expect(prompt.duplicate.ingressId).toEqual(prompt.first.ingressId)

    const result = await runtime
    expect(result).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }).pipe(
        Effect.provide(
          FiregridLive.pipe(
            Layer.provide(Layer.succeed(FiregridConfig, {
              runtimeStreamUrl: controlPlaneStreamUrl,
              controlPlaneStreamUrl,
              dataPlaneStreamUrl,
              inputStreamUrl,
            })),
          ),
        ),
      ),
    )

    expect(snapshot.events.map(event => event.raw)).toEqual([
      "{\"type\":\"assistant\",\"text\":\"input:continue live\"}",
    ])
  })
})
