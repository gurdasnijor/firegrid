import { DurableStreamTestServer } from "@durable-streams/server"

let server: DurableStreamTestServer | undefined

export async function startTestServer(): Promise<DurableStreamTestServer> {
  if (!server) {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
  }
  return server
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    await server.stop()
    server = undefined
  }
}

export function freshStreamUrl(label: string): string {
  if (!server) throw new Error("call startTestServer() in beforeAll first")
  return `${server.url}/substrate/${label}-${crypto.randomUUID()}`
}
