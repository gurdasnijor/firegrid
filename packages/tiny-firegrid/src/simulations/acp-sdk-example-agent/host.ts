import {
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const acpSdkExampleAgentHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> =>
  FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
  ) as Layer.Layer<FiregridHost, unknown, never>
