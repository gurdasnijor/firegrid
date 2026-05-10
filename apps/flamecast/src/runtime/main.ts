import { ensureJsonDurableStream } from "@firegrid/durable-streams/log"
import {
  startDurableStreamsTestServer,
} from "@firegrid/durable-streams/test-utils"
import { writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Effect } from "effect"
import { runFlamecastRuntime } from "./handler.ts"
import type { FlamecastTopology } from "../shared/topology.ts"

const runtimeId = `flamecast-local-${process.pid}`
const topologyPath = resolve("public/topology.json")
const dataDir = resolve(".flamecast-durable-streams")

const server = await startDurableStreamsTestServer({ dataDir, port: 0 })

const streamUrl = `${server.url}/flamecast/lt02-local-session-loop`
await Effect.runPromise(ensureJsonDurableStream({ streamUrl }))

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
  runFlamecastRuntime(streamUrl),
)
