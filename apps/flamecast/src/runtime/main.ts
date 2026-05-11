import { FetchHttpClient } from "@effect/platform"
import {
  startDurableStreamsTestServer,
} from "@firegrid/durable-streams/test-utils"
import { writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { DurableStream } from "effect-durable-streams"
import { runFlamecastRuntime } from "./handler.ts"
import type { FlamecastTopology } from "../shared/topology.ts"

const runtimeId = `flamecast-local-${process.pid}`
const topologyPath = resolve("public/topology.json")
const dataDir = resolve(".flamecast-durable-streams")

const server = await startDurableStreamsTestServer({ dataDir, port: 0 })

const streamUrl = `${server.url}/flamecast/lt02-local-session-loop`
// effect-native-production-cutover.CLIENT_APP.2
await Effect.runPromise(DurableStream.define({
  endpoint: { url: streamUrl },
  schema: Schema.Unknown,
}).create({ contentType: "application/json" }).pipe(
  Effect.catchTag("DurableStream/Conflict", () => Effect.void),
  Effect.provide(FetchHttpClient.layer),
))

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
