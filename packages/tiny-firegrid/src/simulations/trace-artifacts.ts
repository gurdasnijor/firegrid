import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { RecordedSpan } from "./trace-recorder.ts"

interface TinyTraceObservedSummary {
  readonly [key: string]: unknown
}

interface TinyTraceArtifactInput {
  readonly configuration: string
  readonly source: string
  readonly summary: TinyTraceObservedSummary
  readonly localization?: ReadonlyArray<string>
  readonly spans: ReadonlyArray<RecordedSpan>
  readonly fibers: ReadonlyArray<{ readonly id: string; readonly status: string }>
  readonly runId?: string
  readonly runDir?: string
  readonly rootDir?: string
  readonly markdownTitle?: string
  readonly legacyArtifacts?: {
    readonly markdownPath?: string
    readonly jsonPath?: string
  }
}

export interface TinyTraceArtifactPaths {
  readonly runId: string
  readonly runDir: string
  readonly markdownPath: string
  readonly jsonPath: string
  readonly liveSpansJsonlPath: string
  readonly otlpJsonlPath: string
  readonly duckdbSqlPath: string
  readonly duckdbDatabasePath: string
}

const defaultArtifactRoot = (): string =>
  path.resolve(
    globalThis.process.cwd(),
    "../../tooling/analysis/tiny-firegrid-traces",
  )

export const sanitizeTinyTracePathSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-")

const defaultRunId = (configuration: string): string =>
  `${sanitizeTinyTracePathSegment(configuration)}-${new Date().toISOString().replace(/[:.]/g, "-")}`

const attributePrefixes = [
  "firegrid.context",
  "firegrid.mcp",
  "firegrid.acp",
  "firegrid.runtime",
  "firegrid.codec",
  "firegrid.process",
  "firegrid.command",
  "firegrid.agent_input",
  "firegrid.agent_output",
  "firegrid.workflow",
  "firegrid.wait",
  "firegrid.durable_table",
  "firegrid.input",
  "firegrid.control",
  "firegrid.permission",
  "firegrid.agent_tool",
] as const

const spanAttributeVisibleInTree = (key: string): boolean =>
  attributePrefixes.some(prefix => key.startsWith(prefix))

const spanTreeLines = (
  spans: ReadonlyArray<RecordedSpan>,
): ReadonlyArray<string> => {
  const byParent = new Map<string | undefined, Array<RecordedSpan>>()
  for (const span of spans) {
    const bucket = byParent.get(span.parentSpanId) ?? []
    bucket.push(span)
    byParent.set(span.parentSpanId, bucket)
  }
  const lines: Array<string> = []
  const walk = (span: RecordedSpan, depth: number) => {
    const attrs = Object.entries(span.attributes)
      .filter(([key]) => spanAttributeVisibleInTree(key))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ")
    lines.push(`${"  ".repeat(depth)}- ${span.name} [${span.kind}/${span.status}]${attrs.length === 0 ? "" : ` ${attrs}`}`)
    for (const child of byParent.get(span.spanId) ?? []) {
      walk(child, depth + 1)
    }
  }
  for (const root of byParent.get(undefined) ?? []) walk(root, 0)
  return lines
}

const otlpAnyValue = (
  value: unknown,
): Record<string, unknown> => {
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number" && Number.isInteger(value)) {
    return { intValue: String(value) }
  }
  if (typeof value === "number") return { doubleValue: value }
  if (typeof value === "bigint") return { intValue: value.toString() }
  if (typeof value === "string") return { stringValue: value }
  if (value === null || value === undefined) return { stringValue: String(value) }
  return { stringValue: JSON.stringify(value) }
}

const otlpAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<{ readonly key: string; readonly value: Record<string, unknown> }> =>
  Object.entries(attributes).map(([key, value]) => ({
    key,
    value: otlpAnyValue(value),
  }))

