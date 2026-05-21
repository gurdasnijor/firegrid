import {
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../../types.ts"

export interface Sim3RuntimeEnv {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}

const runtimeEnvLatch = (() => {
  let resolveRuntimeEnv: (env: Sim3RuntimeEnv) => void = () => undefined
  const promise = new Promise<Sim3RuntimeEnv>((resolve) => {
    resolveRuntimeEnv = resolve
  })
  return {
    promise,
    resolve: resolveRuntimeEnv,
  }
})()

export const sim3RuntimeEnv = runtimeEnvLatch.promise

export const sim3BindingSwapIsolationHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  runtimeEnvLatch.resolve({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
  })

  return FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
