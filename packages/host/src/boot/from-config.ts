import { Config, Effect, Option } from "effect"
import { generateProcessId } from "./identity.js"
import type { SubstrateHostBootPlan } from "./plan.js"

// launchable-substrate-host.HOST_CONFIGURATION.4
// launchable-substrate-host.HOST_CONFIGURATION.5
// launchable-substrate-host.HOST_CONFIGURATION.6
// launchable-substrate-host.HOST_CONFIGURATION.7
//
// `bootPlanFromConfig` decodes a `SubstrateHostBootPlan` from Effect
// Config:
//   SUBSTRATE_STREAM_URL    -> attached-mode stream URL (selects mode)
//   SUBSTRATE_DS_HOST       -> embedded-dev DS host (default 127.0.0.1)
//   SUBSTRATE_DS_PORT       -> embedded-dev DS port (default 0; OS-assigned)
//   SUBSTRATE_STREAM        -> embedded-dev stream name (default "substrate")
//   SUBSTRATE_PROCESS_ID    -> explicit override (advanced)

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

  const processId = Option.match(processIdOverride, {
    onNone: () => generateProcessId(),
    onSome: (id) => id,
  })

  if (Option.isSome(streamUrl)) {
    // launchable-substrate-host.HOST_CONFIGURATION.6
    // Configured URL selects attached mode; the host does not start or
    // own a remote Durable Streams process.
    return {
      _tag: "AttachedHost",
      processId,
      streamUrl: streamUrl.value,
    } satisfies SubstrateHostBootPlan
  }

  // launchable-substrate-host.HOST_CONFIGURATION.5
  // Missing URL selects embedded-dev mode rather than requiring a
  // remote service in local development.
  return {
    _tag: "EmbeddedDevHost",
    processId,
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