const otlpSpanKind = (kind: RecordedSpan["kind"]): number => {
  switch (kind) {
    case "server":
      return 2
    case "client":
      return 3
    case "producer":
      return 4
    case "consumer":
      return 5
    case "internal":
      return 1
  }
}

const otlpTraceDocument = (
  input: Pick<TinyTraceArtifactInput, "configuration" | "spans">,
) => ({
  resourceSpans: [
    {
      resource: {
        attributes: otlpAttributes({
          "service.name": "tiny-firegrid",
          "service.namespace": "firegrid",
          "firegrid.configuration": input.configuration,
        }),
      },
      scopeSpans: [
        {
          scope: {
            name: "firegrid.tiny-firegrid.trace-recorder",
            version: "0.0.0",
          },
          spans: input.spans.map(span => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId === undefined
              ? {}
              : { parentSpanId: span.parentSpanId }),
            name: span.name,
            kind: otlpSpanKind(span.kind),
            startTimeUnixNano: span.startTimeNanos,
            endTimeUnixNano: span.endTimeNanos,
            attributes: otlpAttributes(span.attributes),
            events: span.events.map(event => ({
              name: event.name,
              timeUnixNano: event.timeNanos,
              attributes: otlpAttributes(event.attributes),
            })),
            status: {
              code: span.status === "success" ? 1 : 2,
            },
          })),
        },
      ],
    },
  ],
})

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`

const duckdbLoadSql = (input: {
  readonly otlpJsonlPath: string
}) => [
  "INSTALL otlp FROM community;",
  "LOAD otlp;",
  "",
  "CREATE OR REPLACE TABLE tiny_firegrid_spans AS",
  `SELECT * FROM read_otlp_traces(${sqlString(input.otlpJsonlPath)});`,
  "",
  "CREATE OR REPLACE VIEW tiny_firegrid_span_summary AS",
  "SELECT",
  "  span_name,",
  "  count(*) AS span_count,",
  "  round(avg(duration) / 1000000.0, 3) AS avg_duration_ms,",
  "  round(max(duration) / 1000000.0, 3) AS max_duration_ms",
  "FROM tiny_firegrid_spans",
  "GROUP BY span_name",
  "ORDER BY span_count DESC, max_duration_ms DESC;",
  "",
  "CREATE OR REPLACE VIEW tiny_firegrid_failed_spans AS",
  "SELECT * FROM tiny_firegrid_spans WHERE status_code = 2;",
  "",
  "SELECT count(*) AS loaded_spans FROM tiny_firegrid_spans;",
  "SELECT * FROM tiny_firegrid_span_summary LIMIT 25;",
  "",
].join("\n")

const markdownContent = (
  input: TinyTraceArtifactInput,
  paths: TinyTraceArtifactPaths,
): string => [
  `# ${input.markdownTitle ?? "Tiny Firegrid Trace"}`,
  "",
  `Generated by \`${input.source}\` with an Effect-native in-memory tracer (\`Effect.withTracer\`) and \`Supervisor.track\`.`,
  "",
  "## Artifacts",
  "",
  `- Internal JSON: \`${paths.jsonPath}\``,
  `- OTLP JSONL for duckdb-otlp: \`${paths.otlpJsonlPath}\``,
  `- DuckDB loader SQL: \`${paths.duckdbSqlPath}\``,
  `- Suggested DuckDB database: \`${paths.duckdbDatabasePath}\``,
  "",
  "Load with:",
  "",
  "```bash",
  `duckdb ${paths.duckdbDatabasePath} -init ${paths.duckdbSqlPath}`,
  "```",
  "",
  "Then query:",
  "",
  "```sql",
  "SELECT * FROM tiny_firegrid_span_summary LIMIT 25;",
  "SELECT span_name, span_attributes FROM tiny_firegrid_spans WHERE span_name LIKE 'firegrid.%' LIMIT 25;",
  "```",
  "",
  "## Summary",
  "",
  ...Object.entries(input.summary).map(([key, value]) =>
    `- ${key}: ${JSON.stringify(value)}`),
  "",
  ...(input.localization === undefined
    ? []
    : [
      "## Localization",
      "",
      ...input.localization.map(line => `- ${line}`),
      "",
    ]),
  "## Span Tree",
  "",
  ...spanTreeLines(input.spans),
  "",
  "## Supervisor Snapshot",
  "",
  "```json",
  JSON.stringify(input.fibers, null, 2),
  "```",
  "",
  "## Raw Spans",
  "",
  "```json",
  JSON.stringify(input.spans, null, 2),
  "```",
  "",
].join("\n")

