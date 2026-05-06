import { DurableStream, FetchError } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
/* eslint-disable @effect/no-import-from-barrel-package -- firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2 */
import { run } from "@firegrid/runtime"
/* eslint-enable @effect/no-import-from-barrel-package */
import { writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Effect } from "effect"
import { makeFlamecastRuntime } from "./handler.ts"
import type { FlamecastTopology } from "../shared/topology.ts"

const runtimeId = `flamecast-local-${process.pid}`
const topologyPath = resolve("public/topology.json")
const dataDir = resolve(".flamecast-durable-streams")

const server = new DurableStreamTestServer({ dataDir, port: 0 })
await server.start()

const streamUrl = `${server.url}/flamecast/lt02-local-session-loop`
await DurableStream.head({ url: streamUrl }).catch((cause: unknown) => {
  if (cause instanceof FetchError && cause.status === 404) {
    return DurableStream.create({
      url: streamUrl,
      contentType: "application/json",
    })
  }
  return Promise.reject(
    cause instanceof Error ? cause : new Error(String(cause)),
  )
})

const topology: FlamecastTopology = {
  streamUrl,
  runtimeId,
  startedAt: new Date().toISOString(),
}

await mkdir(dirname(topologyPath), { recursive: true })
await writeFile(topologyPath, `${JSON.stringify(topology, null, 2)}\n`)

console.log(`Flamecast runtime ${runtimeId}`)
console.log(`Durable stream: ${streamUrl}`)
console.log(`Durable data: ${dataDir}`)
console.log(`Topology: ${topologyPath}`)

const shutdown = async () => {
  await server.stop()
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0))
})
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0))
})

await Effect.runPromise(
  run({
    connection: { streamUrl },
    runtime: makeFlamecastRuntime({
      streamUrl,
      clientId: runtimeId,
    }),
  }),
)
