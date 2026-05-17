import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client-sdk"
import {
  FiregridLocalHostLive,
  startRuntime,
} from "@firegrid/host-sdk"
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

describe("firegrid tracer 007 sandbox slot extraction", () => {
  it("firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1 firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.3 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.5 journals stdout stderr and exit through FiregridRuntimeHostLive", async () => {
    if (!baseUrl) throw new Error("scenario test server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-007-${crypto.randomUUID()}`,
    }
    const childCode = `
console.log(JSON.stringify({ type: "assistant", text: "sandbox-slot-pong" }))
console.error("diagnostic: sandbox-slot")
`

    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
    const hostLayer = FiregridLocalHostLive(firegridConfig)
    const clientLayer = FiregridLive.pipe(
      Layer.provide(Layer.succeed(FiregridConfig, firegridConfig)),
    )

    const result = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", childCode],
          }),
        })
        const runResult = yield* startRuntime({ contextId: handle.contextId })
        const snapshot = yield* firegrid.open(handle.contextId).snapshot
        return { handle, runResult, snapshot }
      }).pipe(
        Effect.provide(clientLayer),
        Effect.provide(hostLayer),
      ),
    ))

    expect(result.runResult).toMatchObject({
      contextId: result.handle.contextId,
      exitCode: 0,
    })

    expect(result.snapshot.runs).toContainEqual(expect.objectContaining({
      contextId: result.handle.contextId,
      status: "exited",
      exitCode: 0,
      provider: "local-process",
    }))

    expect(result.snapshot.events).toContainEqual(expect.objectContaining({
      contextId: result.handle.contextId,
      source: "stdout",
      raw: "{\"type\":\"assistant\",\"text\":\"sandbox-slot-pong\"}",
    }))
    expect(result.snapshot.logs).toContainEqual(expect.objectContaining({
      contextId: result.handle.contextId,
      source: "stderr",
      raw: "diagnostic: sandbox-slot",
    }))
  })
})
