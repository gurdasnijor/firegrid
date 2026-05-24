// Runtime-owned `firegrid:host` daemon entrypoint.
//
// Behavior is preserved verbatim from the previous CLI source
// `packages/cli/src/bin/host.ts`; only the import edges are re-rooted at
// runtime canonical homes. The thin `@firegrid/cli` host launcher
// subprocesses into this file.
//
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// The firegrid:host binary composes through FiregridLocalHostLive,
// which owns CurrentHostSession internally and derives a deterministic
// host id from the namespace. No env/disk authority knob.

import type { HttpRouter } from "@effect/platform"
import { NodeRuntime } from "@effect/platform-node"
import { ensurePathInput } from "@firegrid/protocol/mcp"
import {
  FiregridLocalHostLive,
  RuntimeHostTopologyFromConfig,
} from "@firegrid/runtime/composition/host-live"
import { localProcessSpawnEnvFromHostEnv } from "@firegrid/runtime/producers/sandbox"
import {
  FiregridMcpServerLayer,
  FiregridMcpServerListenerConfig,
} from "@firegrid/runtime/producers/codecs/mcp"
import { Console, Effect, Layer } from "effect"

export const firegridHostProgram = Effect.never

export const firegridHostLayer = Layer.unwrapEffect(
  Effect.map(
    Effect.all({
      topology: RuntimeHostTopologyFromConfig,
      mcp: FiregridMcpServerListenerConfig,
    }),
    ({ topology, mcp }) => {
      const runtimeHost = FiregridLocalHostLive({
        ...topology,
        localProcessEnv: localProcessSpawnEnvFromHostEnv(globalThis.process.env),
      })
      if (!mcp.enabled) return runtimeHost
      // firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1
      // firegrid-host-context-authority.MCP_CONTEXT_ROUTING.2
      return FiregridMcpServerLayer({
        host: mcp.host,
        port: mcp.port,
        path: ensurePathInput(mcp.path) as HttpRouter.PathInput,
      }).pipe(
        Layer.provideMerge(runtimeHost),
      )
    },
  ),
)

export const runFiregridHost = (): void => {
  // firegrid-runtime-process.BINARIES.12
  NodeRuntime.runMain(
    Effect.scoped(
      Layer.build(firegridHostLayer).pipe(
        Effect.tap(() => Console.log("Firegrid host running. Press Ctrl-C to stop.")),
        Effect.zipRight(firegridHostProgram),
      ),
    ),
  )
}

runFiregridHost()
