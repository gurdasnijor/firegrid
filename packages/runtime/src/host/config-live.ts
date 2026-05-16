import { Config, Effect, Layer, Option, Redacted } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import type { RuntimeEnvResolverPolicy } from "../agent-event-pipeline/sources/sandbox/index.ts"
import { FiregridLocalHostLive } from "./layers.ts"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.4
// Config-derived host layers stay separate from runtime command handlers.
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// RuntimeHostTopologyFromConfig reads only the base URL + namespace +
// optional input / token from env. Host identity is NOT an env knob:
// `FiregridRuntimeHostFromConfig` composes the resulting topology
// through `FiregridLocalHostLive`, which owns CurrentHostSession
// internally and derives the host id deterministically from the
// namespace. Multi-host topologies bypass FromConfig entirely and
// supply `hostId` at the programmatic composition boundary via
// `FiregridRuntimeHostWithWorkflowLive`.
export const RuntimeHostTopologyFromConfig = Config.all({
  durableStreamsBaseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE"),
  input: Config.boolean("FIREGRID_RUNTIME_INPUT_ENABLED").pipe(
    Config.withDefault(false),
  ),
  token: Config.option(Config.redacted("FIREGRID_DURABLE_STREAMS_TOKEN")),
}).pipe(
  Config.map(({ durableStreamsBaseUrl, namespace, input, token }) => {
    const headers = Option.match(token, {
      onNone: () => undefined,
      onSome: (redacted) => ({
        Authorization: () => `Bearer ${Redacted.value(redacted)}`,
      }) satisfies DurableTableHeaders,
    })
    return {
      durableStreamsBaseUrl,
      namespace,
      input,
      ...(headers !== undefined ? { headers } : {}),
    }
  }),
)

export const FiregridRuntimeHostFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridLocalHostLive(options)),
)

export const FiregridRuntimeHostWithWorkflowFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridLocalHostLive(options)),
)

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
// Variant for callers that want to pass a non-default env resolver policy
// (e.g. firegrid:run, whose --secret-env flag authorizes specific host env
// vars). The policy is constructed at the binary boundary so that
// globalThis.process.env reads stay outside library code.
export const FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy = (
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy>,
) =>
  Layer.unwrapEffect(
    Effect.map(RuntimeHostTopologyFromConfig, options =>
      FiregridLocalHostLive(options, envPolicy)),
  )
