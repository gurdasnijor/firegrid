// Repository-level test support for embedded Durable Streams server
// lifecycle. NOT a workspace package; NOT exported from any
// `@firegrid/*` public API. Tests in any package may
// import this file by relative path (e.g.
// `../../../test-support/durable-streams-server.ts`).
//
// launchable-substrate-host.HOST_PROCESS.8 / PACKAGING.9
// Server process ownership is the host package's domain in production.
// This file owns ONLY embedded test-server lifecycle for repository
// integration tests; it does not widen any package's public API or
// dependency graph.
import { DurableStreamTestServer } from "@durable-streams/server"

let server: DurableStreamTestServer | undefined
let counter = 0

export async function startTestServer(): Promise<DurableStreamTestServer> {
  if (!server) {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
  }
  return server
}

export async function stopTestServer(): Promise<void> {
  await server?.stop()
  server = undefined
}

export function freshStreamUrl(label: string): string {
  if (!server) {
    throw new Error("call startTestServer() in beforeAll first")
  }
  return `${server.url}/substrate/${label}-${++counter}`
}
