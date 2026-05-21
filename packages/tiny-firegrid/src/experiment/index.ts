import {
  Firegrid,
  type FiregridSessionHandle,
} from "@firegrid/client-sdk/firegrid"
import type {
  SessionCreateOrLoadInput,
  SessionHandlePromptInput,
} from "@firegrid/protocol/session-facade"
import type { ChannelRouteMetadata } from "@firegrid/protocol/channels/router"
import { Effect } from "effect"
import path from "node:path"
import {
  analyzePerf,
  formatPerfOutput,
  type PerfOptions,
  type PerfReport,
} from "../runner/perf.ts"
import {
  readTraceSpans,
  resolveRunDir,
  tracePathForRunDir,
  type SpanRecord,
} from "../runner/trace.ts"
import { formatShowOutput } from "../runner/show.ts"

export interface ExperimentParticipantPromptInput {
  readonly role: string
  readonly task: string
  readonly successCriteria?: ReadonlyArray<string>
  readonly channels?: ReadonlyArray<ChannelRouteMetadata>
  readonly notes?: ReadonlyArray<string>
}

export interface ExperimentParticipantSpec {
  readonly name: string
  readonly externalKey: SessionCreateOrLoadInput["externalKey"]
  readonly runtime: SessionCreateOrLoadInput["runtime"]
  readonly prompt: string | ((session: FiregridSessionHandle) => string)
  readonly createdBy?: string
  readonly inputId?: string
  readonly idempotencyKey?: string
  readonly autoApprovePermissions?: "allow" | "deny"
}

export interface LaunchedExperimentParticipant {
  readonly name: string
  readonly session: FiregridSessionHandle
  readonly prompt: string
}

export interface DurableRowSource<Row = unknown> {
  readonly name: string
  readonly rows: Effect.Effect<ReadonlyArray<Row>, unknown, never>
}

export interface DurableRowSet<Row = unknown> {
  readonly source: string
  readonly rows: ReadonlyArray<Row>
}

export interface ExperimentArtifactsOptions {
  readonly runId?: string
  readonly perf?: Partial<PerfOptions>
  readonly durableRows?: ReadonlyArray<DurableRowSource>
}

export interface NativePerfArtifact {
  readonly report: PerfReport
  readonly stdout: string
  readonly stderr?: string
}

export interface ExperimentArtifacts {
  readonly runId: string
  readonly runDir: string
  readonly tracePath: string
  readonly spans: ReadonlyArray<SpanRecord>
  readonly show: string
  readonly perf: NativePerfArtifact
  readonly durableRows: ReadonlyArray<DurableRowSet>
}

type AttributeMatcher =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | RegExp
  | ((value: unknown, span: SpanRecord) => boolean)

export interface SpanArtifactQuery {
  readonly name?: string | RegExp | ((name: string, span: SpanRecord) => boolean)
  readonly side?: string
  readonly statusCode?: number
  readonly attributes?: Readonly<Record<string, AttributeMatcher>>
}

export interface ArtifactAssertionResult {
  readonly pass: boolean
  readonly dimension: "trace" | "durable-row"
  readonly message: string
  readonly matches: number
}

export interface ExperimentAssertionFailed {
  readonly _tag: "ExperimentAssertionFailed"
  readonly result: ArtifactAssertionResult
}

const experimentAssertionFailed = (
  result: ArtifactAssertionResult,
): ExperimentAssertionFailed => ({
  _tag: "ExperimentAssertionFailed",
  result,
})

const defaultPerfOptions: PerfOptions = {
  top: 15,
  idleThresholdMs: 5_000,
  findingDraft: false,
  findingThresholdMs: 30_000,
}

const isRegExp = (value: unknown): value is RegExp =>
  value instanceof RegExp

const markdownList = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.map(item => `- ${item}`)

const formatChannelLine = (channel: ChannelRouteMetadata): string => {
  const verbs = channel.verbs.join(", ")
  const title = channel.title === undefined ? "" : `; ${channel.title}`
  const description = channel.description === undefined
    ? ""
    : `; ${channel.description}`
  return `- ${String(channel.target)} (${channel.direction}; verbs: ${verbs}${title}${description})`
}

export const describeExperimentChannels = (
  channels: ReadonlyArray<ChannelRouteMetadata>,
): string =>
  channels.length === 0
    ? "No Firegrid channels were advertised for this participant."
    : ["Available Firegrid channels:", ...channels.map(formatChannelLine)].join("\n")

export const participantPrompt = (
  input: ExperimentParticipantPromptInput,
): string => {
  const sections: Array<readonly [string, string]> = [
    ["Role:", input.role],
    ["Task:", input.task],
  ]
  if (input.successCriteria !== undefined && input.successCriteria.length > 0) {
    sections.push(["Success criteria:", markdownList(input.successCriteria).join("\n")])
  }
  if (input.notes !== undefined && input.notes.length > 0) {
    sections.push(["Notes:", markdownList(input.notes).join("\n")])
  }
  if (input.channels !== undefined) {
    sections.push(["Channel surface:", describeExperimentChannels(input.channels)])
  }

  return sections.map(([heading, body]) => `${heading}\n${body}`).join("\n\n")
}

