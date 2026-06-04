/**
 * `bin/_resolve.ts` — the `CliEnv::load`/`init` analog (restate `cli/src/app.rs`):
 * ALL impure config resolution for the Node host lives here, at the gate-legal
 * `bin/` boundary. It reads `process.env`, resolves absolute OTel file paths
 * (`node:path`), and picks the embedded-vs-configured durable-streams backend
 * (`@durable-streams/server`) — then produces a single fully-resolved
 * `FiregridNodeHostOptions` bundle for the PURE `firegridNodeHost(...)`
 * composition (`@firegrid/runtime/node`).
 */

import {
  resolveFiregridOtelActiveExporter,
  resolveFiregridOtelFileDestination,
  type FiregridOtelDestination,
} from "@firegrid/observability/node"
import {
  type DurableStreams,
  DurableStreamsLive,
  type LaunchAuthorizedBinding,
} from "@firegrid/protocol/launch"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Data, Effect, Layer } from "effect"
import path from "node:path"
import { defaultProductionAdapterLayer } from "../unified/host.ts"
import { RuntimeEnvResolverPolicy } from "../sources/sandbox/secrets.ts"
import type { FiregridNodeHostOptions } from "../node.ts"

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

export const resolveFiregridCliCwd = (
  cwd: string | undefined,
): string | undefined =>
  cwd === undefined ? undefined : path.resolve(cwd)

/**
 * The embedded-vs-configured durable-streams backend choice (tf-yxdd (a)): when
 * `DURABLE_STREAMS_BASE_URL` is absent, fall back to a local-dev
 * `@durable-streams/server` whose lifecycle is scoped INTO the returned backend
 * Layer (acquired when the host Layer is built, stopped when its scope closes).
 * The server import is gate-legal here at the bin boundary.
 */
const resolveBackend = (namespace: string): Layer.Layer<DurableStreams> => {
  const configured = nonEmptyEnv("DURABLE_STREAMS_BASE_URL")
  if (configured !== undefined) {
    return DurableStreamsLive.configuredWith({ baseUrl: configured, namespace })
  }
  return Layer.unwrapScoped(
    Effect.gen(function*() {
      const server = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
          const baseUrl = await server.start()
          return { server, baseUrl }
        }),
        ({ server }) => Effect.promise(() => server.stop()),
      )
      return DurableStreamsLive.configuredWith({ baseUrl: server.baseUrl, namespace })
    }),
  )
}

/**
 * Resolve the OTel destination descriptor (absolute file path computed here via
 * `node:path`) and announce it on stderr. `undefined` ⇒ no OTel. OTLP-vs-file is
 * decided by `FiregridOtelLive` from env-config; this is the file/console
 * fallback descriptor it receives.
 */
const resolveOtel = (
  options: FiregridCliCompositionOptions,
): FiregridOtelDestination | undefined => {
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
    return { _tag: "file", filePath }
  }
  if (active._tag === "otlp") {
    process.stderr.write(`firegrid acp: writing OTEL spans to ${active.endpoint}\n`)
    return destination ?? { _tag: "console" }
  }
  return undefined
}

const envPolicyLayer = (
  authorizedBindings: ReadonlyArray<LaunchAuthorizedBinding> | undefined,
) =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: authorizedBindings ?? [],
    lookupEnv: (name) => process.env[name],
  })

/**
 * Resolve raw CLI options into the fully-resolved `FiregridNodeHostOptions`
 * bundle the pure `firegridNodeHost(...)` composition consumes. This is the only
 * place process/env/filesystem/durable-streams-server concerns live.
 */
export const resolveNodeHostOptions = (
  options: FiregridCliCompositionOptions,
): FiregridNodeHostOptions => {
  const namespace = options.namespace
    ?? nonEmptyEnv("FIREGRID_RUNTIME_NAMESPACE")
    ?? defaultNamespace()
  const otel = resolveOtel(options)
  return {
    spec: { namespace },
    adapter: defaultProductionAdapterLayer(envPolicyLayer(options.authorizedBindings)),
    backend: resolveBackend(namespace),
    ingress: { transport: "http", port: options.mcpPort ?? 0, path: "/mcp" },
    ...(otel === undefined ? {} : { otel }),
    devtools: nonEmptyEnv("FIREGRID_EFFECT_DEVTOOLS") !== undefined,
  }
}

export const programExitCode = (error: unknown): number =>
  error instanceof FiregridCliUsageError ? 2 : 1

export const renderError = (error: unknown): string => {
  if (error instanceof FiregridCliUsageError) return error.message
  return error instanceof Error ? error.message : String(error)
}
