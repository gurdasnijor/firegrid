import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  runtimeLaunchStateSchema,
  type PublicLaunchRequest,
} from "@firegrid/protocol/launch"
import { createStreamDB } from "@durable-streams/state"
import { Effect, Either, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "./index.ts"

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

describe("@firegrid/client", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7 appends normalized launch requests without caller ids or stream wiring", async () => {
    const launchStreamUrl = await createStreamUrl("launch")

    const handle = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: {
            provider: "local-process",
            config: {
              argv: ["node", "--version"],
              env: {
                ANTHROPIC_API_KEY: "must-not-persist",
              },
            },
            journal: [
              { source: "stdout", format: "text-lines", stream: "diagnostics" },
            ],
          },
        } as unknown as PublicLaunchRequest)
      }),
    )

    expect(handle.launchId).toMatch(/^launch_/)

    const db = createStreamDB({
      streamOptions: {
        url: launchStreamUrl,
        contentType: "application/json",
      },
      state: runtimeLaunchStateSchema,
    })
    await db.preload()
    try {
      const request = db.collections.launchRequests.get(handle.launchId)
      expect(request).toMatchObject({
        launchId: handle.launchId,
        runtime: {
          provider: "local-process",
          config: {
            argv: ["node", "--version"],
          },
        },
      })
      expect("env" in (request?.runtime.config ?? {})).toBe(false)
      expect(request?.runtime.journal).toContainEqual({
        source: "stdout",
        format: "jsonl",
        stream: "provider-wire",
      })
    } finally {
      db.close()
    }
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.1 firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.5 exposes durable snapshots without live process authority", async () => {
    const launchStreamUrl = await createStreamUrl("launch")
    const snapshot = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch({
          runtime: local.jsonl({
            argv: ["node", "--version"],
          }),
        })
        return yield* handle.snapshot
      }),
    )

    expect(snapshot.request?.runtime.provider).toEqual("local-process")
    expect(snapshot.runtimeProcesses).toEqual([])
    expect(snapshot.providerWire).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.5 exposes launch lifecycle changes as a Stream", async () => {
    const launchStreamUrl = await createStreamUrl("launch")

    const snapshots = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch({
          runtime: local.jsonl({
            argv: ["node", "--version"],
          }),
        })
        return yield* handle.changes.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(chunk => Array.from(chunk)),
        )
      }),
    )

    expect(snapshots[0]?.request?.runtime.config.argv).toEqual(["node", "--version"])
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects malformed public launch input at the client boundary", async () => {
    const launchStreamUrl = await createStreamUrl("launch")

    const result = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* Effect.either(firegrid.launch({
          runtime: {
            provider: "remote-provider",
            config: {
              argv: "node --version",
            },
          },
        } as unknown as PublicLaunchRequest))
      }),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "LaunchInputError",
      })
    }
  })
})