export const launchExperimentParticipant = (
  spec: ExperimentParticipantSpec,
) =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: spec.externalKey,
      runtime: spec.runtime,
      ...(spec.createdBy === undefined ? {} : { createdBy: spec.createdBy }),
    })
    if (spec.autoApprovePermissions !== undefined) {
      yield* session.permissions.autoApprove(spec.autoApprovePermissions)
    }
    const prompt = typeof spec.prompt === "function"
      ? spec.prompt(session)
      : spec.prompt
    const request: SessionHandlePromptInput = {
      payload: prompt,
      ...(spec.inputId === undefined ? {} : { inputId: spec.inputId }),
      idempotencyKey: spec.idempotencyKey ??
        `${spec.externalKey.source}:${spec.externalKey.id}:prompt`,
    }
    yield* session.prompt(request)
    yield* session.start()
    return { name: spec.name, session, prompt } satisfies LaunchedExperimentParticipant
  }).pipe(
    Effect.withSpan("firegrid.tiny_experiment.participant.launch", {
      kind: "client",
      attributes: {
        "firegrid.tiny_experiment.participant": spec.name,
        "firegrid.external_key.source": spec.externalKey.source,
        "firegrid.external_key.id": spec.externalKey.id,
      },
    }),
  )

export const launchExperimentParticipants = (
  specs: ReadonlyArray<ExperimentParticipantSpec>,
) =>
  Effect.forEach(specs, launchExperimentParticipant, {
    concurrency: "unbounded",
  })

export const durableRowSource = <Row>(
  name: string,
  rows: Effect.Effect<ReadonlyArray<Row>, unknown, never>,
): DurableRowSource<Row> => ({ name, rows })

export const loadExperimentArtifacts = (
  options: ExperimentArtifactsOptions = {},
) =>
  Effect.gen(function*() {
    const runDir = yield* resolveRunDir(options.runId)
    const spans = yield* readTraceSpans(runDir)
    const tracePath = tracePathForRunDir(runDir)
    const perfOptions: PerfOptions = {
      ...defaultPerfOptions,
      ...options.perf,
    }
    const perfReport = analyzePerf(
      spans,
      perfOptions,
      path.basename(runDir),
      tracePath,
    )
    const perfOutput = formatPerfOutput(perfReport, perfOptions)
    const durableRows = yield* Effect.forEach(
      options.durableRows ?? [],
      (source: DurableRowSource) =>
        Effect.map(source.rows, (rows: ReadonlyArray<unknown>) => ({
          source: source.name,
          rows,
        }) satisfies DurableRowSet),
    )

    // public-experiment-ergonomics.NATIVE_ARTIFACTS.1
    // public-experiment-ergonomics.NATIVE_ARTIFACTS.2
    // public-experiment-ergonomics.NATIVE_ARTIFACTS.3
    return {
      runId: path.basename(runDir),
      runDir,
      tracePath,
      spans,
      show: formatShowOutput(runDir, spans),
      perf: {
        report: perfReport,
        stdout: perfOutput.stdout,
        ...(perfOutput.stderr === undefined ? {} : { stderr: perfOutput.stderr }),
      },
      durableRows,
    } satisfies ExperimentArtifacts
  })

const matchesName = (
  matcher: SpanArtifactQuery["name"],
  span: SpanRecord,
): boolean => {
  if (matcher === undefined) return true
  if (typeof matcher === "string") return span.name === matcher
  if (isRegExp(matcher)) return matcher.test(span.name)
  return matcher(span.name, span)
}

const matchesAttribute = (
  matcher: AttributeMatcher,
  value: unknown,
  span: SpanRecord,
): boolean => {
  if (typeof matcher === "function") return matcher(value, span)
  if (isRegExp(matcher)) return typeof value === "string" && matcher.test(value)
  return Object.is(value, matcher)
}

const spanMatchesQuery = (
  span: SpanRecord,
  query: SpanArtifactQuery,
): boolean => {
  if (!matchesName(query.name, span)) return false
  if (query.side !== undefined && span.attributes["firegrid.side"] !== query.side) {
    return false
  }
  if (query.statusCode !== undefined && span.status.code !== query.statusCode) {
    return false
  }
  const attributes = query.attributes ?? {}
  return Object.entries(attributes).every(([key, matcher]) =>
    matchesAttribute(matcher, span.attributes[key], span))
}

export const querySpans = (
  artifacts: Pick<ExperimentArtifacts, "spans">,
  query: SpanArtifactQuery,
): ReadonlyArray<SpanRecord> =>
  artifacts.spans.filter(span => spanMatchesQuery(span, query))

export const assertSpanExists = (
  artifacts: Pick<ExperimentArtifacts, "spans">,
  query: SpanArtifactQuery,
  message = "expected at least one native trace span to match",
): ArtifactAssertionResult => {
  const matches = querySpans(artifacts, query).length
  return {
    pass: matches > 0,
    dimension: "trace",
    message,
    matches,
  }
}

export const queryDurableRows = <Row = unknown>(
  artifacts: Pick<ExperimentArtifacts, "durableRows">,
  source: string,
  predicate: (row: Row) => boolean = () => true,
): ReadonlyArray<Row> =>
  (artifacts.durableRows.find(rows => rows.source === source)?.rows ?? [])
    .filter((row): row is Row => predicate(row as Row))

export const assertDurableRowExists = <Row = unknown>(
  artifacts: Pick<ExperimentArtifacts, "durableRows">,
  source: string,
  predicate: (row: Row) => boolean = () => true,
  message = `expected at least one native durable row in ${source} to match`,
): ArtifactAssertionResult => {
  const matches = queryDurableRows(artifacts, source, predicate).length
  return {
    pass: matches > 0,
    dimension: "durable-row",
    message,
    matches,
  }
}

export const requireAssertion = (
  result: ArtifactAssertionResult,
): Effect.Effect<void, ExperimentAssertionFailed> =>
  result.pass
    ? Effect.void
    : Effect.fail(experimentAssertionFailed(result))
