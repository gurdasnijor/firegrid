import { writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Config, Effect } from "effect"
import { runFlamecastRuntime } from "./handler.ts"
import type { FlamecastTopology } from "../shared/topology.ts"

const runtimeId = `flamecast-local-${process.pid}`
const topologyPath = resolve("public/topology.json")
const baseUrl = await Effect.runPromise(
  Config.string("FLAMECAST_DURABLE_STREAMS_BASE_URL").pipe(
    Effect.map(value => value.replace(/\/+$/, "")),
  ),
)

const streamUrl = `${baseUrl}/v1/stream/flamecast.lt02-local-session-loop`
const topology: FlamecastTopology = {
  streamUrl,
  runtimeId,
  startedAt: new Date().toISOString(),
}

await mkdir(dirname(topologyPath), { recursive: true })
await writeFile(topologyPath, `${JSON.stringify(topology, null, 2)}\n`)

console.log(`Flamecast runtime ${runtimeId}`)
console.log(`Durable stream: ${streamUrl}`)
console.log(`Topology: ${topologyPath}`)

await Effect.runPromise(
  runFlamecastRuntime(streamUrl),
)
