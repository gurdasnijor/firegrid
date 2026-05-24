import { FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import {
  FiregridEnvBindingsFromEnv,
  FiregridLocalProcessFromEnv,
} from "@firegrid/runtime/producers/sandbox/local-process-from-env"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

/**
 * Agent-coordination readiness host. Composes the full production
 * `FiregridLocalHostLive` topology directly from the runtime's canonical
 * composition home (Class F3 — `@firegrid/runtime/composition/host-live`),
 * which provides `FiregridRuntimeHostLive` under the hood — including the
 * registered `HostPlaneChannelRouter` with the
 * `sessionAgentOutputObservationRoute` mapped onto `session.agent_output`
 * per #703.
 *
 * The host-sdk re-export shims (formerly `@firegrid/host-sdk`'s
 * `FiregridLocalHostLive` / `FiregridLocalProcessFromEnv` /
 * `FiregridEnvBindingsFromEnv`) are stale on this branch (deleted file
 * `packages/host-sdk/src/host/acp-stdio-edge.ts` is still listed in
 * `packages/host-sdk/src/host/index.ts`'s re-exports as of `91ed12b77`),
 * so the canonical runtime imports route around the broken barrel
 * without touching it. No app-specific channels, MCP, or fact tables —
 * the readiness sim only needs the public composition to prove the
 * `session.agent_output / wait_for` route is reachable through both the
 * public client method `handle.wait.forAgentOutput` AND a direct
 * `HostPlaneChannelRouter.dispatch(...)`.
 *
 * Step 1 of the readiness checklist is YELLOW (runtime-bin doesn't exist
 * yet; CC6 will land that). This sim composes the host in-process exactly
 * as the runtime-bin will once it ships.
 */
export const agentCoordinationReadinessHost = (
  env: TinyFiregridHostEnv,
) =>
  FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [],
    })),
  )
