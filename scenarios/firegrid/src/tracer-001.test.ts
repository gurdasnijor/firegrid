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

describe("firegrid tracer scenarios", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10 starts from public launch and journals retained runtime events/logs", async () => {
    if (!baseUrl) throw new Error("scenario test server not started")
    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
    //
    // Host identity is explicit at the programmatic test-composition
    // boundary: the runtime host requires options.hostId, and there
    // is no env/fs fallback. Slice 3 introduces host-mediated launch
    // authority that obviates this scenario-level wiring.
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-001-${crypto.randomUUID()}`,
      hostId: `tracer-001-${crypto.randomUUID()}`,
    }
    const childCode = `
console.log(JSON.stringify({ type: "assistant", text: "pong" }))
console.error("diagnostic: client-to-runtime")
`

    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
    // firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
    //
    // The runtime host layer provides `CurrentHostSession` to the
    // launch path so the launched RuntimeContext.host binding names
    // the host scope that will execute the workflow. One layer
    // instance, one scope: launch / startRuntime / snapshot share
    // the same host session.
    const hostLayer = FiregridRuntimeHostLive(firegridConfig)
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

    expect(result.snapshot.events).toContainEqual(expect.objectContaining({
      contextId: result.handle.contextId,
      source: "stdout",
      raw: "{\"type\":\"assistant\",\"text\":\"pong\"}",
    }))
    expect(result.snapshot.logs).toContainEqual(expect.objectContaining({
      contextId: result.handle.contextId,
      source: "stderr",
      raw: "diagnostic: client-to-runtime",
    }))
  })
})
