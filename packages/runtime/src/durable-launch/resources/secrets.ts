import type { PlaneBinding, ResourcePlaneRef, RuntimeLaunchRequest } from "@firegrid/protocol/launch"
import { Context, Effect, Layer, Redacted } from "effect"
import { RuntimeLaunchError } from "../launcher.ts"

interface SecretResolverService {
  readonly resolve: (ref: string) => Effect.Effect<Redacted.Redacted<string>, RuntimeLaunchError>
}

export class SecretResolver extends Context.Tag("firegrid/runtime/durable-launch/SecretResolver")<
  SecretResolver,
  SecretResolverService
>() {
  static layer = (service: SecretResolverService): Layer.Layer<SecretResolver> =>
    Layer.succeed(this, service)
}

const secretResourceForBinding = (
  launch: RuntimeLaunchRequest,
  binding: PlaneBinding,
): Effect.Effect<ResourcePlaneRef, RuntimeLaunchError> =>
  Effect.gen(function* () {
    if (binding.from.plane !== "resources") {
      return yield* new RuntimeLaunchError({
        op: "secretBinding",
        message: `env-secret binding must read from resources plane: ${binding.name}`,
      })
    }
    const resource = launch.planes.resources?.[binding.from.name]
    if (resource?.kind !== "secret") {
      return yield* new RuntimeLaunchError({
        op: "secretBinding",
        message: `env-secret binding must point at a secret resource: ${binding.name}`,
      })
    }
    return resource
  })

const getPlaneField = (
  launch: RuntimeLaunchRequest,
  binding: PlaneBinding,
): string | undefined => {
  const planeSet = launch.planes[binding.from.plane]
  const plane = planeSet?.[binding.from.name]
  if (plane === undefined) return undefined
  const value = plane[binding.from.field as keyof typeof plane]
  return typeof value === "string" ? value : undefined
}

export const envForLaunch = (
  launch: RuntimeLaunchRequest,
): Effect.Effect<Record<string, string | undefined>, RuntimeLaunchError, SecretResolver> =>
  Effect.gen(function* () {
    const env: Record<string, string | undefined> = {
      FIREGRID_LAUNCH_ID: launch.launchId,
    }
    const secrets = yield* SecretResolver
    for (const binding of launch.bindings ?? []) {
      if (binding.kind === "env") {
        env[binding.name] = getPlaneField(launch, binding)
        continue
      }
      if (binding.kind === "env-secret") {
        const resource = yield* secretResourceForBinding(launch, binding)
        const secret = yield* secrets.resolve(resource.ref)
        // firegrid-durable-launch-runtime-operator.SECRET_BINDINGS.2
        env[binding.name] = Redacted.value(secret)
      }
    }
    return env
  })
