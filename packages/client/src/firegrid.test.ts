import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { RuntimeLaunchRequest } from "@firegrid/protocol/launch"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
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
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 appends launch requests without importing runtime", async () => {
    const launchStreamUrl = await createStreamUrl("launch")
    const providerWireStreamUrl = await createStreamUrl("provider-wire")
    const launch: RuntimeLaunchRequest = {
      launchId: `launch-${crypto.randomUUID()}`,
      requestedAt: new Date().toISOString(),
      target: {
        kind: "command",
        spec: {
          argv: ["node", "--version"],
        },
      },
      planes: {
        session: {
          "provider-wire": {
            kind: "stream",
            role: "events",
            streamUrl: providerWireStreamUrl,
          },
        },
      },
    }

    const snapshot = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch(launch)
        return yield* handle.snapshot
      }),
    )

    expect(snapshot.request?.launchId).toEqual(launch.launchId)
    expect(snapshot.runtimeProcesses).toEqual([])
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.2 exposes launch lifecycle changes as a Stream", async () => {
    const launchStreamUrl = await createStreamUrl("launch")
    const providerWireStreamUrl = await createStreamUrl("provider-wire")
    const launch: RuntimeLaunchRequest = {
      launchId: `launch-${crypto.randomUUID()}`,
      requestedAt: new Date().toISOString(),
      target: {
        kind: "command",
        spec: {
          argv: ["node", "--version"],
        },
      },
      planes: {
        session: {
          "provider-wire": {
            kind: "stream",
            role: "events",
            streamUrl: providerWireStreamUrl,
          },
        },
      },
    }

    const snapshots = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch(launch)
        return yield* handle.changes.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(chunk => Array.from(chunk)),
        )
      }),
    )

    expect(snapshots[0]?.request?.launchId).toEqual(launch.launchId)
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.3 exposes raw streams as diagnostic access", async () => {
    const launchStreamUrl = await createStreamUrl("launch")
    const providerWireStreamUrl = await createStreamUrl("provider-wire")
    const launch: RuntimeLaunchRequest = {
      launchId: `launch-${crypto.randomUUID()}`,
      requestedAt: new Date().toISOString(),
      target: {
        kind: "command",
        spec: {
          argv: ["node", "--version"],
        },
      },
      planes: {
        session: {
          "provider-wire": {
            kind: "stream",
            role: "events",
            streamUrl: providerWireStreamUrl,
          },
        },
      },
    }

    const stream = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch(launch)
        return yield* handle.diagnosticStream("provider-wire")
      }),
    )

    expect(stream?.streamUrl).toEqual(providerWireStreamUrl)
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.1 opens lazy durable handles without live process authority", async () => {
    const launchStreamUrl = await createStreamUrl("launch")
    const snapshot = await runWithFiregrid(
      launchStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open("missing-launch").snapshot
      }),
    )

    expect(snapshot).toEqual({
      launchId: "missing-launch",
      runtimeProcesses: [],
    })
  })
})
