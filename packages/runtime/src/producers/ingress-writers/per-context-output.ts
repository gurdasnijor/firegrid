import {
  type HostStreamPrefix,
  RuntimeOutputTable,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import type { DurableTableHeaders } from "effect-durable-operators"
import { Context, Effect, Option, Stream } from "effect"
import { stampRowOtel } from "@firegrid/protocol/otel"
import {
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
  type AgentOutputEvent,
} from "../../events/index.ts"
import { runtimeContextOutputTableLayerForContext as perContextRuntimeOutputTableLayer } from "../../channels/output-table-layer.ts"
import type { RuntimeAgentOutputAfterEvents } from "../../tables/runtime-output-public.ts"

// Runtime-side capability Tag wrapping `PerContextRuntimeOutputWriterService`.
// Hosts provide the Live for this Tag (host-sdk's
// `PerContextRuntimeOutputWriterLive` builds the service from the host's
// durable-streams base URL + headers); runtime-internal subscribers
// (`subscribers/runtime-control/control-request-side-effects.ts`,
// `subscribers/runtime-context-session/{raw,codec}-adapter.ts`) consume
// the Tag rather than passing the service value through R-channels.
//
// The Tag lives here, alongside the factory + interface, so runtime
// consumers do not need to import a host-sdk Tag. Host-sdk's binding
// Live retargets to this Tag in the tf-z8wq-follow runtime-session move
// (see `subscribers/runtime-context-session/README.md`).
export class PerContextRuntimeOutputWriter extends Context.Tag(
  "@firegrid/runtime/producers/PerContextRuntimeOutputWriter",
)<PerContextRuntimeOutputWriter, PerContextRuntimeOutputWriterService>() {}

// tf-bffo: the durable per-context RuntimeOutputTable wiring lives in the runtime
// (the privileged durable core), parameterized by plain host topology config.
// host-sdk only COMPOSES these factories into Layers by injecting RuntimeHostConfig
// + CurrentHostSession — it no longer owns the durable-state wiring.

export interface PerContextRuntimeOutputConfig {
  readonly durableStreamsBaseUrl: string
  readonly headers?: DurableTableHeaders
}

export interface PerContextRuntimeOutputWriterService {
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

const appendEventRow = (
  config: PerContextRuntimeOutputConfig,
  context: RuntimeContext,
  row: RuntimeEventRow,
) =>
  // tf-gc7: stamp `_otel` from the SHORT-LIVED `*.event.append` producer
  // span onto the row before upsert. wait-router consumers reading this
  // row downstream parent from THIS span (which exports promptly) instead
  // of the long-lived ambient stream subscription that wraps them — the
  // load-bearing producer-span lifetime fix.
  Effect.gen(function*() {
    const stamped = yield* stampRowOtel(row)
    const table = yield* RuntimeOutputTable
    return yield* table.events.upsert(stamped).pipe(Effect.as(stamped))
  }).pipe(
    Effect.provide(perContextRuntimeOutputTableLayer(config, context)),
    Effect.withSpan("firegrid.runtime_output.per_context.event.append", {
      kind: "producer",
      attributes: {
        // tf-ykd5 (annotation batch C): durable commit of an agent-output row
        // into RuntimeOutputTable.events — the single-authority commit seam for
        // that table family.
        "firegrid.seam.kind": "durability",
        "firegrid.contract.id": "firegrid-runtime-agent-event-pipeline.AUTHORITIES.1",
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": row.activityAttempt,
        "firegrid.runtime.output.sequence": row.sequence,
      },
    }),
  )

export const makePerContextRuntimeOutputWriter = (
  config: PerContextRuntimeOutputConfig,
): PerContextRuntimeOutputWriterService => ({
  appendAgentEvent: (context, activityAttempt, sequence, event) =>
    appendEventRow(config, context, {
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
  appendEventRow: (context, row) => appendEventRow(config, context, row),
  appendLogLine: (context, row) =>
    // tf-gc7: stamp _otel for symmetry with appendEventRow.
    Effect.gen(function*() {
      const stamped = yield* stampRowOtel(row)
      const table = yield* RuntimeOutputTable
      return yield* table.logs.upsert(stamped).pipe(Effect.as(stamped))
    }).pipe(
      Effect.provide(perContextRuntimeOutputTableLayer(config, context)),
      Effect.withSpan("firegrid.runtime_output.per_context.log.append", {
        kind: "producer",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.runtime.activity_attempt": row.activityAttempt,
          "firegrid.runtime.output.sequence": row.sequence,
        },
      }),
    ),
})

export const makePerContextRuntimeAgentOutputAfterEvents = (
  config: PerContextRuntimeOutputConfig,
  streamPrefix: HostStreamPrefix,
): RuntimeAgentOutputAfterEvents["Type"] => ({
  initial: source =>
    Effect.map(
      RuntimeOutputTable,
      table =>
        table.events.query((coll) => {
          let selected: ReturnType<typeof runtimeAgentOutputObservationFromRow> = Option.none()
          const candidates = coll.toArray
          let index = 0
          while (index < candidates.length) {
            const candidate = candidates[index]!
            const decoded = runtimeAgentOutputObservationFromRow(candidate)
            if (
              Option.isSome(decoded) &&
              decoded.value.contextId === source.contextId &&
              decoded.value.activityAttempt === source.activityAttempt &&
              decoded.value.sequence > source.afterSequence &&
              (Option.isNone(selected) || decoded.value.sequence < selected.value.sequence)
            ) {
              selected = decoded
            }
            index += 1
          }
          return Option.getOrUndefined(selected)
        }).pipe(
          Effect.map(Option.fromNullable),
        ),
    ).pipe(
      Effect.flatten,
      Effect.provide(perContextRuntimeOutputTableLayer(config, {
        contextId: source.contextId,
        host: { streamPrefix },
      })),
      Effect.withSpan("firegrid.runtime_output.per_context.agent_output.initial", {
        kind: "internal",
        attributes: {
          // tf-ykd5 (annotation batch C): replay-path output-observation read.
          // Must stay replay-safe / bounded O(outputs) (the tf-7kq8/tf-aseo
          // storm invariant) — crosses the durability/replay seam.
          "firegrid.seam.kind": "durability",
          "firegrid.contract.id": "firegrid-workflow-driven-runtime.VALIDATION.10-1",
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
      Stream.provideLayer(perContextRuntimeOutputTableLayer(config, {
        contextId: source.contextId,
        host: { streamPrefix },
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
  forContext: contextId =>
    Stream.unwrap(
      Effect.map(RuntimeOutputTable, table =>
        table.events.rows().pipe(
          Stream.filterMap(runtimeAgentOutputObservationFromRow),
        )),
    ).pipe(
      Stream.provideLayer(perContextRuntimeOutputTableLayer(config, {
        contextId,
        host: { streamPrefix },
      })),
      Stream.withSpan("firegrid.runtime_output.per_context.agent_output.for_context", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": contextId,
        },
      }),
    ),
})
