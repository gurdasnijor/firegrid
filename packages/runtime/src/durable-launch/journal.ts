import type {
  RuntimeLaunchRequest,
  RuntimeProvider,
} from "@firegrid/protocol/launch"
import { Effect } from "effect"
import type { ProcessOutputChunk } from "./execution/sandbox.ts"
import { mapLaunchError, type RuntimeLaunchError } from "./errors.ts"
import {
  journalRowId,
  processAttemptId,
  processEventId,
} from "./ids.ts"
import type { RuntimeLaunchDbService } from "./store.ts"

const nowIso = (): string => new Date().toISOString()

export const appendProcessEvent = (
  db: RuntimeLaunchDbService,
  options: {
    readonly launchId: string
    readonly activityAttempt: number
    readonly provider: RuntimeProvider
    readonly status: "started" | "exited" | "failed"
    readonly exitCode?: number
    readonly signal?: string
    readonly message?: string
  },
): Effect.Effect<void, RuntimeLaunchError> =>
  db.appendProcessEvent({
    processEventId: processEventId(options.launchId, options.activityAttempt, options.status),
    processAttemptId: processAttemptId(options.launchId, options.activityAttempt),
    launchId: options.launchId,
    activityAttempt: options.activityAttempt,
    status: options.status,
    at: nowIso(),
    provider: options.provider,
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.message === undefined ? {} : { message: options.message }),
  }).pipe(
    mapLaunchError(`journal.process.${options.status}`, "failed to append process event row", options.launchId),
  )

export const journalOutputChunk = (
  db: RuntimeLaunchDbService,
  launch: RuntimeLaunchRequest,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<void, RuntimeLaunchError> => {
  const rule = launch.runtime.journal.find(candidate => candidate.source === chunk.channel)
  if (rule === undefined) return Effect.void
  const receivedAt = nowIso()
  if (rule.stream === "provider-wire" && rule.format === "jsonl" && chunk.channel === "stdout") {
    // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.1
    // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.3
    return db.appendProviderWireRow({
      providerWireRowId: journalRowId(launch.launchId, activityAttempt, "provider-wire", sequence),
      launchId: launch.launchId,
      activityAttempt,
      sequence,
      channel: "stdout",
      format: "jsonl",
      stream: "provider-wire",
      receivedAt,
      raw: chunk.text,
    }).pipe(
      mapLaunchError("journal.provider-wire", "failed to append provider-wire row", launch.launchId),
    )
  }
  if (rule.stream === "diagnostics" && rule.format === "text-lines" && chunk.channel === "stderr") {
    // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.2
    return db.appendDiagnosticRow({
      diagnosticRowId: journalRowId(launch.launchId, activityAttempt, "diagnostics", sequence),
      launchId: launch.launchId,
      activityAttempt,
      sequence,
      channel: "stderr",
      format: "text-lines",
      stream: "diagnostics",
      receivedAt,
      raw: chunk.text,
    }).pipe(
      mapLaunchError("journal.diagnostics", "failed to append diagnostics row", launch.launchId),
    )
  }
  return Effect.void
}
