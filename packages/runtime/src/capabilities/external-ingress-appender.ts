/**
 * ExternalIngressAppender — the capability tag connectors depend on to
 * journal a fact row.
 *
 * Connectors (`connectors/<name>/`) ask for this Tag in the `R` channel
 * of their `journal` field. The host layer provides the Live binding,
 * which is the only thing that actually imports `tables/`. Connectors
 * therefore never reach `tables/` directly — the dep-cruiser rule
 * `connectors/ ✗ tables/` (which we do *not* declare; only the no-cross-
 * connector + no-subscribers/composition rules apply at the folder
 * level) is satisfied by the type system rather than by path-graph
 * enforcement.
 */

import { Context, type Effect } from "effect"

/**
 * Minimal row shape every connector fact must satisfy. Concrete
 * connectors widen `Fact` with their own typed fields; the appender
 * accepts the widened shape as long as the base fields are present.
 */
export interface ExternalIngressFactBase {
  /**
   * Idempotency key. `insertOrGet` uses this — re-delivery of the same
   * external event is a no-op write that returns the original row.
   */
  readonly factKey: readonly [source: string, externalEventKey: string]
  readonly source: string
  readonly externalEventKey: string
  readonly receivedAt: string
  readonly verifiedAt: string
  readonly eventType: string
}

export type ExternalIngressAppendResult<Fact extends ExternalIngressFactBase> =
  | { readonly _tag: "Inserted"; readonly fact: Fact }
  | { readonly _tag: "Duplicate"; readonly fact: Fact }

export class ExternalIngressAppendError extends globalThis.Error {
  override readonly name = "ExternalIngressAppendError"
  constructor(
    readonly source: string,
    readonly factKey: readonly [string, string],
    readonly op: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
  }
}

export interface ExternalIngressAppenderService {
  /**
   * Idempotently append a fact row. If `factKey` already exists the
   * existing row is returned (`Duplicate`); otherwise the row is inserted
   * (`Inserted`). A conflict on payload hash for the same key surfaces
   * as `ExternalIngressAppendError`.
   */
  readonly append: <Fact extends ExternalIngressFactBase>(
    fact: Fact,
  ) => Effect.Effect<ExternalIngressAppendResult<Fact>, ExternalIngressAppendError>
}

export class ExternalIngressAppender extends Context.Tag(
  "@firegrid/runtime/ExternalIngressAppender",
)<ExternalIngressAppender, ExternalIngressAppenderService>() {}
