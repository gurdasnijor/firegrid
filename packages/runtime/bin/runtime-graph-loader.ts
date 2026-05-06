import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Data, Effect, Layer } from "effect"
import type { RuntimeContext } from "../src/context.ts"

export type RuntimeGraphLayer = Layer.Layer<never, unknown, RuntimeContext>

export class RuntimeGraphLoadError extends Data.TaggedError(
  "firegrid/RuntimeGraphLoadError",
)<{
  readonly specifier: string
  readonly cause: unknown
}> {}

export class RuntimeGraphExportError extends Data.TaggedError(
  "firegrid/RuntimeGraphExportError",
)<{
  readonly specifier: string
  readonly reason: string
}> {}

const hasUrlProtocol = (specifier: string): boolean => {
  try {
    const parsed = new URL(specifier)
    return parsed.protocol.length > 0
  } catch {
    return false
  }
}

// firegrid-runtime-process.RUNTIME_GRAPH.1
export const resolveRuntimeGraphModuleSpecifier = (
  specifier: string,
): string => {
  if (hasUrlProtocol(specifier)) return specifier
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("..") ||
    isAbsolute(specifier)
  ) {
    return pathToFileURL(resolve(process.cwd(), specifier)).href
  }
  return specifier
}

interface RuntimeGraphModule {
  readonly default?: unknown
  readonly runtime?: unknown
}

// firegrid-runtime-process.RUNTIME_GRAPH.2
// firegrid-runtime-process.RUNTIME_GRAPH.4
export const runtimeGraphFromModule = (
  specifier: string,
  module: RuntimeGraphModule,
): Effect.Effect<RuntimeGraphLayer, RuntimeGraphExportError> => {
  const candidate = module.runtime ?? module.default
  if (candidate === undefined) {
    return Effect.fail(
      new RuntimeGraphExportError({
        specifier,
        reason: "expected a named `runtime` export or default export",
      }),
    )
  }
  if (!Layer.isLayer(candidate)) {
    return Effect.fail(
      new RuntimeGraphExportError({
        specifier,
        reason: "runtime export must be an Effect Layer",
      }),
    )
  }
  return Effect.succeed(candidate as RuntimeGraphLayer)
}

// firegrid-runtime-process.RUNTIME_GRAPH.1
// firegrid-runtime-process.RUNTIME_GRAPH.4
export const loadRuntimeGraph = (
  specifier: string,
): Effect.Effect<
  RuntimeGraphLayer,
  RuntimeGraphLoadError | RuntimeGraphExportError
> =>
  Effect.tryPromise({
    try: () =>
      import(
        resolveRuntimeGraphModuleSpecifier(specifier),
      ) as Promise<RuntimeGraphModule>,
    catch: (cause) => new RuntimeGraphLoadError({ specifier, cause }),
  }).pipe(
    Effect.flatMap((module) => runtimeGraphFromModule(specifier, module)),
  )
