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
    Effect.withSpan("firegrid.runtime_output.per_context.event.append", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": row.activityAttempt,
        "firegrid.runtime.output.sequence": row.sequence,
      },
    }),
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
          Effect.withSpan("firegrid.runtime_output.per_context.log.append", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": context.contextId,
              "firegrid.runtime.activity_attempt": row.activityAttempt,
              "firegrid.runtime.output.sequence": row.sequence,
            },
          }),
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
          Effect.withSpan("firegrid.runtime_output.per_context.agent_output.initial", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": source.contextId,
              "firegrid.runtime.activity_attempt": source.activityAttempt,
              "firegrid.runtime.output.after_sequence": source.afterSequence,
            },
          }),
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
          Stream.withSpan("firegrid.runtime_output.per_context.agent_output.after", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": source.contextId,
              "firegrid.runtime.activity_attempt": source.activityAttempt,
              "firegrid.runtime.output.after_sequence": source.afterSequence,
            },
          }),
        ),
      // firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
      //
      // Whole-context observation backing the non-After `AgentOutput`
      // wait source: the per-context output stream is already scoped to
      // one context, so this streams every decoded observation on it
      // (all attempts, includeInitialState replay included). The wait
      // router's `evaluateFieldEquals` applies the trigger predicates —
      // the redundant contextId predicate is harmless.
      forContext: contextId =>
        Stream.unwrap(
          Effect.map(RuntimeOutputTable, table =>
            table.events.rows().pipe(
              Stream.filterMap(runtimeAgentOutputObservationFromRow),
            )),
        ).pipe(
          Stream.provideLayer(perContextRuntimeOutputTableLayer(hostConfig, {
            contextId,
            host: { streamPrefix: hostSession.streamPrefix },
          })),
          Stream.withSpan("firegrid.runtime_output.per_context.agent_output.for_context", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": contextId,
            },
          }),
        ),
    })
  }),
)
