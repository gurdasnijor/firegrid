import { NodeRuntime } from "@effect/platform-node"
import {
  FiregridLocalHostLive,
  RuntimeHostTopologyFromConfig,
  localProcessSpawnEnvFromHostEnv,
} from "@firegrid/runtime"
import { Console, Effect, Layer } from "effect"

export const firegridHostProgram = Effect.never

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// The firegrid:host binary composes through FiregridLocalHostLive,
// which owns CurrentHostSession internally and derives a
// deterministic host id from the namespace. No env/disk authority knob.
export const firegridHostLayer = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, topology =>
    FiregridLocalHostLive({
      ...topology,
      localProcessEnv: localProcessSpawnEnvFromHostEnv(globalThis.process.env),
    }),
  ),
)

// Host-boot wiring for `@firegrid/runtime/agent-tools` `FiregridMcpServerLayer`
// is intentionally deferred. Per the PR #194 follow-up review, the
// runtime `contextId` is durable/session state, not host-process env,
// so an env-driven `FiregridMcpServerFromConfig` would expand
// deployment config with runtime identity at the wrong boundary. The
// host-side wiring lands once one of these is available:
//   - `/mcp/runtime-context/:contextId` route-based
//     `FiregridAgentToolContext` injection through Effect AI's HTTP
//     layer without a custom JSON-RPC handler; or
//   - a durable host/session/local-agent authority record in
//     `runtime-host` / control-plane shape that maps to `contextId`
//     and supplies it to the MCP server layer.
// Tests and downstream consumers compose `FiregridMcpServerLayer({
// contextId, ... })` directly.

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
