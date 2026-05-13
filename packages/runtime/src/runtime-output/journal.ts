import { FetchHttpClient, type HttpClient } from "@effect/platform"
import {
  RuntimeJournalEventSchema,
  runtimeOutputRowId,
  type RuntimeContext,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeLogLine,
} from "@firegrid/protocol/launch"
import type { Scope } from "effect"
import { Effect } from "effect"
import type { DurableStream as DurableStreamType } from "effect-durable-streams"
import { DurableStream } from "effect-durable-streams"
import type { ProcessOutputChunk } from "../providers/sandboxes/index.ts"
import {
  asRuntimeContextError,
  type RuntimeContextError,
} from "../runtime-host/errors.ts"

type RuntimeOutputRow = RuntimeEvent | RuntimeLogLine

const nowIso = (): string => new Date().toISOString()

const runtimeJournalEventForOutput = (
  row: RuntimeOutputRow,
): RuntimeJournalEvent =>
  row.source === "stdout"
    ? {
      type: "firegrid.runtime.output.stdout",
      id: row.eventId,
      at: row.receivedAt,
      event: row,
    }
    : {
      type: "firegrid.runtime.output.stderr",
      id: row.logLineId,
      at: row.receivedAt,
      log: row,
    }

const mapRuntimeOutputError = (
  contextId: string,
) =>
  Effect.mapError((cause: DurableStreamType.ProducerFailure) =>
    asRuntimeContextError(
      "runtime-output.write",
      "failed to write runtime data-plane journal event",
      contextId,
      cause,
    ))

const outputRowFromChunk = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<RuntimeOutputRow, RuntimeContextError> => {
  const rule = context.runtime.journal.find(candidate => candidate.source === chunk.channel)
  if (rule === undefined) {
    return Effect.fail(asRuntimeContextError(
      "runtime-output.no-journal-rule",
      `no runtime journal rule for ${chunk.channel}`,
      context.contextId,
    ))
  }

  const receivedAt = nowIso()
  if (rule.target === "events" && rule.format === "jsonl" && chunk.channel === "stdout") {
    return Effect.succeed({
      eventId: runtimeOutputRowId(context.contextId, activityAttempt, "events", sequence),
      contextId: context.contextId,
      activityAttempt,
      sequence,
      source: "stdout",
      format: "jsonl",
      receivedAt,
      raw: chunk.text,
    })
  }

  if (rule.target === "logs" && rule.format === "text-lines" && chunk.channel === "stderr") {
    return Effect.succeed({
      logLineId: runtimeOutputRowId(context.contextId, activityAttempt, "logs", sequence),
      contextId: context.contextId,
      activityAttempt,
      sequence,
      source: "stderr",
      format: "text-lines",
      receivedAt,
      raw: chunk.text,
    })
  }

  return Effect.fail(asRuntimeContextError(
    "runtime-output.invalid-journal-rule",
    `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
    context.contextId,
  ))
}

interface RuntimeOutputJournal {
  readonly appendChunk: (
    sequence: number,
    chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
  ) => Effect.Effect<void, RuntimeContextError>
  readonly flush: Effect.Effect<void, RuntimeContextError>
}

export const makeRuntimeOutputJournal = (
  streamUrl: string,
  context: RuntimeContext,
  activityAttempt: number,
): Effect.Effect<RuntimeOutputJournal, RuntimeContextError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function* () {
    const stream = DurableStream.define({
      endpoint: { url: streamUrl },
      schema: RuntimeJournalEventSchema,
    })
    yield* stream.create({ contentType: "application/json" }).pipe(
      Effect.catchTag("DurableStream/Conflict", () => Effect.void),
      mapRuntimeOutputError(context.contextId),
    )
    const producer = yield* stream.producer({
      producerId: `firegrid-runtime-output:${context.contextId}:${activityAttempt}`,
      lingerMs: 10,
    }).pipe(mapRuntimeOutputError(context.contextId))

    return {
      appendChunk: (sequence, chunk) =>
        outputRowFromChunk(context, activityAttempt, sequence, chunk).pipe(
          Effect.flatMap(row =>
            producer.append(runtimeJournalEventForOutput(row)).pipe(
              mapRuntimeOutputError(context.contextId),
              Effect.asVoid,
            )),
        ),
      flush: producer.flush.pipe(
        mapRuntimeOutputError(context.contextId),
        Effect.asVoid,
      ),
    } satisfies RuntimeOutputJournal
  }).pipe(Effect.provide(FetchHttpClient.layer))
