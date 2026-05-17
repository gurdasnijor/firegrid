import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/host-substrate"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import { defaultFactoryNamespace, authorizedBindingsFromPlanner, type FactoryConfig } from "../config.ts"
import {
  DarkFactoryHostLive,
  localProcessEnvFromRecord,
} from "../host.ts"

const FactoryHostRuntimeConfig = Config.all({
  durableStreamsBaseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE").pipe(
    Config.withDefault(defaultFactoryNamespace),
  ),
  token: Config.option(Config.redacted("FIREGRID_DURABLE_STREAMS_TOKEN")),
})

type HostRuntimeConfig = Config.Config.Success<typeof FactoryHostRuntimeConfig>

const hostEnv = (globalThis as typeof globalThis & {
  readonly process: {
    readonly env: Record<string, string | undefined>
  }
})["process"].env

const optionalHeaders = (
  token: Option.Option<Redacted.Redacted>,
): DurableTableHeaders | undefined =>
  Option.match(token, {
    onNone: () => undefined,
    onSome: redacted => ({
      Authorization: () => `Bearer ${Redacted.value(redacted)}`,
    }),
  })

const hostConfigFrom = (
  runtimeConfig: HostRuntimeConfig,
) => {
  const headers = optionalHeaders(runtimeConfig.token)
  return {
    durableStreamsBaseUrl: runtimeConfig.durableStreamsBaseUrl,
    namespace: runtimeConfig.namespace,
    ...(headers === undefined ? {} : { headers }),
    localProcessEnv: localProcessEnvFromRecord(hostEnv),
  }
}

export const factoryHostLayerFromConfig = (
  config: FactoryConfig,
) =>
  Layer.unwrapEffect(
    Effect.map(FactoryHostRuntimeConfig, runtimeConfig => {
      const authorizedBindings = config.authorizedBindings ??
        authorizedBindingsFromPlanner(config.planner)
      const envPolicy = RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings,
        lookupEnv: name => hostEnv[name],
      })
      return DarkFactoryHostLive(hostConfigFrom(runtimeConfig), envPolicy)
    }),
  )
