/**
 * INV-2 sim: a custom `WaitForWorkflow` defined entirely with @effect/workflow
 * primitives — NO Firegrid wait-router involvement.
 *
 * Body shape (per OLA SDD One-Substrate Steps 2-3):
 *
 *   DurableDeferred.raceAll([
 *     Activity(Stream.runHead(source.filter(trigger))),
 *     DurableClock.sleep(timeoutMs),
 *   ])
 *
 * `source` is a CallerFact stream resolved through the host-composition-
 * provided `CallerOwnedFactStreams` capability. `trigger` is an AND-of-
 * fieldEquals predicate evaluated in-Activity by `matchesTrigger` below.
 *
 * The workflow's *engine* dispatches it (via `engine.execute(WaitForWorkflow, ...)`)
 * from the sim's MCP `wait_for` tool handler. There is no legacy wait router,
 * no wait-router, no durable wait row, and no `firegrid.durable_tools.wait_router.*`
 * span on this path — that is the load-bearing acceptance criterion.
 */

import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
} from "@effect/workflow"
import { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
import { Duration, Effect, Option, Schema, Stream } from "effect"

const FieldEqualsScalarSchema = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
)
type FieldEqualsScalar = Schema.Schema.Type<typeof FieldEqualsScalarSchema>

const WaitForWorkflowPayloadSchema = Schema.Struct({
  executionKey: Schema.String,
  stream: Schema.String,
  whereFields: Schema.Record({
    key: Schema.String,
    value: FieldEqualsScalarSchema,
  }),
  timeoutMs: Schema.Number,
})

const MatchOutcomeSchema = Schema.Struct({
  _tag: Schema.Literal("Match"),
  raw: Schema.Unknown,
})
const TimeoutOutcomeSchema = Schema.Struct({
  _tag: Schema.Literal("Timeout"),
})
const WaitForWorkflowOutcomeSchema = Schema.Union(
  MatchOutcomeSchema,
  TimeoutOutcomeSchema,
)
export type WaitForWorkflowOutcome = Schema.Schema.Type<
  typeof WaitForWorkflowOutcomeSchema
>

export const WaitForWorkflow = Workflow.make({
  name: "firegrid.sim.inv2.wait-for-workflow",
  payload: WaitForWorkflowPayloadSchema,
  success: WaitForWorkflowOutcomeSchema,
  idempotencyKey: ({ executionKey }) => executionKey,
})

const matchesTrigger = (
  row: unknown,
  whereFields: { readonly [key: string]: FieldEqualsScalar },
): boolean => {
  if (typeof row !== "object" || row === null) return false
  const rec = row as Record<string, unknown>
  return Object.entries(whereFields).every(([key, expected]) =>
    rec[key] === expected)
}

export const WaitForWorkflowLayer = WaitForWorkflow.toLayer(({
  executionKey,
  stream,
  whereFields,
  timeoutMs,
}) => {
  // Match-side Activity: subscribe to the resolved CallerFact stream,
  // filter rows by `whereFields`, take the first match. The Activity
  // boundary makes this side a durably-recorded effect (its successful
  // exit is written to a Workflow Activity row) which is exactly the
  // INV-2 acceptance shape "Activity result records being written".
  const matchActivity = Activity.make({
    name: `wait-for-workflow.match/${executionKey}`,
    success: Schema.Unknown,
    execute: Effect.gen(function* () {
      const streams = yield* CallerOwnedFactStreams
      const source = streams.streamFor(stream)
      const first = yield* Stream.runHead(
        source.pipe(
          Stream.filter((row) => matchesTrigger(row, whereFields)),
        ),
      )
      return Option.match(first, {
        onNone: () => null,
        onSome: (row) => row,
      })
    }).pipe(
      // CallerFact stream read errors are not part of INV-2's contract;
      // surface them as defects so the Activity's `error: Never` channel
      // holds. INV-3 covers durability semantics around stream replay.
      Effect.orDie,
      Effect.withSpan("firegrid.sim.inv2.wait_for_workflow.match_activity", {
        kind: "internal",
        attributes: {
          "firegrid.sim.inv2.execution_key": executionKey,
          "firegrid.sim.inv2.stream": stream,
        },
      }),
    ),
  })

  return DurableDeferred.raceAll({
    name: `wait-for-workflow.race/${executionKey}`,
    success: WaitForWorkflowOutcomeSchema,
    error: Schema.Never,
    effects: [
      matchActivity.pipe(
        Effect.map((raw): WaitForWorkflowOutcome => ({ _tag: "Match", raw })),
      ),
      DurableClock.sleep({
        name: `wait-for-workflow.timeout/${executionKey}`,
        duration: Duration.millis(timeoutMs),
        inMemoryThreshold: Duration.zero,
      }).pipe(
        Effect.as<WaitForWorkflowOutcome>({ _tag: "Timeout" }),
      ),
    ],
  }).pipe(
    Effect.withSpan("firegrid.sim.inv2.wait_for_workflow.body", {
      kind: "internal",
      attributes: {
        "firegrid.sim.inv2.execution_key": executionKey,
        "firegrid.sim.inv2.stream": stream,
        "firegrid.sim.inv2.timeout_ms": timeoutMs,
      },
    }),
  )
})
