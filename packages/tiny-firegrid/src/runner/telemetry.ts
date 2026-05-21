import {
  FiregridOtelLive,
} from "@firegrid/observability/node"
import type {
  FiregridOtelDestination,
  FiregridOtelResource,
  SpanProcessor,
} from "@firegrid/observability/node"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Layer } from "effect"
import type { TinyFiregridSimulation } from "../types.ts"

// Run-provenance attributes (Item E of the §6 observability batch).
// Resolved once at module load — they identify the binary that produced the
// trace, independent of the run. Failures are silently degraded to undefined:
// a non-git checkout or a sandboxed environment is a normal condition, not
// an error, and the trace stays useful without the attributes.
const safeExecSync = (cmd: string): string | undefined => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
  } catch {
    return undefined
  }
}

const pkgVersion = (): string | undefined => {
  try {
    const pkgPath = path.resolve(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
    )
    const json = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
    return json.version
  } catch {
    return undefined
  }
}

const provenanceAttributes: Record<string, string> = (() => {
  const commit = safeExecSync("git rev-parse HEAD")
  const branch = safeExecSync("git rev-parse --abbrev-ref HEAD")
  const version = pkgVersion()
  const entries: Array<readonly [string, string]> = []
  if (commit !== undefined) entries.push(["firegrid.git.commit", commit])
  if (branch !== undefined && branch !== "HEAD") entries.push(["firegrid.git.branch", branch])
  if (version !== undefined) entries.push(["firegrid.tiny_firegrid.version", version])
  return Object.fromEntries(entries)
})()

const resource = (
  simulation: TinyFiregridSimulation<unknown>,
  runId: string,
  options: {
    readonly namespace: string
    readonly durableStreamsBaseUrl: string
  },
): FiregridOtelResource => ({
  serviceName: "tiny-firegrid",
  attributes: {
    "firegrid.simulation.id": simulation.id,
    "firegrid.run.id": runId,
    "firegrid.namespace": options.namespace,
    "firegrid.durable_streams.base_url": options.durableStreamsBaseUrl,
    "firegrid.process.role": "tiny-firegrid",
    ...provenanceAttributes,
  },
})

// `firegrid.side` carries the value we want to filter on more than the
// hyphen-named OTel `service.namespace` does, so we leave it as a span
// attribute (propagated via `Effect.annotateSpans` in runner/side.ts).
export type TelemetryDestination = FiregridOtelDestination

// Routing precedence:
//   1. OTEL_EXPORTER_OTLP_ENDPOINT set → send to OTLP HTTP (production
//      observability backend; everything else is ignored).
//   2. destination._tag === "console" → ConsoleSpanExporter (opt-in via
//      --console; noisy, multi-paragraph util.inspect output, but
//      occasionally useful when there's no good place to write a file).
//   3. default → file destination — one JSON line per span at filePath.
export const TelemetryLive = (
  simulation: TinyFiregridSimulation<unknown>,
  runId: string,
  options: {
    readonly namespace: string
    readonly durableStreamsBaseUrl: string
    readonly destination: TelemetryDestination
    readonly heartbeatProcessor: SpanProcessor | undefined
  },
): Layer.Layer<never, unknown> =>
  FiregridOtelLive({
    resource: resource(simulation, runId, options),
    destination: options.destination,
    spanProcessors: options.heartbeatProcessor === undefined
      ? []
      : [options.heartbeatProcessor],
  })
