import { Config, Effect, Option } from "effect"
import { buildHostHeaders } from "./headers.js"
import { generateProcessId } from "./identity.js"
import type { SubstrateHostBootPlan } from "./plan.js"

// launchable-substrate-host.HOST_CONFIGURATION.4
// launchable-substrate-host.HOST_CONFIGURATION.5
// launchable-substrate-host.HOST_CONFIGURATION.6
// launchable-substrate-host.HOST_CONFIGURATION.7
// launchable-substrate-host.HOST_CONFIGURATION.10
// launchable-substrate-host.HOST_CONFIGURATION.11
//
// `bootPlanFromConfig` decodes a `SubstrateHostBootPlan` from Effect
// Config:
//   SUBSTRATE_STREAM_URL    -> attached-mode stream URL (selects mode)
//   SUBSTRATE_DS_HOST       -> embedded-dev DS host (default 127.0.0.1)
//   SUBSTRATE_DS_PORT       -> embedded-dev DS port (default 0; OS-assigned)
//   SUBSTRATE_STREAM        -> embedded-dev stream name (default "substrate")
//   SUBSTRATE_PROCESS_ID    -> explicit override (advanced)
//   SUBSTRATE_AUTHORIZATION -> Authorization header verbatim
//   SUBSTRATE_TOKEN         -> bare bearer token; materialized as
//                              "Authorization: Bearer <token>"

const optionalString = (key: string) => Config.option(Config.string(key))
const optionalInteger = (key: string) => Config.option(Config.integer(key))

export const bootPlanFromConfig: Effect.Effect<
  SubstrateHostBootPlan,
  ConfigError
> = Effect.gen(function* () {
  const streamUrl = yield* optionalString("SUBSTRATE_STREAM_URL")
  const dsHost = yield* optionalString("SUBSTRATE_DS_HOST")
  const dsPort = yield* optionalInteger("SUBSTRATE_DS_PORT")
  const streamName = yield* optionalString("SUBSTRATE_STREAM")
  const processIdOverride = yield* optionalString("SUBSTRATE_PROCESS_ID")
  const authorization = yield* optionalString("SUBSTRATE_AUTHORIZATION")
  const bearerToken = yield* optionalString("SUBSTRATE_TOKEN")

  const processId = Option.match(processIdOverride, {
    onNone: () => generateProcessId(),
    onSome: (id) => id,
  })

  const headers = buildHostHeaders({
    ...(Option.isSome(authorization)
      ? { authorization: authorization.value }
      : {}),
    ...(Option.isSome(bearerToken) ? { bearerToken: bearerToken.value } : {}),
  })

  if (Option.isSome(streamUrl)) {
    // launchable-substrate-host.HOST_CONFIGURATION.6
    // Configured URL selects attached mode; the host does not start or
    // own a remote Durable Streams process.
    return {
      _tag: "AttachedHost",
      processId,
      headers,
      streamUrl: streamUrl.value,
    } satisfies SubstrateHostBootPlan
  }

  // launchable-substrate-host.HOST_CONFIGURATION.5
  // Missing URL selects embedded-dev mode rather than requiring a
  // remote service in local development.
  return {
    _tag: "EmbeddedDevHost",
    processId,
    headers,
    durableStreams: {
      host: Option.match(dsHost, {
        onNone: () => "127.0.0.1",
        onSome: (h) => h,
      }),
      port: Option.match(dsPort, { onNone: () => 0, onSome: (p) => p }),
      streamName: Option.match(streamName, {
        onNone: () => "substrate",
        onSome: (s) => s,
      }),
    },
  } satisfies SubstrateHostBootPlan
})

// Re-export Effect.ConfigError for consumer convenience without
// requiring direct imports from `effect/ConfigError`.
export type ConfigError = import("effect/ConfigError").ConfigError
