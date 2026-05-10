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
  if (!server) throw new Error("server not started")
  return server.createStreamUrl(name)
}

const runWithFiregrid = <A, E>(
  options: {
    readonly controlPlaneStreamUrl: string
    readonly dataPlaneStreamUrl: string
  },
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FiregridLive.pipe(
          Layer.provide(Layer.succeed(FiregridConfig, {
            runtimeStreamUrl: options.controlPlaneStreamUrl,
            controlPlaneStreamUrl: options.controlPlaneStreamUrl,
            dataPlaneStreamUrl: options.dataPlaneStreamUrl,
          })),
        ),
      ),
    ),
  )

describe("firegrid tracer scenarios", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10 starts from public launch and journals retained runtime events/logs", async () => {
    const controlPlaneStreamUrl = await createStreamUrl("runtime-control")
    const dataPlaneStreamUrl = await createStreamUrl("runtime-data")
    const workflowStreamUrl = await createStreamUrl("workflow")
    const childCode = `
console.log(JSON.stringify({ type: "assistant", text: "pong" }))
console.error("diagnostic: client-to-runtime")
`

    const handle = await runWithFiregrid(
      { controlPlaneStreamUrl, dataPlaneStreamUrl },
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
      startRuntime({
        contextId: handle.contextId,
      }).pipe(
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.4
        Effect.provide(FiregridRuntimeHostLive({
          streams: {
            workflow: workflowStreamUrl,
            controlPlane: controlPlaneStreamUrl,
            runtimeOutput: dataPlaneStreamUrl,
          },
        })),
      ),
    )

    expect(result).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const snapshot = await runWithFiregrid(
      { controlPlaneStreamUrl, dataPlaneStreamUrl },
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }),
    )

    expect(snapshot.events).toContainEqual(expect.objectContaining({
      contextId: handle.contextId,
      source: "stdout",
      raw: "{\"type\":\"assistant\",\"text\":\"pong\"}",
    }))
    expect(snapshot.logs).toContainEqual(expect.objectContaining({
      contextId: handle.contextId,
      source: "stderr",
      raw: "diagnostic: client-to-runtime",
    }))
  })
})
