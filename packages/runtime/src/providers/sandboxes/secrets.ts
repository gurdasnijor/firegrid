// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
//
// Resolver for durable RuntimeEnvBinding rows. Lives at the provider
// boundary: turns the row's bindings (durable, value-free) into the spawn
// primitive's envVars map by reading the host process env at activity
// execution time.
//
// Authorization is gated by RuntimeEnvResolverPolicy. The host operator
// authorizes specific (bindingName, envName) PAIRS — not just source env
// names — so a malicious row cannot route an authorized source value into
// an unapproved child target like NODE_OPTIONS or LD_PRELOAD. The default
// Layer is the deny-all policy, so a public launch row that writes
// `{ ref: "env:AWS_SECRET_ACCESS_KEY" }` cannot exfiltrate host env merely
// by being persisted. The same policy service owns the env lookup callback
// so this module never touches globalThis.process.env directly.

import type { RuntimeEnvBinding } from "@firegrid/protocol/launch"
import { Context, Effect, Layer, Schema } from "effect"

const ENV_REF_PREFIX = "env:"

// POSIX-ish env-var identifier shape. The resolver enforces this on the
// durable binding's `name` (the env var the *child* will see) as a
// defense-in-depth check: a row that smuggles `BAD;NAME=value` through the
// durable plane never reaches a spawn.
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

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
  // bindingName → authorized envName. The host operator authorizes pairs;
  // a row's (binding.name, ref.envName) must match an entry exactly.
  readonly authorizedBindings: ReadonlyMap<string, string>
  readonly lookupEnv: EnvLookup
}

export class RuntimeEnvResolverPolicy extends Context.Tag(
  "firegrid/sandboxes/RuntimeEnvResolverPolicy",
)<RuntimeEnvResolverPolicy, RuntimeEnvResolverPolicyValue>() {
  // Default policy: empty authorization map, lookup returns undefined.
  // Any binding is rejected; the resolver fails loudly before reaching a
  // spawn.
  static denyAll: Layer.Layer<RuntimeEnvResolverPolicy> = Layer.succeed(
    this,
    {
      authorizedBindings: new Map<string, string>(),
      lookupEnv: (_name: string) => undefined,
    },
  )

  // Construct a policy value from an explicit (bindingName, envName) pair
  // map + lookup. The lookup is injected so production code
  // (firegrid:run) supplies the host env reader at the binary boundary
  // while tests can pass a deterministic map. Named `make` (not `of`) to
  // avoid colliding with the Tag class's inherited `of(value: ServiceType)`
  // constructor.
  static make(options: {
    readonly authorizedBindings: ReadonlyMap<string, string> | Iterable<readonly [string, string]>
    readonly lookupEnv: EnvLookup
  }): RuntimeEnvResolverPolicyValue {
    return {
      authorizedBindings: new Map(options.authorizedBindings),
      lookupEnv: options.lookupEnv,
    }
  }

  static withPolicy(
    options: {
      readonly authorizedBindings: ReadonlyMap<string, string> | Iterable<readonly [string, string]>
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

      // Defense-in-depth: durable bindings can in principle carry any
      // string in `name`. Reject anything that isn't a POSIX-ish env-var
      // identifier so a malformed name can never reach `Command.env(...)`.
      if (!ENV_NAME_PATTERN.test(binding.name)) {
        return yield* Effect.fail(
          new ResolveEnvBindingError({
            op: "resolveSpawnEnvVars",
            bindingName: binding.name,
            message:
              `env binding target name "${binding.name}" is not a valid env-var identifier; refusing to resolve.`,
          }),
        )
      }

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

      // Pair-based authorization: an entry must exist for this binding
      // name AND its authorized source envName must match exactly. This
      // prevents a row from routing an authorized source value into an
      // unapproved child target (e.g. NODE_OPTIONS=$(env:ANTHROPIC_API_KEY)
      // when only ANTHROPIC_API_KEY=$(env:ANTHROPIC_API_KEY) was granted).
      const authorizedEnvName = policy.authorizedBindings.get(binding.name)
      if (authorizedEnvName === undefined) {
        return yield* Effect.fail(
          new ResolveEnvBindingError({
            op: "resolveSpawnEnvVars",
            bindingName: binding.name,
            envName: parsed.envName,
            message:
              `env binding target ${binding.name} is not authorized by the runtime host; refusing to resolve. Authorize the exact (target,source) pair at the host boundary (e.g. firegrid:run --secret-env ${binding.name}=${parsed.envName}).`,
          }),
        )
      }
      if (authorizedEnvName !== parsed.envName) {
        return yield* Effect.fail(
          new ResolveEnvBindingError({
            op: "resolveSpawnEnvVars",
            bindingName: binding.name,
            envName: parsed.envName,
            message:
              `env binding ${binding.name}=env:${parsed.envName} does not match the authorized pair ${binding.name}=env:${authorizedEnvName}; refusing to resolve.`,
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
