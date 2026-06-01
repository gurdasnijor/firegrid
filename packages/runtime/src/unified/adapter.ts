/**
 * RuntimeContextSessionAdapter — host-scoped session lifecycle service.
 *
 * The Tag a workflow body calls into for all outbound side effects against
 * a long-lived agent process. Per SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING §A:
 *
 *   - `startOrAttach(contextId, attempt)` — get or create a session entry
 *     in the adapter's host-process-level registry. Idempotent per
 *     contextId. Activity-memoized at the call site, so per-attempt
 *     attachment runs exactly once even across replay; cross-attempt
 *     continuity is owned by the registry, not by the workflow.
 *   - `send(contextId, attempt, event)` — encode the input event and write
 *     to the registered process. Activity-memoized per (contextId, attempt,
 *     cursor).
 *   - `deregister(contextId)` — terminal cleanup. Releases the process
 *     handle, removes the registry entry. Called as the workflow body's
 *     last activity before returning; the only mechanism by which the
 *     adapter's registry shrinks.
 *
 * Agent processes are LONG-LIVED — the same `claude-agent-acp` process
 * serves many inputs across many attempts. The Tag is therefore a single
 * host-scoped service that fans out by contextId, NOT a per-context
 * factory. Production Lives wrap `sources/codecs/{acp,stdio-jsonl}` plus
 * a process registry (and may require `RuntimeControlPlaneTable` to
 * resolve full context details when spawning); the workflow body only
 * passes the contextId, keeping the body decoupled from context shape.
 */

import { Context, Schema, type Effect } from "effect"

/**
 * Body-side envelope the session workflow forwards to the adapter.
 * Defined here (rather than in the subscriber) because it's part of
 * the adapter contract — the body is pure pass-through; the adapter
 * decodes `payloadJson` per `kind` (codec-specific).
 *
 * Channel bindings Schema-encode typed payloads into this envelope at
 * append; adapters Schema-decode the typed shape at send.
 */
export const SessionInputPayloadSchema = Schema.Struct({
  kind: Schema.Literal(
    "prompt",
    "permission-response",
    "tool-result",
    "peer-event",
    "scheduled-fire",
    "terminal",
  ),
  payloadJson: Schema.String,
})
export type SessionInputPayload = Schema.Schema.Type<typeof SessionInputPayloadSchema>

// ── Error vocabulary ────────────────────────────────────────────────────────

export class AdapterError extends Schema.TaggedError<AdapterError>()(
  "AdapterError",
  {
    op: Schema.Literal("startOrAttach", "send", "deregister"),
    contextId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ── Service interface ──────────────────────────────────────────────────────

export interface RuntimeContextSessionAdapterService {
  readonly startOrAttach: (
    contextId: string,
    activityAttempt: number,
  ) => Effect.Effect<void, AdapterError>
  readonly send: (
    contextId: string,
    activityAttempt: number,
    input: SessionInputPayload,
  ) => Effect.Effect<void, AdapterError>
  readonly deregister: (
    contextId: string,
  ) => Effect.Effect<void, AdapterError>
}

export class RuntimeContextSessionAdapter extends Context.Tag(
  "@firegrid/runtime/RuntimeContextSessionAdapter",
)<RuntimeContextSessionAdapter, RuntimeContextSessionAdapterService>() {}
