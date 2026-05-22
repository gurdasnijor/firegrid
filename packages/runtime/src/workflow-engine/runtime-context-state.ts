// tf-aseo (Phase 0C): workflow-owned durable loop state for the runtime-context
// workflow body.
//
// The merged event loop in `workflows/runtime-context.ts` used to keep its
// progress (input/output cursors, pending-permission sets, exit evidence) in an
// in-memory `Ref` reset to `initial` at the top of every execution. Because the
// @effect/workflow body re-runs top-to-bottom on every replay/resume, that state
// had to be rebuilt by re-walking the output history through memoized transition
// activities — the O(replays * history) re-walk behind the tf-7kq8 storm
// (`docs/investigations/2026-05-22-tf-aseo-output-cursor-cutover-blocker.md`).
//
// This module makes that state a workflow-owned durable row keyed by
// `(contextId, activityAttempt)`. The body loads state once per execution and
// advances it as events are consumed, so a replay reconstructs progress with a
// single point read instead of re-walking — and output observation is a point
// `get` at `lastProcessedOutputSequence + 1`, never a full-table scan
// (`firegrid-no-replay-path-output-scan`; SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE
// INV-1/INV-3, "replay reconstructs progress from table state").
//
// The state row and the next-output point read are both per-context. They are
// exposed to the body through a single `RuntimeContextStateStore` capability tag
// so the body never holds `RuntimeAgentOutputAfterEvents` (the scan/stream
// authority) or a `DurableTable` handle directly.

import {
  durableStreamUrl,
  type HostStreamPrefix,
  RuntimeOutputTable,
  runtimeContextOutputStreamName,
  runtimeContextOutputStreamUrl,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressInputRowSchema,
} from "@firegrid/protocol/runtime-ingress"
import { runtimeAgentOutputObservationFromRow } from "@firegrid/protocol/session-facade"
import type { DurableTableHeaders } from "effect-durable-operators"
import { DurableTable } from "effect-durable-operators"
import { Context, Effect, Layer, Option, Ref, Schema, type Scope } from "effect"
import {
  AgentInputEventSchema,
  type RuntimeAgentOutputObservation,
} from "../agent-event-pipeline/events/index.ts"
import { RuntimeExitEvidence as RuntimeExitEvidenceSchema } from "./workflows/runtime-context-run.ts"

// ---------------------------------------------------------------------------
// Loop state (moved from workflows/runtime-context.ts so the durable row and
// the body share one schema source of truth).
// ---------------------------------------------------------------------------

const PendingPermissionResponseSchema = Schema.Struct({
  permissionRequestId: Schema.String,
  row: RuntimeIngressInputRowSchema,
  event: AgentInputEventSchema,
})
export type PendingPermissionResponse = Schema.Schema.Type<typeof PendingPermissionResponseSchema>

export const RuntimeContextEventStateSchema = Schema.Struct({
  lastProcessedInputSequence: Schema.Number,
  lastProcessedOutputSequence: Schema.Number,
  pendingPermissionRequests: Schema.Array(Schema.String),
  pendingPermissionResponses: Schema.Array(PendingPermissionResponseSchema),
  exitEvidence: Schema.optional(RuntimeExitEvidenceSchema),
})
export type RuntimeContextEventState = Schema.Schema.Type<typeof RuntimeContextEventStateSchema>

export const initialRuntimeContextEventState: RuntimeContextEventState = {
  lastProcessedInputSequence: -1,
  lastProcessedOutputSequence: -1,
  pendingPermissionRequests: [],
  pendingPermissionResponses: [],
}

// ---------------------------------------------------------------------------
// Durable state table (workflow-private; one row per (contextId, attempt)).
// ---------------------------------------------------------------------------

const stateKey = (contextId: string, activityAttempt: number): string =>
  `${contextId}::${activityAttempt}`

const RuntimeContextStateRowSchema = Schema.Struct({
  stateKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  ...RuntimeContextEventStateSchema.fields,
})
type RuntimeContextStateRow = Schema.Schema.Type<typeof RuntimeContextStateRowSchema>

const runtimeContextStateSchemas = {
  states: RuntimeContextStateRowSchema,
} as const

export class RuntimeContextStateTable extends DurableTable(
  "firegrid.runtimeContextState",
  runtimeContextStateSchemas,
) {}

const stateFromRow = (row: RuntimeContextStateRow): RuntimeContextEventState => ({
  lastProcessedInputSequence: row.lastProcessedInputSequence,
  lastProcessedOutputSequence: row.lastProcessedOutputSequence,
  pendingPermissionRequests: row.pendingPermissionRequests,
  pendingPermissionResponses: row.pendingPermissionResponses,
  ...(row.exitEvidence === undefined ? {} : { exitEvidence: row.exitEvidence }),
})

