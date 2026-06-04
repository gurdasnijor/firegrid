import { FiregridOtelLive, resolveFiregridOtelActiveExporter, resolveFiregridOtelFileDestination } from "@firegrid/observability/node"
import {
  DurableStreamsLive,
  type LaunchAuthorizedBinding,
} from "@firegrid/protocol/launch"
import { Data, Effect, Layer, Logger } from "effect"
import * as DevTools from "@effect/experimental/DevTools"
import { DurableStreamTestServer } from "@durable-streams/server"
import path from "node:path"
import { defaultProductionAdapterLayer } from "../unified/host.ts"
import { firegridHost } from "../unified/host-entry.ts"
import { RuntimeEnvResolverPolicy } from "../sources/sandbox/secrets.ts"

export class FiregridCliUsageError extends Data.TaggedError("FiregridCliUsageError")<{
  readonly message: string
}> {}

export interface FiregridCliCompositionOptions {
  readonly cwd?: string
  readonly namespace?: string
  readonly otelFile?: string
  readonly mcpPort?: number
  readonly authorizedBindings?: ReadonlyArray<LaunchAuthorizedBinding>
}

const defaultNamespace = (): string => `firegrid-cli-${crypto.randomUUID()}`

const nonEmptyEnv = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value.trim() === "" ? undefined : value
}

const embeddedOrConfiguredDurableStreamsBaseUrl = Effect.gen(function*() {
  const configured = nonEmptyEnv("DURABLE_STREAMS_BASE_URL")
  if (configured !== undefined) return configured
  const server = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
      const baseUrl = await server.start()
      return { server, baseUrl }
    }),
    ({ server }) => Effect.promise(() => server.stop()),
  )
  return server.baseUrl
})

export const resolveFiregridCliCwd = (
  cwd: string | undefined,
): string | undefined =>
  cwd === undefined ? undefined : path.resolve(cwd)

const otelLayer = (
  options: FiregridCliCompositionOptions,
): Layer.Layer<never, unknown> => {
  const destination = resolveFiregridOtelFileDestination({
    ...(options.otelFile === undefined ? {} : { filePath: options.otelFile }),
    env: process.env,
    baseDir: options.cwd ?? process.cwd(),
  })
  const active = resolveFiregridOtelActiveExporter({
    destination,
    env: process.env,
  })
  if (active._tag === "file") {
    const filePath = path.resolve(active.filePath)
    process.stderr.write(`firegrid acp: writing OTEL spans to ${filePath}\n`)
    return FiregridOtelLive({
      resource: {
        serviceName: "firegrid-acp",
      },
      destination: {
        _tag: "file",
        filePath,
      },
    })
  }
  if (active._tag === "otlp") {
    process.stderr.write(`firegrid acp: writing OTEL spans to ${active.endpoint}\n`)
    return FiregridOtelLive({
      resource: {
        serviceName: "firegrid-acp",
      },
      destination: destination ?? {
        _tag: "console",
      },
    })
  }
  return Layer.empty
}

// Dev-only: stream this process's Effect spans to the VS Code "Effect Dev Tools"
// Tracer panel (ws://localhost:34437, the panel's default). Off unless
// FIREGRID_EFFECT_DEVTOOLS is set. `DevTools.layer()` is a `Layer<never>` that
// installs the Effect Tracer (Node 22+ provides the global WebSocket it needs);
// it does not add a context requirement. Use it INSTEAD of an active OTel
// exporter — both own the single Tracer slot — and only with the panel listening.
const devToolsLayer = (): Layer.Layer<never> =>
  nonEmptyEnv("FIREGRID_EFFECT_DEVTOOLS") !== undefined ? DevTools.layer() : Layer.empty

const envPolicyLayer = (
  authorizedBindings: ReadonlyArray<LaunchAuthorizedBinding> | undefined,
) =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: authorizedBindings ?? [],
    lookupEnv: (name) => process.env[name],
  })

export const FiregridCliCompositionLive = (
  options: FiregridCliCompositionOptions,
) =>
  Layer.unwrapScoped(
    Effect.gen(function*() {
      const durableStreamsBaseUrl = yield* embeddedOrConfiguredDurableStreamsBaseUrl
      const namespace = options.namespace ?? nonEmptyEnv("FIREGRID_RUNTIME_NAMESPACE") ?? defaultNamespace()
      // The single composition root composes FiregridRuntime + MCP ingress +
      // backend from data; the bin only resolves config and wraps the launchable
      // host with its observability edge.
      const host = firegridHost({
        spec: { namespace },
        adapter: defaultProductionAdapterLayer(envPolicyLayer(options.authorizedBindings)),
        backend: DurableStreamsLive.configuredWith({ baseUrl: durableStreamsBaseUrl, namespace }),
        ingress: { transport: "http", port: options.mcpPort ?? 0, path: "/mcp" },
      })
      return host.pipe(
        Layer.provideMerge(devToolsLayer()),
        Layer.provideMerge(otelLayer(options)),
        Layer.provide(Logger.remove(Logger.defaultLogger)),
        // The composition's only errors are infra-acquisition defects, surfaced
        // as an untyped `unknown`: OTel exporter setup (FiregridOtelLive) and the
        // MCP HTTP server bind (NodeHttpServer.layer inside FiregridMcpServerLayer).
        // orDie them at this composition boundary — a host that cannot acquire its
        // substrate is a startup defect, not a typed domain failure — so the bin's
        // edge stays launchable (E → never) without an `as unknown as` cast
        // (tf-0awo.21 §6). This is the cast's hidden error channel, made honest.
        Layer.orDie,
      )
    }),
  )

export const programExitCode = (error: unknown): number =>
  error instanceof FiregridCliUsageError ? 2 : 1

export const renderError = (error: unknown): string => {
  if (error instanceof FiregridCliUsageError) return error.message
  return error instanceof Error ? error.message : String(error)
}
