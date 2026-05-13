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

    const handle = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", childCode],
          }),
        })
      }),
    )

    const runtime = await Effect.runPromise(
      startRuntime({
        contextId: handle.contextId,
      }).pipe(
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.4
        // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1
        // The scenario provides only the production host root; sandbox wiring stays inside FiregridRuntimeHostLive.
        Effect.provide(FiregridRuntimeHostLive(firegridConfig)),
      ),
    )

    expect(runtime).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const snapshot = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }),
    )

    expect(snapshot.runs).toContainEqual(expect.objectContaining({
      contextId: handle.contextId,
      status: "exited",
      exitCode: 0,
      provider: "local-process",
    }))

    expect(snapshot.events).toContainEqual(expect.objectContaining({
      contextId: handle.contextId,
      source: "stdout",
      raw: "{\"type\":\"assistant\",\"text\":\"sandbox-slot-pong\"}",
    }))
    expect(snapshot.logs).toContainEqual(expect.objectContaining({
      contextId: handle.contextId,
      source: "stderr",
      raw: "diagnostic: sandbox-slot",
    }))
  })
})
