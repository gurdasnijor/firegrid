import {
  CurrentHostSession,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Context, Effect, Layer, Option, Stream } from "effect"
import {
  RuntimeAgentOutputAfterEvents,
} from "@firegrid/runtime/runtime-output"
import {
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import { RuntimeHostConfig } from "./config.ts"

interface PerContextRuntimeOutputWriterService {
  readonly appendAgentEvent: (
    context: RuntimeContext,
    activityAttempt: number,
    sequence: number,
    event: AgentOutputEvent,
  ) => Effect.Effect<RuntimeEventRow, unknown>
  readonly appendEventRow: (
    context: RuntimeContext,
    row: RuntimeEventRow,
  ) => Effect.Effect<RuntimeEventRow, unknown>
  readonly appendLogLine: (
    context: RuntimeContext,
    row: RuntimeLogLineRow,
  ) => Effect.Effect<RuntimeLogLineRow, unknown>
}

export class PerContextRuntimeOutputWriter extends Context.Tag(
  "@firegrid/host-sdk/PerContextRuntimeOutputWriter",
)<PerContextRuntimeOutputWriter, PerContextRuntimeOutputWriterService>() {}

const perContextRuntimeOutputTableLayer = (
  hostConfig: RuntimeHostConfig["Type"],
  context: {
    readonly contextId: string
    readonly host: Pick<RuntimeContext["host"], "streamPrefix">
  },
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: hostConfig.durableStreamsBaseUrl,
        prefix: context.host.streamPrefix,
        contextId: context.contextId,
      }),
      contentType: "application/json",
      ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
    },
  })

const appendEventRow = (
  hostConfig: RuntimeHostConfig["Type"],
  context: RuntimeContext,
  row: RuntimeEventRow,
) =>
  Effect.map(
    RuntimeOutputTable,
    table => table.events.upsert(row).pipe(Effect.as(row)),
  ).pipe(
    Effect.flatten,
    Effect.provide(perContextRuntimeOutputTableLayer(hostConfig, context)),
  )

export const PerContextRuntimeOutputWriterLive = Layer.effect(
  PerContextRuntimeOutputWriter,
  Effect.map(RuntimeHostConfig, hostConfig =>
    PerContextRuntimeOutputWriter.of({
      appendAgentEvent: (context, activityAttempt, sequence, event) =>
        appendEventRow(hostConfig, context, {
          eventId: {
            contextId: context.contextId,
            activityAttempt,
            target: "events",
            sequence,
          },
          contextId: context.contextId,
          activityAttempt,
          sequence,
          source: "stdout",
          format: "jsonl",
          receivedAt: new Date().toISOString(),
          raw: encodeRuntimeAgentOutputEnvelope(event),
        }),
      appendEventRow: (context, row) => appendEventRow(hostConfig, context, row),
      appendLogLine: (context, row) =>
        Effect.map(
          RuntimeOutputTable,
          table => table.logs.upsert(row).pipe(Effect.as(row)),
        ).pipe(
          Effect.flatten,
          Effect.provide(perContextRuntimeOutputTableLayer(hostConfig, context)),
        ),
    })),
)

export const PerContextRuntimeAgentOutputAfterEventsLive = Layer.effect(
  RuntimeAgentOutputAfterEvents,
  Effect.gen(function*() {
    const hostConfig = yield* RuntimeHostConfig
    const hostSession = yield* CurrentHostSession
    return RuntimeAgentOutputAfterEvents.of({
      initial: source =>
        Effect.map(
          RuntimeOutputTable,
          table =>
            table.events.query((coll) => {
              let selected: ReturnType<typeof runtimeAgentOutputObservationFromRow> = Option.none()
              for (const candidate of coll.toArray) {
                const decoded = runtimeAgentOutputObservationFromRow(candidate)
                if (Option.isNone(decoded)) continue
                if (
                  decoded.value.contextId !== source.contextId ||
                  decoded.value.activityAttempt !== source.activityAttempt ||
                  decoded.value.sequence <= source.afterSequence
                ) continue
                if (Option.isNone(selected) || decoded.value.sequence < selected.value.sequence) {
                  selected = decoded
                }
              }
              return Option.getOrUndefined(selected)
            }).pipe(
              Effect.map(Option.fromNullable),
            ),
        ).pipe(
          Effect.flatten,
          Effect.provide(perContextRuntimeOutputTableLayer(hostConfig, {
            contextId: source.contextId,
            host: { streamPrefix: hostSession.streamPrefix },
          })),
        ),
      after: source =>
        Stream.unwrap(
          Effect.map(RuntimeOutputTable, table =>
            table.events.rows().pipe(
              Stream.filterMap(runtimeAgentOutputObservationFromRow),
              Stream.filter((row) =>
                row.contextId === source.contextId &&
                row.activityAttempt === source.activityAttempt &&
                row.sequence > source.afterSequence),
            )),
        ).pipe(
          Stream.provideLayer(perContextRuntimeOutputTableLayer(hostConfig, {
            contextId: source.contextId,
            host: { streamPrefix: hostSession.streamPrefix },
          })),
        ),
    })
  }),
)
