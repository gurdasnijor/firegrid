import {
  openDurableStreamProducer,
  type DurableStreamProducerError,
} from "@firegrid/durable-streams"
import {
  RuntimeJournalEventSchema,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeLogLine,
} from "@firegrid/protocol/launch"
import type { Scope } from "effect"
import { Context, Effect, Layer, Schema } from "effect"

export type RuntimeOutputRow = RuntimeEvent | RuntimeLogLine

export class RuntimeCaptureJournalError extends Schema.TaggedError<RuntimeCaptureJournalError>()(
  "RuntimeCaptureJournalError",
  {
    op: Schema.String,
    contextId: Schema.optional(Schema.String),
    cause: Schema.Unknown,
  },
) {}

interface RuntimeCaptureJournalOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly lingerMs?: number
}

interface OpenAttemptOptions {
  readonly contextId: string
  readonly activityAttempt: number
}

interface RuntimeCaptureAttempt {
  readonly write: (
    row: RuntimeOutputRow,
  ) => Effect.Effect<void, RuntimeCaptureJournalError>
  readonly flush: Effect.Effect<void, RuntimeCaptureJournalError>
}

interface RuntimeCaptureJournalService {
  readonly openAttempt: (
    options: OpenAttemptOptions,
  ) => Effect.Effect<RuntimeCaptureAttempt, never, Scope.Scope>
}

export class RuntimeCaptureJournal extends Context.Tag("firegrid/runtime/RuntimeCaptureJournal")<
  RuntimeCaptureJournal,
  RuntimeCaptureJournalService
>() {}

const encodeJournalEvent = (
  event: RuntimeJournalEvent,
): string =>
  JSON.stringify(Schema.decodeUnknownSync(RuntimeJournalEventSchema)(event))

const mapProducerError = (
  op: string,
  contextId: string,
  cause: unknown,
): RuntimeCaptureJournalError =>
  new RuntimeCaptureJournalError({ op, contextId, cause })

const journalEventForOutput = (
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

const producerIdFor = (
  options: OpenAttemptOptions,
): string =>
  `firegrid-runtime-output:${options.contextId}:${options.activityAttempt}`

export const RuntimeCaptureJournalLive = (
  options: RuntimeCaptureJournalOptions,
) => {
  return Layer.succeed(
    RuntimeCaptureJournal,
    RuntimeCaptureJournal.of({
      openAttempt: attempt =>
        openDurableStreamProducer({
          streamUrl: options.streamUrl,
          contentType: options.contentType ?? "application/json",
          producerId: producerIdFor(attempt),
          lingerMs: options.lingerMs ?? 10,
        }).pipe(
          Effect.map(producer => {
            const mapDurableProducerError = (
              op: string,
            ) =>
              Effect.mapError((cause: DurableStreamProducerError) =>
                mapProducerError(op, attempt.contextId, cause))
            const appendOutput = (
              op: string,
              event: RuntimeJournalEvent,
            ): Effect.Effect<void, RuntimeCaptureJournalError> =>
              // firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.2
              producer.append(encodeJournalEvent(event)).pipe(mapDurableProducerError(op))

            return {
              write: row =>
                appendOutput(`runtime-capture.${row.source}`, journalEventForOutput(row)),
              flush: producer.flush.pipe(mapDurableProducerError("runtime-capture.flush")),
            } satisfies RuntimeCaptureAttempt
          }),
        ),
    }),
  )
}
