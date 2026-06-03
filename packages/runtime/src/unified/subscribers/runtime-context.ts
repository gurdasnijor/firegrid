/**
 * Canonical RuntimeContext subscriber — a PER-EVENT handler.
 *
 * tf-k00i: retired the parked `while(!reachedTerminal){ readSignalsFor →
 * Workflow.suspend }` body and the bespoke `signal.ts` mailbox. The
 * RuntimeContext session is now an actor/virtual-object handler in the canon
 * shape (C1/C2/C4/C5): ONE fresh execution per session input, keyed
 * `(contextId, inputKey)` via `Workflow.idempotencyKey`, carrying the input in
 * its payload, forwarding to the adapter via an `Activity`, and RETURNING.
 *
 * The body:
 *   1. `Activity.make` calling `adapter.startOrAttach` — gets-or-creates the
 *      live agent process. The adapter owns a per-`contextId` singleton
 *      (atomic get-or-create), so the N per-event executions for one session
 *      do NOT each spawn a process.
 *   2. `terminal` input → `Activity.make` calling `adapter.deregister` (release
 *      the process registry entry), then return.
 *   3. any other input → `Activity.make` forwarding the `SessionInputPayload`
 *      envelope to `adapter.send`, then return.
 *
 * At-most-once delivery: `Workflow.idempotencyKey` ⇒ one execution per
 * `(contextId, inputKey)`; `Activity.make` ⇒ one `adapter.send` per execution.
 * The input is delivered in the workflow payload by the channel binding /
 * sibling relay (no shared-mutable consume cursor — see
 * docs/findings/tf-ogoj-durable-deferred-and-serialization.md: a blind-RMW
 * cursor races; per-input executions over a payload-carried input do not).
 *
 * The body consumes `RuntimeContextSessionAdapter` via Context.Tag.
 */

import {
  Activity,
  Workflow,
} from "@effect/workflow"
import { Effect, Schema } from "effect"
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
  /** Stable per-input key — the idempotency unit (one execution per input). */
  inputKey: Schema.String,
  /** The session input, carried in the payload (no mailbox). */
  input: SessionInputPayloadSchema,
})
export type RuntimeContextSessionPayload =
  Schema.Schema.Type<typeof RuntimeContextSessionPayloadSchema>

export const RuntimeContextSessionResultSchema = Schema.Struct({
  contextId: Schema.String,
  inputKey: Schema.String,
  kind: SessionInputPayloadSchema.fields.kind,
  reachedTerminal: Schema.Boolean,
})

// workflow-make-admission: see docs/workflow-make-admission-ledger.md
export const RuntimeContextSessionWorkflow = Workflow.make({
  name: "unified.runtime-context-session",
  payload: RuntimeContextSessionPayloadSchema,
  success: RuntimeContextSessionResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.inputKey}`,
})

const body = (payload: RuntimeContextSessionPayload) =>
  Effect.gen(function*() {
    const adapter = yield* RuntimeContextSessionAdapter

    // Get-or-create the live process. Activity-memoized per execution; the
    // adapter dedupes the spawn per contextId (keyed singleton).
    yield* Activity.make({
      name: `unified.session.spawn/${payload.contextId}`,
      success: Schema.Void,
      execute: adapter.startOrAttach(payload.contextId, payload.attempt).pipe(
        Effect.orDie,
      ),
    })

    if (payload.input.kind === "terminal") {
      // Terminal cleanup: release the adapter's host-level process registry
      // entry. Activity-memoized; runs exactly once for this terminal input.
      yield* Activity.make({
        name: `unified.session.deregister/${payload.contextId}`,
        success: Schema.Void,
        execute: adapter.deregister(payload.contextId).pipe(Effect.orDie),
      })
      return {
        contextId: payload.contextId,
        inputKey: payload.inputKey,
        kind: payload.input.kind,
        reachedTerminal: true,
      }
    }

    // Forward the input envelope to the adapter. Activity-memoized; runs
    // exactly once even across replay.
    yield* Activity.make({
      name: `unified.session.send/${payload.contextId}/${payload.inputKey}`,
      success: Schema.Void,
      execute: adapter.send(payload.contextId, payload.attempt, payload.input).pipe(
        Effect.orDie,
      ),
    })

    return {
      contextId: payload.contextId,
      inputKey: payload.inputKey,
      kind: payload.input.kind,
      reachedTerminal: false,
    }
  }).pipe(
    Effect.withSpan("firegrid.unified.session.body", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": payload.contextId,
        "firegrid.unified.attempt": payload.attempt,
        "firegrid.input.idempotency_key": payload.inputKey,
        "firegrid.unified.input.kind": payload.input.kind,
      },
    }),
    Effect.orDie,
  )

export const RuntimeContextSessionWorkflowLayer =
  RuntimeContextSessionWorkflow.toLayer(body)
