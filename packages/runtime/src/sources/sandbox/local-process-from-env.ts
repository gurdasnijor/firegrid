// Class E* canonical home: the `FiregridLocalProcess` Tag + the two
// composition helpers (`FiregridLocalProcessFromEnv`,
// `FiregridEnvBindingsFromEnv`) lived in the deleted
// `packages/host-sdk/src/host/layers.ts:79-97`. They are runtime-side
// process-env composition (sandbox provider options + env-binding policy
// for `RuntimeEnvResolverPolicy`); per #733/§7 they have no client-sdk
// equivalent and the canonical home is `sources/sandbox/`. Reachable
// via `@firegrid/runtime/sources/sandbox/local-process-from-env`.

import { Context } from "effect"
import { type LocalProcessSandboxProviderOptions } from "./index.ts"

/**
 * Tag carrying `LocalProcessSandboxProviderOptions` resolved from the
 * host process env. Consumers ({@link FiregridRuntimeHostLive} et al.)
 * pick it up at composition time when the topology does not supply
 * `localProcessEnv` directly.
 */
export class FiregridLocalProcess extends Context.Tag(
  "firegrid/runtime/producers/sandbox/FiregridLocalProcess",
)<FiregridLocalProcess, LocalProcessSandboxProviderOptions>() {}
