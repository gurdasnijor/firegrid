import {
  FiregridLocalHostLive,
} from "@firegrid/host-sdk"
import {
  FiregridEnvBindingsFromEnv,
  FiregridLocalProcessFromEnv,
} from "@firegrid/host-sdk"
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
