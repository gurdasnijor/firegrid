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
import { localProcessSpawnEnvFromHostEnv } from "@firegrid/runtime/sources/sandbox"
import {
  FiregridMcpServerLayer,
  FiregridMcpServerListenerConfig,
} from "@firegrid/runtime/composition/mcp-host"
import { Cause, Console, Effect, Exit, Layer } from "effect"

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

// Same daemon-fiber teardown concern as `runtime/bin/run.ts`: when the
// host process terminates (only path is signal-driven for this bin),
// `FiregridLocalHostLive`'s reconciler / subscriber daemons are
// reparented to the global scope via `Effect.forkDaemon`, so the
// default teardown's "set process.exitCode and let the event loop
// drain" never returns. Force-exit after recording the code.
function teardown<E, A>(
  exit: Exit.Exit<E, A>,
  onExit: (code: number) => void,
): void {
  const code = Exit.match(exit, {
    onSuccess: () => Number(globalThis.process.exitCode ?? 0),
    onFailure: (cause) => Cause.isInterruptedOnly(cause) ? 0 : 1,
  })
  onExit(code)
  globalThis.process.exit(code)
}

export const runFiregridHost = (): void => {
  // firegrid-runtime-process.BINARIES.12
  NodeRuntime.runMain(
    Effect.scoped(
      Layer.build(firegridHostLayer).pipe(
        Effect.tap(() => Console.log("Firegrid host running. Press Ctrl-C to stop.")),
        Effect.zipRight(firegridHostProgram),
      ),
    ),
    { teardown },
  )
}

runFiregridHost()
