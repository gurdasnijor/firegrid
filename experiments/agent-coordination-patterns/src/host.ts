import { FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import {
  FiregridEnvBindingsFromEnv,
  FiregridLocalProcessFromEnv,
} from "@firegrid/runtime/producers/sandbox/local-process-from-env"
import { Layer } from "effect"
import type { CoordinationBoardHost } from "./app/coordination-board.ts"
import type { ParticipantRuntime } from "./types.ts"

export const makeAgentCoordinationFiregridHost = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly runtime: ParticipantRuntime
    readonly board: CoordinationBoardHost
    readonly processEnv?: NodeJS.ProcessEnv
  },
) => {
  const processEnv = options.processEnv ?? globalThis.process.env
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: options.durableStreamsBaseUrl,
    namespace: options.namespace,
    input: true,
    mcpChannels: options.board.registrations,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv,
      allow: options.runtime.secretEnv.map(name => [name, name] as const),
    })),
  )

  const mcp = Layer.discard(
    FiregridMcpServerLayer({
      host: "127.0.0.1",
      port: 0,
      path: ensurePathInput("/mcp"),
    }),
  )

  return Layer.mergeAll(mcp).pipe(Layer.provideMerge(host))
}
