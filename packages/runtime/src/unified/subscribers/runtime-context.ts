/**
 * Canonical RuntimeContext subscriber — as a workflow body.
 *
 * The most load-bearing Shape C subscriber today collapses into a
 * single `Workflow.make` body parked on `Workflow.suspend`, woken by
 * the signal primitive on every input arrival.
 *
 * The body:
 *   1. Spawns once via `Activity.make` calling `adapter.startOrAttach`.
 *      Activity-memoized; the engine activity record IS the durable
 *      spawn evidence — no parallel `runs` row needed.
 *   2. Reads its own signals in `recordedAt` order to derive the
 *      input log. Each signal payload is decoded as a
 *      `SessionInputPayload` envelope (Schema-decoded at consume per
 *      SDD §C). On miss → `Workflow.suspend`. On hit → `Activity.make`
 *      forwarding the envelope to `adapter.send`. The adapter is the
 *      thing that knows the codec; the body is pure pass-through.
 *   3. On `kind === "terminal"`: one final `Activity.make` calling
 *      `adapter.deregister` (releases the host-level process registry
 *      entry), then returns. The engine records the return in
 *      `executions.finalResult` — no parallel `runs.exited` row needed.
 *
 * One execution per `(contextId, attempt)` via `idempotencyKey` —
 * kills the production TOCTOU that spawned two `claude-agent-acp`
 * processes for one logical session.
 *
 * The body consumes `RuntimeContextSessionAdapter` via Context.Tag,
 * NOT via closure (per SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING §A).
 * Workflow Layer is static; users provide the adapter Live separately
 * (production: codec-wrapping Live; tests: `makeRecorderAdapter`).
 */

import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Effect, type ParseResult, Schema } from "effect"
import { readSignalsFor, SignalTable } from "../signal.ts"
import {
  RuntimeContextSessionAdapter,
  SessionInputPayloadSchema,
  type SessionInputPayload,
} from "../adapter.ts"

// Re-export here so the subscriber's public surface is single-import
// for the schema callers (channel bindings, scenarios).
export { SessionInputPayloadSchema, type SessionInputPayload }

// ── Workflow ────────────────────────────────────────────────────────────────

export const RuntimeContextSessionPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
})
export type RuntimeContextSessionPayload =
  Schema.Schema.Type<typeof RuntimeContextSessionPayloadSchema>

export const RuntimeContextSessionResultSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  inputsConsumed: Schema.Number,
  reachedTerminal: Schema.Boolean,
})

export const RuntimeContextSessionWorkflow = Workflow.make({
  name: "unified.runtime-context-session",
  payload: RuntimeContextSessionPayloadSchema,
  success: RuntimeContextSessionResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.attempt}`,
})

const decodeSessionInputPayloadJson = Schema.decode(
  Schema.parseJson(SessionInputPayloadSchema),
)

const sessionKey = (contextId: string, attempt: number): string =>
  `${contextId}:${attempt}`

const body = (
  payload: RuntimeContextSessionPayload,
  executionId: string,
) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const signals = yield* SignalTable
    const adapter = yield* RuntimeContextSessionAdapter
    const key = sessionKey(payload.contextId, payload.attempt)

    // Spawn once per attempt. Activity-memoized; the engine activity
    // record IS the durable spawn evidence.
    yield* Activity.make({
      name: `unified.session.spawn/${key}`,
      success: Schema.Void,
      execute: adapter.startOrAttach(payload.contextId, payload.attempt).pipe(
        Effect.orDie,
      ),
    })

    // Iterate own signals. Each signal payload is decoded to a typed
    // `SessionInputPayload` envelope at consume; the body forwards
    // the envelope unchanged to the adapter.
    let consumed = 0
    let reachedTerminal = false
    while (!reachedTerminal) {
      const rows = yield* readSignalsFor(signals, executionId).pipe(Effect.orDie)
      if (consumed >= rows.length) {
        yield* Effect.annotateCurrentSpan({
          "firegrid.unified.body.decision": "suspend",
          "firegrid.unified.cursor": consumed,
        })
        return yield* Workflow.suspend(instance)
      }
      while (consumed < rows.length && !reachedTerminal) {
        const row = rows[consumed]!
        const cursor = consumed
        const input: SessionInputPayload = yield* decodeSessionInputPayloadJson(row.payloadJson).pipe(
          Effect.mapError((e: ParseResult.ParseError) =>
            new Error(`malformed session input at cursor ${cursor}: ${e.message}`),
          ),
          Effect.orDie,
        )
        if (input.kind === "terminal") {
          reachedTerminal = true
          consumed += 1
          break
        }
        yield* Activity.make({
          name: `unified.session.send/${key}/${cursor}`,
          success: Schema.Void,
          execute: adapter.send(payload.contextId, payload.attempt, input).pipe(
            Effect.orDie,
          ),
        })
        consumed += 1
      }
    }

    // Terminal cleanup: release the adapter's host-level process registry
    // entry. Activity-memoized; runs exactly once at attempt completion.
    yield* Activity.make({
      name: `unified.session.deregister/${payload.contextId}`,
      success: Schema.Void,
      execute: adapter.deregister(payload.contextId).pipe(Effect.orDie),
    })

    return {
      contextId: payload.contextId,
      attempt: payload.attempt,
      inputsConsumed: consumed,
      reachedTerminal,
    }
  }).pipe(
    Effect.withSpan("firegrid.unified.session.body", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": payload.contextId,
        "firegrid.unified.attempt": payload.attempt,
      },
    }),
    Effect.orDie,
  )

export const RuntimeContextSessionWorkflowLayer = RuntimeContextSessionWorkflow.toLayer(body)
