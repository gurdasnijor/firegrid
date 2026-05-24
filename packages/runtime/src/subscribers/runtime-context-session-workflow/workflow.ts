// RuntimeContextSessionWorkflow — Shape D production lane.
//
// See `./README.md` for the SDD Gate justification. This file owns the
// workflow + body + processed-markers table + Activity wiring.
//
// Architecture summary (proved by tiny-firegrid
// `runtime-context-session-workflow` GREEN):
//
//   1. `Workflow.make({ idempotencyKey: contextId:attempt })` provides
//      atomic admission. Concurrent dispatches collapse to one execution.
//   2. `Activity.make({ name: "rcsw.spawn/${key}" })` makes the codec
//      `startOrAttach` exactly-once across reconstruction. The workflow
//      is the SOLE caller of `RuntimeContextWorkflowSession.startOrAttach`
//      in production (legacy callers in
//      `subscribers/runtime-control/control-request-side-effects.ts` and
//      `subscribers/runtime-context/handler.ts` are rewired to dispatch
//      this workflow / resume it instead).
//   3. Input loop: query unprocessed intents for this context, sort by
//      `createdAt`, take next, `Activity.make({ name: "rcsw.send/${intentId}" })`
//      to call `session.send`, write a per-intent processed marker, loop.
//      On empty: `Workflow.suspend(instance)` → resumed by
//      `Workflow.resume(executionId)` from the Shape C subscriber when
//      a new intent arrives.
//   4. Terminal: race the input loop against
//      `RuntimeRunAppendAndGet.waitTerminal` — when the Shape C
//      subscriber writes `runs.exited` on Terminated output, the body
//      returns.

import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  RuntimeControlPlaneTable,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Effect, Either, Option, Schema } from "effect"
import { DurableTable } from "effect-durable-operators"
import {
  RuntimeContextRead,
} from "../../control-plane/index.ts"
import { ingressInputRowFromIntent } from "../../tables/runtime-context-input-facts.ts"
import { agentInputEventFromRuntimeIngressRow } from "../../transforms/decode-ingress-row.ts"
import {
  RuntimeContextWorkflowSession,
} from "../runtime-context-session/index.ts"

// ── Workflow contract ──────────────────────────────────────────────────────

const RuntimeContextSessionWorkflowPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
}).annotations({
  identifier: "firegrid.rcsw.payload",
  title: "RuntimeContextSessionWorkflow payload",
})

type RuntimeContextSessionWorkflowPayload = Schema.Schema.Type<
  typeof RuntimeContextSessionWorkflowPayloadSchema
>

const RuntimeContextSessionWorkflowSuccessSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  intentsProcessed: Schema.Number,
  terminalStatus: Schema.Union(
    Schema.Literal("exited"),
    Schema.Literal("failed"),
  ),
}).annotations({
  identifier: "firegrid.rcsw.success",
})

export type RuntimeContextSessionWorkflowSuccess = Schema.Schema.Type<
  typeof RuntimeContextSessionWorkflowSuccessSchema
>

const sessionWorkflowKey = (
  contextId: string,
  activityAttempt: number,
): string => `${contextId}:${activityAttempt}`

export const RuntimeContextSessionWorkflow = Workflow.make({
  name: "firegrid.rcsw.session-workflow",
  payload: RuntimeContextSessionWorkflowPayloadSchema,
  success: RuntimeContextSessionWorkflowSuccessSchema,
  idempotencyKey: (p) => sessionWorkflowKey(p.contextId, p.activityAttempt),
})

// ── Per-intent processed-marker table (workflow-owned) ─────────────────────
//
// One row per `(contextId, activityAttempt, intentId)` written AFTER the
// send Activity succeeds. Lets the body re-derive its cursor from durable
// state on every body materialization (replay / resume / restart) without
// relying on workflow-instance memory.

const ProcessedIntentRowSchema = Schema.Struct({
  markerKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  intentId: Schema.String,
  processedAt: Schema.String,
}).annotations({
  identifier: "firegrid.rcsw.processedIntent",
})

export class RcswProcessedTable extends DurableTable("firegrid.rcsw.processed", {
  rows: ProcessedIntentRowSchema,
}) {}

const now = (): string => new Date().toISOString()

const markerKeyFor = (
  contextId: string,
  activityAttempt: number,
  intentId: string,
): string => `${contextId}:${activityAttempt}:${intentId}`

const markIntentProcessed = (
  processed: RcswProcessedTable["Type"],
  payload: RuntimeContextSessionWorkflowPayload,
  intentId: string,
) =>
  processed.rows.insertOrGet({
    markerKey: markerKeyFor(payload.contextId, payload.activityAttempt, intentId),
    contextId: payload.contextId,
    activityAttempt: payload.activityAttempt,
    intentId,
    processedAt: now(),
  }).pipe(Effect.orDie)

// ── Body ───────────────────────────────────────────────────────────────────