const writeArtifactSet = async (
  input: TinyTraceArtifactInput,
  paths: TinyTraceArtifactPaths,
): Promise<void> => {
  const spanTree = spanTreeLines(input.spans)
  const json = {
    configuration: input.configuration,
    runId: paths.runId,
    summary: input.summary,
    localization: input.localization ?? [],
    duckdb: {
      otlpJsonlPath: paths.otlpJsonlPath,
      loadSqlPath: paths.duckdbSqlPath,
      databasePath: paths.duckdbDatabasePath,
      example: `duckdb ${paths.duckdbDatabasePath} -init ${paths.duckdbSqlPath}`,
    },
    spanTree,
    fibers: input.fibers,
    spans: input.spans,
  }
  await mkdir(paths.runDir, { recursive: true })
  await mkdir(path.dirname(paths.duckdbSqlPath), { recursive: true })
  await writeFile(paths.markdownPath, markdownContent(input, paths))
  await writeFile(paths.jsonPath, JSON.stringify(json, null, 2))
  await writeFile(
    paths.otlpJsonlPath,
    `${JSON.stringify(otlpTraceDocument(input))}\n`,
  )
  await writeFile(paths.duckdbSqlPath, duckdbLoadSql(paths))
}

export const writeTinyFiregridTraceRun = async (
  input: TinyTraceArtifactInput,
): Promise<TinyTraceArtifactPaths> => {
  const runId = sanitizeTinyTracePathSegment(input.runId ?? defaultRunId(input.configuration))
  const rootDir = input.rootDir ?? defaultArtifactRoot()
  const runDir = input.runDir ?? path.join(rootDir, runId)
  const runPaths: TinyTraceArtifactPaths = {
    runId,
    runDir,
    markdownPath: path.join(runDir, "trace.md"),
    jsonPath: path.join(runDir, "trace.json"),
    liveSpansJsonlPath: path.join(runDir, "live-spans.jsonl"),
    otlpJsonlPath: path.join(runDir, "traces.otlp.jsonl"),
    duckdbSqlPath: path.join(runDir, "duckdb", "load.sql"),
    duckdbDatabasePath: path.join(runDir, "duckdb", "tiny-firegrid.duckdb"),
  }
  await writeArtifactSet(input, runPaths)
  if (input.legacyArtifacts?.markdownPath !== undefined) {
    await mkdir(path.dirname(input.legacyArtifacts.markdownPath), { recursive: true })
    await writeFile(input.legacyArtifacts.markdownPath, markdownContent(input, runPaths))
  }
  if (input.legacyArtifacts?.jsonPath !== undefined) {
    await mkdir(path.dirname(input.legacyArtifacts.jsonPath), { recursive: true })
    await writeFile(input.legacyArtifacts.jsonPath, JSON.stringify({
      summary: input.summary,
      localization: input.localization ?? [],
      duckdb: {
        otlpJsonlPath: runPaths.otlpJsonlPath,
        loadSqlPath: runPaths.duckdbSqlPath,
        databasePath: runPaths.duckdbDatabasePath,
      },
      spanTree: spanTreeLines(input.spans),
      fibers: input.fibers,
      spans: input.spans,
    }, null, 2))
  }
  return runPaths
}
