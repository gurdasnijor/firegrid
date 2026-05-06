#!/usr/bin/env tsx
import {
  OperationEnvelopeSchema,
  deriveReadyWork,
  rebuildProjection,
  type CompletionValue,
  type EventStreamValue,
  type ProjectionSnapshot,
  type RunValue,
} from "@firegrid/substrate/kernel"
import { Schema } from "effect"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"

interface RunInspection {
  readonly runId: string
  readonly state: RunValue["state"]
  readonly operation?: string
  readonly blockedOnCompletionId?: string
  readonly result?: unknown
  readonly error?: unknown
}

interface CompletionInspection {
  readonly completionId: string
  readonly kind: CompletionValue["kind"]
  readonly state: CompletionValue["state"]
  readonly workId?: string
  readonly trigger?: unknown
  readonly dueAtMs?: number
  readonly deadlineAtMs?: number
  readonly whenMs?: number
  readonly result?: unknown
  readonly error?: unknown
  readonly terminalReason?: unknown
}

interface EventStreamInspection {
  readonly key: string
  readonly stream: string
  readonly event: EventStreamValue["event"]
}

export interface ScenarioInspection {
  readonly streamUrl: string
  readonly foldVersion: number
  readonly counts: {
    readonly runs: number
    readonly completions: number
    readonly claimAttempts: number
    readonly eventStreams: number
    readonly readyWork: number
  }
  readonly runs: ReadonlyArray<RunInspection>
  readonly completions: ReadonlyArray<CompletionInspection>
  readonly readyWork: ReadonlyArray<{
    readonly runId: string
    readonly completionId: string
    readonly result: unknown
  }>
  readonly eventStreams: ReadonlyArray<EventStreamInspection>
}

const byStringKey = <A, K extends keyof A>(key: K) =>
  (left: A, right: A) =>
    String(left[key]).localeCompare(String(right[key]))

const optionalRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined

const operationOf = (run: RunValue): string | undefined =>
  Schema.is(OperationEnvelopeSchema)(run.data)
    ? run.data.operation
    : undefined

const inspectRun = (run: RunValue): RunInspection => ({
  runId: run.runId,
  state: run.state,
  operation: operationOf(run),
  blockedOnCompletionId: run.blockedOnCompletionId,
  result: run.result,
  error: run.error,
})

const inspectCompletion = (
  completion: CompletionValue,
): CompletionInspection => {
  const data = optionalRecord(completion.data)
  return {
    completionId: completion.completionId,
    kind: completion.kind,
    state: completion.state,
    workId: completion.workId,
    trigger: data?.trigger,
    dueAtMs: optionalNumber(data?.dueAtMs),
    deadlineAtMs: optionalNumber(data?.deadlineAtMs),
    whenMs: optionalNumber(data?.whenMs),
    result: completion.result,
    error: completion.error,
    terminalReason: completion.terminalReason,
  }
}

export const inspectSnapshot = (
  streamUrl: string,
  snapshot: ProjectionSnapshot,
): ScenarioInspection => {
  const readyWork = deriveReadyWork(snapshot)
  return {
    streamUrl,
    foldVersion: snapshot.foldVersion,
    counts: {
      runs: snapshot.runs.size,
      completions: snapshot.completions.size,
      claimAttempts: snapshot.claimAttempts.size,
      eventStreams: snapshot.eventStreams.size,
      readyWork: readyWork.readyWork.size,
    },
    runs: Array.from(snapshot.runs.values())
      .map(inspectRun)
      .sort(byStringKey("runId")),
    completions: Array.from(snapshot.completions.values())
      .map(inspectCompletion)
      .sort(byStringKey("completionId")),
    readyWork: Array.from(readyWork.readyWork.values())
      .sort(byStringKey("runId")),
    eventStreams: Array.from(snapshot.eventStreams.entries())
      .map(([key, value]) => ({
        key,
        stream: value.stream,
        event: value.event,
      }))
      .sort(byStringKey("key")),
  }
}

export const inspectScenarioStream = async (
  streamUrl: string,
): Promise<ScenarioInspection> => {
  // firegrid-runtime-process.SCENARIOS.5
  // launchable-substrate-host.LAB_INSPECTOR.4
  // launchable-substrate-host.NO_CONTROL_PLANE.4
  // launchable-substrate-host.NO_CONTROL_PLANE.5
  const snapshot = await rebuildProjection({ url: streamUrl })
  return inspectSnapshot(streamUrl, snapshot)
}

const streamUrlFromArgs = (): string | undefined => {
  const { values } = parseArgs({
    options: {
      "stream-url": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })
  return values["stream-url"] ?? process.env.DURABLE_STREAMS_URL
}

const main = async () => {
  const streamUrl = streamUrlFromArgs()
  if (streamUrl === undefined || streamUrl.length === 0) {
    process.stderr.write(
      "Usage: pnpm --filter @firegrid/scenarios run inspect -- --stream-url <durable-stream-url>\n",
    )
    process.exitCode = 1
    return
  }

  const inspection = await inspectScenarioStream(streamUrl)
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