const rowFromState = (
  context: RuntimeContext,
  activityAttempt: number,
  state: RuntimeContextEventState,
): RuntimeContextStateRow => ({
  stateKey: stateKey(context.contextId, activityAttempt),
  contextId: context.contextId,
  activityAttempt,
  lastProcessedInputSequence: state.lastProcessedInputSequence,
  lastProcessedOutputSequence: state.lastProcessedOutputSequence,
  pendingPermissionRequests: state.pendingPermissionRequests,
  pendingPermissionResponses: state.pendingPermissionResponses,
  ...(state.exitEvidence === undefined ? {} : { exitEvidence: state.exitEvidence }),
})

// ---------------------------------------------------------------------------
// Capability the body depends on (load/save state + point-read next output).
// ---------------------------------------------------------------------------

export interface RuntimeContextStateStoreService {
  /** Reconstruct durable loop state with one point read; initial if absent. */
  readonly load: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<RuntimeContextEventState, unknown>
  /** Persist advanced loop state (idempotent upsert of the cursor row). */
  readonly save: (
    context: RuntimeContext,
    activityAttempt: number,
    state: RuntimeContextEventState,
  ) => Effect.Effect<void, unknown>
  /**
   * The next agent-output OBSERVATION strictly after `afterSequence`, found by
   * forward point `get`s (never a full-table scan). The output sequence counter
   * is shared by `events` and `logs`, so non-observation sequences (log rows,
   * undecodable event rows) are skipped forward; `Option.none` only at the true
   * frontier (no `events` or `logs` row at the sequence yet).
   */
  readonly nextOutput: (
    context: RuntimeContext,
    activityAttempt: number,
    afterSequence: number,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>
}

export class RuntimeContextStateStore extends Context.Tag(
  "@firegrid/runtime/RuntimeContextStateStore",
)<RuntimeContextStateStore, RuntimeContextStateStoreService>() {}

export interface PerContextRuntimeContextStateConfig {
  readonly durableStreamsBaseUrl: string
  readonly headers?: DurableTableHeaders
}

const streamOptions = (
  config: PerContextRuntimeContextStateConfig,
  url: string,
) => ({
  url,
  contentType: "application/json" as const,
  ...(config.headers === undefined ? {} : { headers: config.headers }),
})

// The state row lives on its OWN per-context stream (the output stream name
// plus a `.state` segment), NOT the output stream — so loop-state writes never
// pollute the per-context output stream that the edge, wait-router, and other
// output consumers read. Output point reads use the output stream as usual.
const stateStreamUrl = (
  config: PerContextRuntimeContextStateConfig,
  streamPrefix: HostStreamPrefix,
  contextId: string,
) =>
  durableStreamUrl(
    config.durableStreamsBaseUrl,
    `${runtimeContextOutputStreamName({ prefix: streamPrefix, contextId })}.state`,
  )

const outputStreamUrl = (
  config: PerContextRuntimeContextStateConfig,
  streamPrefix: HostStreamPrefix,
  contextId: string,
) =>
  runtimeContextOutputStreamUrl({
    baseUrl: config.durableStreamsBaseUrl,
    prefix: streamPrefix,
    contextId,
  })

const stateTableLayer = (
  config: PerContextRuntimeContextStateConfig,
  streamPrefix: HostStreamPrefix,
  contextId: string,
) =>
  RuntimeContextStateTable.layer({
    streamOptions: streamOptions(config, stateStreamUrl(config, streamPrefix, contextId)),
  })

const outputTableLayer = (
  config: PerContextRuntimeContextStateConfig,
  streamPrefix: HostStreamPrefix,
  contextId: string,
) =>
  RuntimeOutputTable.layer({
    streamOptions: streamOptions(config, outputStreamUrl(config, streamPrefix, contextId)),
  })

/**
 * Find the next agent-output OBSERVATION strictly after `afterSequence` in a
 * RuntimeOutputTable by forward point `get`s — never a full-table scan. The
 * output sequence counter is SHARED by `events` and `logs`, so the `events`
 * collection is sparse: a sequence may hold a log row, or an event row that
 * doesn't decode to an observation. Distinguish a real frontier from such a gap
 * by also point-`get`-ing `logs`:
 *   - decodable event  -> deliver it (cursor advances to its sequence)
 *   - undecodable event -> skip forward
 *   - log row present   -> gap, skip forward
 *   - neither present   -> frontier, stop (Option.none)
 *
 * Exported so the workflow body's per-context store and the test host-wide
 * double share one gap-skip implementation over whichever RuntimeOutputTable
 * each provides.
 */
export const nextOutputObservation = (
  outputTable: RuntimeOutputTable["Type"],
  contextId: string,
  activityAttempt: number,
  afterSequence: number,
): Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown> =>
  Effect.map(
    Effect.iterate(
      {
        sequence: afterSequence + 1,
        found: Option.none<RuntimeAgentOutputObservation>(),
        done: false,
      },
      {
        while: (s) => !s.done,
        body: (s) =>
          Effect.gen(function*() {
            const eventRow = yield* outputTable.events.get({
              contextId,
              activityAttempt,
              target: "events",
              sequence: s.sequence,
            })
            if (Option.isSome(eventRow)) {
              const observation = runtimeAgentOutputObservationFromRow(eventRow.value)
              return Option.isSome(observation)
                ? { sequence: s.sequence, found: observation, done: true }
                : { sequence: s.sequence + 1, found: Option.none<RuntimeAgentOutputObservation>(), done: false }
            }
            const logRow = yield* outputTable.logs.get({
              contextId,
              activityAttempt,
              target: "logs",
              sequence: s.sequence,
            })
            return Option.isSome(logRow)
              ? { sequence: s.sequence + 1, found: Option.none<RuntimeAgentOutputObservation>(), done: false }
              : { sequence: s.sequence, found: Option.none<RuntimeAgentOutputObservation>(), done: true }
          }),
      },
    ),
    (result) => result.found,
  )

interface PerContextTables {
  readonly stateTable: RuntimeContextStateTable["Type"]
  readonly outputTable: RuntimeOutputTable["Type"]
}

/**
 * Per-context state + output tables are built ONCE into the host scope and
 * cached, so load/save/nextOutput reuse one live, already-materialized
 * subscription per context instead of opening (and re-catching-up) a fresh
 * stream subscription on every call. Reuse keeps the durable cursor reads cheap
 * and the output point read live, which is what makes the replay-from-table
 * model fast enough to keep up with an agent turn.
 */
export const makePerContextRuntimeContextStateStore = (
  config: PerContextRuntimeContextStateConfig,
  streamPrefix: HostStreamPrefix,
): Effect.Effect<RuntimeContextStateStoreService, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const cache = yield* Ref.make(new Map<string, PerContextTables>())
    const lock = yield* Effect.makeSemaphore(1)