const sessionBody = (payload: RuntimeContextSessionWorkflowPayload) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const key = sessionWorkflowKey(payload.contextId, payload.activityAttempt)
    const contextRead = yield* RuntimeContextRead
    const sessionAdapter = yield* RuntimeContextWorkflowSession
    const control = yield* RuntimeControlPlaneTable
    const processed = yield* RcswProcessedTable
    const contextOpt = yield* contextRead.readContext(payload.contextId).pipe(Effect.orDie)
    if (Option.isNone(contextOpt)) {
      return {
        contextId: payload.contextId,
        activityAttempt: payload.activityAttempt,
        intentsProcessed: 0,
        terminalStatus: "failed" as const,
      }
    }
    const context: RuntimeContext = contextOpt.value

    // Spawn — Activity-memoized; sole caller of session.startOrAttach in
    // production (the dual-owner race is structurally eliminated).
    yield* Activity.make({
      name: `firegrid.rcsw.spawn/${key}`,
      success: Schema.Void,
      execute: sessionAdapter.startOrAttach(context, payload.activityAttempt).pipe(
        Effect.asVoid,
        Effect.orDie,
        Effect.withSpan("firegrid.rcsw.activity.spawn", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": payload.contextId,
            "firegrid.runtime.activity_attempt": payload.activityAttempt,
          },
        }),
      ),
    })

    // Input dispatch loop. Each iteration:
    //   - query unprocessed intents (intents minus processed markers),
    //   - if none, race(Workflow.suspend, runs.waitTerminal),
    //   - if some, take earliest by createdAt and send via Activity,
    //   - write processed marker, loop.
    let intentsProcessed = 0
    while (true) {
      // Drain the cursor: query intents + processed markers for this
      // (contextId, attempt) and diff. Both queries return snapshots at
      // call time; that's fine because Activity memoization makes the
      // send idempotent on intentId and the marker write commits before
      // the next iteration's query.
      const allIntents = yield* control.inputIntents.query((coll) =>
        coll.toArray.filter((r) => r.contextId === payload.contextId),
      ).pipe(Effect.orDie)
      const processedMarkers = yield* processed.rows.query((coll) =>
        coll.toArray.filter((r) =>
          r.contextId === payload.contextId
          && r.activityAttempt === payload.activityAttempt),
      ).pipe(Effect.orDie)
      const processedIds = new Set(processedMarkers.map((r) => r.intentId))
      const unprocessed = allIntents
        .filter((r) => !processedIds.has(r.intentId))
        // Stable ordering by ISO createdAt string (lexicographic == chronological
        // for ISO 8601). Ties (same-instant intents) break by intentId for
        // determinism.
        .sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
          return a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0
        })

      if (unprocessed.length === 0) {
        // Non-blocking terminal check via a one-shot query. We can't use
        // runs.waitTerminal here because it's a `Stream.runHead`-style
        // block that traps the body — Workflow.resume can't wake an
        // execution parked on a non-engine wait.
        const terminalRows = yield* control.runs.query((coll) =>
          coll.toArray.filter((r) =>
            r.contextId === payload.contextId
            && r.activityAttempt === payload.activityAttempt
            && (r.status === "exited" || r.status === "failed")),
        ).pipe(Effect.orDie)
        if (terminalRows.length > 0) {
          const terminal = terminalRows[0]!
          return {
            contextId: payload.contextId,
            activityAttempt: payload.activityAttempt,
            intentsProcessed,
            terminalStatus: terminal.status === "failed" ? "failed" as const : "exited" as const,
          }
        }
        // Park: the engine durable-suspends until Workflow.resume re-arms us
        // (from the Shape C subscriber on a new Input event, or from any
        // caller wanting to re-check terminal). On wake, the body re-runs
        // from the top: spawn Activity is memoized; cursor is re-derived
        // from the processed-markers table.
        return yield* Workflow.suspend(instance)
      }

      const nextIntent = unprocessed[0]!
      // Decode the intent → AgentInputEvent via the same transform the
      // Shape C handler used pre-cutover. If decode fails the intent is
      // malformed; mark it processed so we don't retry forever, and log.
      const ingressRow = ingressInputRowFromIntent(nextIntent)
      const decoded = agentInputEventFromRuntimeIngressRow(ingressRow)
      if (Either.isLeft(decoded)) {
        yield* Effect.logWarning(
          "[rcsw] intent decode failed; marking processed and skipping",
        ).pipe(
          Effect.annotateLogs({
            contextId: payload.contextId,
            intentId: nextIntent.intentId,
            cause: String(decoded.left),
          }),
        )
        yield* markIntentProcessed(processed, payload, nextIntent.intentId)
        intentsProcessed += 1
        continue
      }
      yield* Activity.make({
        name: `firegrid.rcsw.send/${key}/${nextIntent.intentId}`,
        success: Schema.Void,
        execute: sessionAdapter.send(context, payload.activityAttempt, {
          _tag: "AgentInput",
          commandId: `runtime-input-${payload.contextId}-${nextIntent.intentId}`,
          event: decoded.right,
        }).pipe(
          Effect.asVoid,
          Effect.orDie,
          Effect.withSpan("firegrid.rcsw.activity.send", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": payload.contextId,
              "firegrid.runtime.activity_attempt": payload.activityAttempt,
              "firegrid.runtime.intent_id": nextIntent.intentId,
            },
          }),
        ),
      })
      yield* markIntentProcessed(processed, payload, nextIntent.intentId)
      intentsProcessed += 1
    }
  }).pipe(
    Effect.withSpan("firegrid.rcsw.body", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": payload.contextId,
        "firegrid.runtime.activity_attempt": payload.activityAttempt,
      },
    }),
  )

// ── Layer (compose into host-live) ─────────────────────────────────────────

export const RuntimeContextSessionWorkflowLayer = RuntimeContextSessionWorkflow.toLayer(
  (payload) => sessionBody(payload),
)
