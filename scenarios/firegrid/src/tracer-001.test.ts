import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { NodeContext } from "@effect/platform-node"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import {
  LocalProcessSandboxProviderLive,
  runLaunchOnce,
} from "@firegrid/runtime/launch"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let server: DurableStreamTestServer | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("server not started")
  const streamUrl = `${server.url}/v1/stream/${name}-${crypto.randomUUID()}`
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

const runWithFiregrid = <A, E>(
  launchStreamUrl: string,
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FiregridLive.pipe(
          Layer.provide(Layer.succeed(FiregridConfig, { launchStreamUrl })),
        ),
      ),
    ),
  )

describe("firegrid tracer scenarios", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10 starts from public launch and journals retained provider rows", async () => {
    const launchStreamUrl = await createStreamUrl("launch")
    const workflowStreamUrl = await createStreamUrl("workflow")
    const childCode = `
console.log(JSON.stringify({ type: "assistant", text: "pong" }))
console.error("diagnostic: client-to-runtime")
`

    const handle = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", childCode],
          }),
        })
      }),
    )

    const result = await Effect.runPromise(
      runLaunchOnce({
        launchStreamUrl,
        workflowStreamUrl,
        launchId: handle.launchId,
      }).pipe(
        Effect.provide(Layer.mergeAll(
          LocalProcessSandboxProviderLive,
          NodeContext.layer,
        )),
      ),
    )

    expect(result).toMatchObject({
      launchId: handle.launchId,
      exitCode: 0,
    })

    const snapshot = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.launchId).snapshot
      }),
    )

    expect(snapshot.providerWire).toContainEqual(expect.objectContaining({
      launchId: handle.launchId,
      channel: "stdout",
      stream: "provider-wire",
      parseStatus: "valid-json",
      raw: "{\"type\":\"assistant\",\"text\":\"pong\"}",
    }))
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      launchId: handle.launchId,
      channel: "stderr",
      stream: "diagnostics",
      raw: "diagnostic: client-to-runtime",
    }))
  })
})
