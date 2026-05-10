import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect } from "effect"
import {
  createJsonDurableStream,
} from "../DurableStreamLog.ts"

export interface DurableStreamsTestServerHandle {
  readonly url: string
  readonly createStreamUrl: (name: string) => Promise<string>
  readonly stop: () => Promise<void>
}

export const startDurableStreamsTestServer = async (): Promise<DurableStreamsTestServerHandle> => {
  const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  await server.start()
  return {
    url: server.url,
    createStreamUrl: async name => {
      const streamUrl = `${server.url}/v1/stream/${name}-${crypto.randomUUID()}`
      await Effect.runPromise(createJsonDurableStream({ streamUrl }))
      return streamUrl
    },
    stop: () => server.stop(),
  }
}
