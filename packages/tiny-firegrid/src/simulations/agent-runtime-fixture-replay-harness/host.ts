import { FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import { FiregridEnvBindingsFromEnv, FiregridLocalProcessFromEnv } from "@firegrid/runtime/producers/sandbox/local-process-from-env"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const agentRuntimeFixtureReplayHost = (
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
