import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { RuntimeLaunchRequest } from "@firegrid/protocol/launch"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Firegrid } from "./index.ts"

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

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Firegrid.scoped({ launchStreamUrl }).pipe(
          Effect.flatMap(client =>
            client.launch(launch).pipe(
              Effect.flatMap(handle => handle.snapshot),
            ),
          ),
        ),
      ),
    )

    expect(snapshot.request?.launchId).toEqual(launch.launchId)
    expect(snapshot.runtimeProcesses).toEqual([])
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

    const stream = await Effect.runPromise(
      Effect.scoped(
        Firegrid.scoped({ launchStreamUrl }).pipe(
          Effect.flatMap(client =>
            client.launch(launch).pipe(
              Effect.flatMap(handle => handle.diagnostic.stream("provider-wire")),
            ),
          ),
        ),
      ),
    )

    expect(stream?.streamUrl).toEqual(providerWireStreamUrl)
  })
})
