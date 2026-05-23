// Shape C codec-session command sink: runtime-owned inversion seam between
// the durable plane and the host-sdk live agent session adapter.
//
// SHAPE: C. This file holds the seam *contract only*:
//
//   - the capability tag `RuntimeContextWorkflowSession`,
//   - the started-session and accepted-command evidence schemas and types,
//   - the `RuntimeContextSessionCommand` union the durable plane sends, and
//   - the `RuntimeContextWorkflowSessionService` interface a host adapter
//     implements.
//
// The contract is intentionally substrate-free. This module MUST NOT import
// `@effect/workflow` (no `WorkflowEngine`, no `Activity.make`, no
// `DurableDeferred`, no `DurableClock`), must not import the retired
// workflow body (deleted in the body+kernel deletion wave), and must not
// import producers, composition, or the workflow-runtime barrels. The
// host-sdk import gate blocks consumers from reaching the retired body
// through this seam.
//
// Per `docs/architecture/2026-05-22-runtime-physical-target-tree.md`, the
// public subpath is `@firegrid/runtime/subscribers/runtime-context-session`;
// only the symbols exposed by `index.ts` are part of that public surface.
// The accepted-evidence and started-evidence schemas are re-exported so
// runtime-internal callers can derive workflow Activity success schemas from
// them without duplicating the wire shape.

import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Context, Layer } from "effect"
import type { Effect } from "effect"
import type { RuntimeContextError } from "../../runtime-errors.ts"
import type { AgentInputEvent } from "../../events/agent-input.ts"

export interface RuntimeContextSessionStartedEvidence {
  readonly contextId: string
  readonly activityAttempt: number
  readonly ownerKind: "raw" | "codec"
  readonly ownerSessionId: string
  readonly startCommandId: string
}

// Body+kernel deletion wave: `RuntimeContextSessionStartOutcomeSchema` and
// `RuntimeContextSessionCommandAcceptedSchema` retired with the workflow
// body's `startSessionActivity` / `sendSessionActivity` Activity wrappers
// that consumed them. Shape C dispatches session commands directly via the
// `RuntimeContextWorkflowSession.send` / `.startOrAttach` Tag methods (no
// Activity-result envelope schemas required).

export interface RuntimeContextSessionCommand {
  readonly _tag: "AgentInput"
  readonly commandId: string
  readonly event: AgentInputEvent
}

export interface RuntimeContextSessionCommandAccepted {
  readonly contextId: string
  readonly activityAttempt: number
  readonly commandId: string
  readonly ownerSessionId: string
}

export interface RuntimeContextWorkflowSessionService {
  readonly startOrAttach: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<RuntimeContextSessionStartedEvidence, RuntimeContextError>
  readonly send: (
    context: RuntimeContext,
    activityAttempt: number,
    command: RuntimeContextSessionCommand,
  ) => Effect.Effect<RuntimeContextSessionCommandAccepted, RuntimeContextError>
  /**
   * Wave D-A Shape (b): per-context session teardown. Semantic equivalent
   * of the retired kernel runtime wrapper's per-context deregister —
   * tears down per-context session resources (per-attempt session records
   * for this contextId). The session-command seam owns this lifecycle
   * directly now that the workflow body no longer holds the per-context
   * scope.
   *
   * Soft semantics: removes the contextId's session-record entries from
   * the per-context registry. Forked agent-stream fibers complete on
   * their own when the agent's byte stream ends; explicit interrupt is
   * out of scope for the seam (D-E may extend if a hard-kill primitive
   * becomes necessary).
   */
  readonly deregister: (
    contextId: string,
  ) => Effect.Effect<void, RuntimeContextError>
}

/**
 * Runtime-owned inversion seam for starting and feeding the concrete agent
 * session. See docs/architecture/host-sdk-runtime-boundary.md: the runtime
 * owns workflow definitions; host-sdk provides the live session Layer.
 */
export class RuntimeContextWorkflowSession extends Context.Tag(
  "@firegrid/runtime/RuntimeContextWorkflowSession",
)<RuntimeContextWorkflowSession, RuntimeContextWorkflowSessionService>() {
  static layer = (
    service: RuntimeContextWorkflowSessionService,
  ): Layer.Layer<RuntimeContextWorkflowSession> => Layer.succeed(this, service)
}
