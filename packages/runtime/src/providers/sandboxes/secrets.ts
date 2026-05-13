// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
//
// Resolver for durable RuntimeEnvBinding rows. Lives at the provider
// boundary: turns the row's bindings (durable, value-free) into the spawn
// primitive's envVars map by reading the host process env at activity
// execution time.
//
// Authorization is gated by RuntimeEnvResolverPolicy. The host operator
// supplies the allowlist of env-var names eligible for resolution; the
// default Layer is the deny-all policy, so a malicious or untrusted public
// launch row that writes `{ ref: "env:AWS_SECRET_ACCESS_KEY" }` cannot
// exfiltrate host env merely by being persisted. The same policy service
// also owns the env lookup callback so this module never touches
// globalThis.process.env directly.

import type { RuntimeEnvBinding } from "@firegrid/protocol/launch"
import { Context, Effect, Layer, Schema } from "effect"

const ENV_REF_PREFIX = "env:"

export class ResolveEnvBindingError extends Schema.TaggedError<ResolveEnvBindingError>()(
  "ResolveEnvBindingError",
  {
    op: Schema.String,
    bindingName: Schema.optional(Schema.String),
    envName: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

export type EnvLookup = (name: string) => string | undefined

export interface RuntimeEnvResolverPolicyValue {
  readonly allowedEnvVars: ReadonlySet<string>
  readonly lookupEnv: EnvLookup
}

export class RuntimeEnvResolverPolicy extends Context.Tag(
  "firegrid/sandboxes/RuntimeEnvResolverPolicy",
)<RuntimeEnvResolverPolicy, RuntimeEnvResolverPolicyValue>() {
  // Default policy: empty allowlist, lookup returns undefined. Any binding
  // ref is rejected; the resolver fails loudly before reaching a spawn.
  static denyAll: Layer.Layer<RuntimeEnvResolverPolicy> = Layer.succeed(
    this,
    {
      allowedEnvVars: new Set<string>(),
      lookupEnv: (_name: string) => undefined,
    },
  )

  // Construct a policy value from an explicit allowlist + lookup. The
  // lookup is injected so production code (firegrid:run) supplies the host
  // env reader at the binary boundary while tests can pass a deterministic
  // map. Named `make` (not `of`) to avoid colliding with the Tag class's
  // inherited `of(value: ServiceType)` constructor.
  static make(options: {
    readonly allowedEnvVars: Iterable<string>
    readonly lookupEnv: EnvLookup
  }): RuntimeEnvResolverPolicyValue {
    return {
      allowedEnvVars: new Set(options.allowedEnvVars),
      lookupEnv: options.lookupEnv,
    }
  }

  static withPolicy(
    options: {
      readonly allowedEnvVars: Iterable<string>
      readonly lookupEnv: EnvLookup
    },
  ): Layer.Layer<RuntimeEnvResolverPolicy> {
    return Layer.succeed(RuntimeEnvResolverPolicy, RuntimeEnvResolverPolicy.make(options))
  }
}

interface EnvRef {
  readonly kind: "env"
  readonly envName: string
}

const parseRef = (
  binding: RuntimeEnvBinding,
): Effect.Effect<EnvRef, ResolveEnvBindingError> =>
  binding.ref.startsWith(ENV_REF_PREFIX)
    ? Effect.succeed({
      kind: "env" as const,
      envName: binding.ref.slice(ENV_REF_PREFIX.length),
    })
    : Effect.fail(
      new ResolveEnvBindingError({
        op: "parseRef",
        bindingName: binding.name,
        message:
          `unsupported env binding ref shape: "${binding.ref}". Only "env:VAR" refs are supported in v1.`,
      }),
    )

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
export const resolveSpawnEnvVars = (
  bindings: ReadonlyArray<RuntimeEnvBinding>,
): Effect.Effect<
  Record<string, string>,
  ResolveEnvBindingError,
  RuntimeEnvResolverPolicy
> =>
  Effect.gen(function* () {
    const policy = yield* RuntimeEnvResolverPolicy
    const out: Record<string, string> = {}
    const seen = new Set<string>()
    let index = 0
    while (index < bindings.length) {
      const binding = bindings[index]!
      if (seen.has(binding.name)) {
        return yield* Effect.fail(
          new ResolveEnvBindingError({
            op: "resolveSpawnEnvVars",
            bindingName: binding.name,
            message: `duplicate env binding target name: ${binding.name}`,
          }),
        )
      }
      seen.add(binding.name)
      const parsed = yield* parseRef(binding)
      if (!policy.allowedEnvVars.has(parsed.envName)) {
        return yield* Effect.fail(
          new ResolveEnvBindingError({
            op: "resolveSpawnEnvVars",
            bindingName: binding.name,
            envName: parsed.envName,
            message:
              `env binding ${binding.name} references env:${parsed.envName} which is not on the runtime host's authorized env allowlist; refusing to resolve. Authorize it at the host boundary (e.g. firegrid:run --secret-env ${binding.name}=${parsed.envName}).`,
          }),
        )
      }
      const value = policy.lookupEnv(parsed.envName)
      if (value === undefined) {
        return yield* Effect.fail(
          new ResolveEnvBindingError({
            op: "resolveSpawnEnvVars",
            bindingName: binding.name,
            envName: parsed.envName,
            message:
              `env binding ${binding.name} is authorized but host env var ${parsed.envName} is not set in the host process; cannot resolve.`,
          }),
        )
      }
      out[binding.name] = value
      index += 1
    }
    return out
  })