    const tablesFor = (contextId: string): Effect.Effect<PerContextTables> =>
      lock.withPermits(1)(Effect.gen(function*() {
        const existing = (yield* Ref.get(cache)).get(contextId)
        if (existing !== undefined) return existing
        const built = yield* Layer.buildWithScope(
          Layer.merge(
            stateTableLayer(config, streamPrefix, contextId),
            outputTableLayer(config, streamPrefix, contextId),
          ),
          scope,
        )
        const tables: PerContextTables = {
          stateTable: Context.get(built, RuntimeContextStateTable),
          outputTable: Context.get(built, RuntimeOutputTable),
        }
        yield* Ref.update(cache, map => new Map(map).set(contextId, tables))
        return tables
      })) as Effect.Effect<PerContextTables>

    return {
      load: (context, activityAttempt) =>
        Effect.gen(function*() {
          const { stateTable } = yield* tablesFor(context.contextId)
          const row = yield* stateTable.states.get(stateKey(context.contextId, activityAttempt))
          return Option.match(row, {
            onNone: () => initialRuntimeContextEventState,
            onSome: stateFromRow,
          })
        }).pipe(
          Effect.withSpan("firegrid.runtime_context.workflow.state.load", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": context.contextId,
              "firegrid.runtime.activity_attempt": activityAttempt,
            },
          }),
        ),
      save: (context, activityAttempt, state) =>
        Effect.gen(function*() {
          const { stateTable } = yield* tablesFor(context.contextId)
          yield* stateTable.states.upsert(rowFromState(context, activityAttempt, state))
        }).pipe(
          Effect.withSpan("firegrid.runtime_context.workflow.state.save", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": context.contextId,
              "firegrid.runtime.activity_attempt": activityAttempt,
              "firegrid.runtime.input.sequence": state.lastProcessedInputSequence,
              "firegrid.runtime.output.sequence": state.lastProcessedOutputSequence,
            },
          }),
        ),
      nextOutput: (context, activityAttempt, afterSequence) =>
        Effect.flatMap(tablesFor(context.contextId), ({ outputTable }) =>
          nextOutputObservation(outputTable, context.contextId, activityAttempt, afterSequence)).pipe(
          Effect.withSpan("firegrid.runtime_context.workflow.output.cursor.next", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": context.contextId,
              "firegrid.runtime.activity_attempt": activityAttempt,
              // INV-3: the read is a point lookup at position+1, never a scan.
              "firegrid.runtime.output.read_indexed": true,
              "firegrid.runtime.output.after_sequence": afterSequence,
              // Seam classification (runtime-shrink contract-coverage): this is
              // the REALIZED reshape target the tf-7kq8 memoized body-side scan
              // pointed at (it carried seam.kind=bridge_debt → contract.id=this
              // SDD). The durable per-context cursor point-read now satisfies the
              // primitive, so the seam flips bridge_debt → DURABILITY: replay
              // reconstructs progress from table state via O(1) point gets.
              "firegrid.seam.kind": "durability",
              "firegrid.contract.id": "docs/sdds/SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE.md",
            },
          }),
        ),
    }
  })
