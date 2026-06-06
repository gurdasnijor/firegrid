import * as acp from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import {
  FiregridAcpClient,
  FluentAcpClientError,
  type FluentAcpRuntimePortService,
} from "./client.ts"

export interface ConnectFiregridAcpInput {
  readonly stream: acp.Stream
  readonly runtime: FluentAcpRuntimePortService
}

export interface FiregridAcpConnection {
  readonly agent: acp.Agent
  readonly client: FiregridAcpClient
  readonly connection: acp.ClientSideConnection
  readonly close: Effect.Effect<void, FluentAcpClientError>
}

export const connectFiregridAcp = (
  input: ConnectFiregridAcpInput,
): Effect.Effect<FiregridAcpConnection, never> =>
  Effect.sync(() => {
    const client = new FiregridAcpClient({ runtime: input.runtime })
    const connection = new acp.ClientSideConnection(() => client, input.stream)

    return {
      agent: connection,
      client,
      connection,
      close: Effect.tryPromise({
        try: () => input.stream.writable.close(),
        catch: (cause) =>
          new FluentAcpClientError({
            op: "close",
            message: "failed to close ACP writable stream",
            cause,
          }),
      }).pipe(Effect.catchAll(() => Effect.void)),
    }
  })

