import { DurableStream } from "@durable-streams/client"
// Root-level repository test support. The client package itself does
// NOT depend on @durable-streams/server (runtime or dev); embedded
// server lifecycle is owned by repository test infrastructure outside
// the package boundary. See `../../../test-support/durable-streams-server.ts`.
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "../../../../test-support/durable-streams-server.js"

export { freshStreamUrl, startTestServer, stopTestServer }

export async function createSubstrateStream(label: string): Promise<string> {
  const url = freshStreamUrl(label)
  await DurableStream.create({ url, contentType: "application/json" })
  return url
}
