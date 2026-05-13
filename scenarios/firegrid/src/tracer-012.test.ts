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

const runWithFiregrid = <A, E>(
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
  },
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> => {
  return Effect.runPromise(Effect.scoped(
    effect.pipe(
      Effect.provide(
        FiregridLive.pipe(
          Layer.provide(Layer.succeed(FiregridConfig, {
            durableStreamsBaseUrl: options.durableStreamsBaseUrl,
            namespace: options.namespace,
          })),
        ),
      ),
    ),
  ))
}

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
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-012-${crypto.randomUUID()}`,
    }

    const handle = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", stdinEchoAgent],
          }),
        })
      }),
    )

    const host = FiregridRuntimeHostLive({
      ...firegridConfig,
      input: true,
    })

    const initial = await Effect.runPromise(
      appendRuntimeIngress({
        contextId: handle.contextId,
        kind: "message",
        authoredBy: "client",
        payload: [{ type: "text", text: "start here" }],
        idempotencyKey: "tracer-012-initial",
        metadata: { source: "scenario", phase: "initial" },
      }).pipe(Effect.provide(host)),
    )
    const followUp = await Effect.runPromise(
      appendRuntimeIngress({
        contextId: handle.contextId,
        kind: "message",
        authoredBy: "client",
        payload: [{ type: "text", text: "continue once" }],
        idempotencyKey: "tracer-012-continue",
        metadata: { source: "scenario" },
      }).pipe(Effect.provide(host)),
    )
    const duplicate = await Effect.runPromise(
      appendRuntimeIngress({
        contextId: handle.contextId,
        kind: "message",
        authoredBy: "client",
        payload: [{ type: "text", text: "continue once duplicate" }],
        idempotencyKey: "tracer-012-continue",
      }).pipe(Effect.provide(host)),
    )

    expect(duplicate.inputId).toBe(followUp.inputId)

    const result = await Effect.runPromise(
      startRuntime({
        contextId: handle.contextId,
      }).pipe(Effect.provide(host)),
    )

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
      "{\"type\":\"assistant\",\"text\":\"ingress:start here\"}",
      "{\"type\":\"assistant\",\"text\":\"ingress:continue once\"}",
    ])
    expect(initial.inputId).not.toEqual(followUp.inputId)
  })
})
