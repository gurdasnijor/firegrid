import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  type PublicLaunchRequest,
} from "@firegrid/protocol/launch"
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
  runtimeStreamUrl: string,
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FiregridLive.pipe(
          Layer.provide(Layer.succeed(FiregridConfig, { runtimeStreamUrl })),
        ),
      ),
    ),
  )

describe("@firegrid/client", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7 appends normalized runtime contexts without caller ids or stream wiring", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")

    const handle = await runWithFiregrid(
      runtimeStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: ["node", "--version"],
          }),
        })
      }),
    )

    expect(handle.contextId).toMatch(/^ctx_/)

    const snapshot = await runWithFiregrid(
      runtimeStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }),
    )
    expect(snapshot.context).toMatchObject({
      contextId: handle.contextId,
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
        },
      },
    })
    expect(snapshot.context?.runtime.journal).toContainEqual({
      source: "stdout",
      format: "jsonl",
      target: "events",
    })
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.1 firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.5 exposes durable snapshots without live process authority", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")
    const snapshot = await runWithFiregrid(
      runtimeStreamUrl,
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

    expect(snapshot.context?.runtime.provider).toEqual("local-process")
    expect(snapshot.runs).toEqual([])
    expect(snapshot.events).toEqual([])
    expect(snapshot.logs).toEqual([])
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.5 exposes runtime context changes as a Stream", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")

    const snapshots = await runWithFiregrid(
      runtimeStreamUrl,
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

    expect(snapshots[0]?.context?.runtime.config.argv).toEqual(["node", "--version"])
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects malformed public launch input at the client boundary", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")
    const request: unknown = {
      runtime: {
        provider: "remote-provider",
        config: {
          argv: "node --version",
        },
      },
    }

    const result = await runWithFiregrid(
      runtimeStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* Effect.either(firegrid.launch(request as PublicLaunchRequest))
      }),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "LaunchInputError",
      })
    }
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects public launch input with raw env or journal fields", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")
    const request: unknown = {
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
          env: {
            ANTHROPIC_API_KEY: "must-not-persist",
          },
        },
        journal: [
          { source: "stdout", format: "text-lines", target: "logs" },
        ],
      },
    }

    const result = await runWithFiregrid(
      runtimeStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* Effect.either(firegrid.launch(request as PublicLaunchRequest))
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
