// Class E* canonical home: the `FiregridLocalProcess` Tag + the two
// composition helpers (`FiregridLocalProcessFromEnv`,
// `FiregridEnvBindingsFromEnv`) lived in the deleted
// `packages/host-sdk/src/host/layers.ts:79-97`. They are runtime-side
// process-env composition (sandbox provider options + env-binding policy
// for `RuntimeEnvResolverPolicy`); per #733/§7 they have no client-sdk
// equivalent and the canonical home is `producers/sandbox/`. Reachable
// via `@firegrid/runtime/producers/sandbox/local-process-from-env`.

import { Context, Layer } from "effect"
import {
  localProcessSpawnEnvFromHostEnv,
  type LocalProcessSandboxProviderOptions,
  RuntimeEnvResolverPolicy,
} from "./index.ts"

/**
 * Tag carrying `LocalProcessSandboxProviderOptions` resolved from the
 * host process env. Consumers ({@link FiregridRuntimeHostLive} et al.)
 * pick it up at composition time when the topology does not supply
 * `localProcessEnv` directly.
 */
export class FiregridLocalProcess extends Context.Tag(
  "firegrid/runtime/producers/sandbox/FiregridLocalProcess",
)<FiregridLocalProcess, LocalProcessSandboxProviderOptions>() {}

/**
 * Lift the host's `process.env`-shaped record into a
 * {@link FiregridLocalProcess} Layer through
 * `localProcessSpawnEnvFromHostEnv`. The Layer is a `Layer.succeed`; no
 * Effect machinery, no side effect at build time.
 */
export const FiregridLocalProcessFromEnv = (
  processEnv: Record<string, string | undefined>,
): Layer.Layer<FiregridLocalProcess> =>
  Layer.succeed(FiregridLocalProcess, localProcessSpawnEnvFromHostEnv(processEnv))

/**
 * Compose a {@link RuntimeEnvResolverPolicy} Layer from a flat
 * (bindingName, envName) allow-list against the host's process env.
 * Wraps `RuntimeEnvResolverPolicy.withPolicy(...)`; the lookup is a
 * plain property read on the supplied record.
 */
export const FiregridEnvBindingsFromEnv = (
  options: {
    readonly processEnv: Record<string, string | undefined>
    readonly allow: Iterable<readonly [bindingName: string, envName: string]>
  },
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: options.allow,
    lookupEnv: name => options.processEnv[name],
  })
