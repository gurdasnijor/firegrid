import { DurableStreamTestServer } from "@durable-streams/server"

const port = Number.parseInt(process.env["DURABLE_STREAMS_PORT"] ?? "8080", 10)
const server = new DurableStreamTestServer({ port, host: "127.0.0.1" })
const url = await server.start()

console.log(`Durable Streams test server listening at ${url}`)
await new Promise(() => {})
