import { IdempotentProducer } from "@durable-streams/client"
import {
  RuntimeJournalEventSchema,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeLogLine,
} from "@firegrid/protocol/launch"
import type { Scope } from "effect"
import { Context, Effect, Layer, Schema } from "effect"
import { makeJsonDurableStream } from "../stream.ts"

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
  const stream = makeJsonDurableStream(options.streamUrl, options.contentType ?? "application/json")

  return Layer.succeed(
    RuntimeCaptureJournal,
    RuntimeCaptureJournal.of({
      openAttempt: attempt =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const errors: Array<Error> = []
            const producer = new IdempotentProducer(
              stream,
              producerIdFor(attempt),
              {
                autoClaim: true,
                lingerMs: options.lingerMs ?? 10,
                onError: error => {
                  errors.push(error)
                },
              },
            )

            const drainErrors = (
              op: string,
            ): Effect.Effect<void, RuntimeCaptureJournalError> =>
              errors.length === 0
                ? Effect.void
                : Effect.fail(mapProducerError(
                  op,
                  attempt.contextId,
                  errors.shift() ?? new Error("unknown runtime capture producer error"),
                ))

            return { producer, drainErrors }
          }),
          ({ producer }) =>
            Effect.tryPromise({
              try: () => producer.detach(),
              catch: cause => mapProducerError("runtime-capture.detach", attempt.contextId, cause),
            }).pipe(Effect.ignore),
        ).pipe(
          Effect.map(({ producer, drainErrors }) => {
            const appendOutput = (
              op: string,
              event: RuntimeJournalEvent,
            ): Effect.Effect<void, RuntimeCaptureJournalError> =>
              Effect.try({
                // firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.2
                try: () => producer.append(encodeJournalEvent(event)),
                catch: cause => mapProducerError(op, attempt.contextId, cause),
              }).pipe(Effect.zipRight(drainErrors(op)))

            return {
              write: row =>
                appendOutput(`runtime-capture.${row.source}`, journalEventForOutput(row)),
              flush: Effect.tryPromise({
                try: async () => {
                  await producer.flush()
                },
                catch: cause => mapProducerError("runtime-capture.flush", attempt.contextId, cause),
              }).pipe(Effect.zipRight(drainErrors("runtime-capture.flush"))),
            } satisfies RuntimeCaptureAttempt
          }),
        ),
    }),
  )
}
