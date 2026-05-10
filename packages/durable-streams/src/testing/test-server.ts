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

export interface StartDurableStreamsTestServerOptions {
  readonly dataDir?: string
  readonly host?: string
  readonly port?: number
}

export const startDurableStreamsTestServer = async (
  options: StartDurableStreamsTestServerOptions = {},
): Promise<DurableStreamsTestServerHandle> => {
  const server = new DurableStreamTestServer({
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
  })
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
