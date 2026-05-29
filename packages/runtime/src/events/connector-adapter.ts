/**
 * Connector adapter primitive (SDD #761 connectors/ revision).
 *
 * A `ConnectorAdapter<Event, Fact>` is the single Effect-native shape that
 * an external integration (Linear webhooks, GitHub webhooks, …) implements.
 * Each adapter lives as one folder under `connectors/<name>/` and exports
 * exactly one `ConnectorAdapter` value.
 *
 * The field types encode the role boundaries that would otherwise need to
 * be enforced per-tier with dep-cruiser:
 *
 *  - `route` — wire-edge (where the external system delivers events).
 *  - `source` — emitter half: turns one inbound request into a typed
 *    Stream of events. Pure read; cannot reach `tables/`.
 *  - `journal` — writer half: turns one event into one durable row.
 *    Requires the `ExternalIngressAppender` capability tag, so it cannot
 *    short-circuit to a direct table write.
 *  - `eventSchema`/`factSchema` — pure schemas.
 *
 * A composition helper (`composition/compose-connector.ts`) wires the
 * adapter's `route` onto the host's `HttpRouter`, runs
 * `source(request) |> Stream.mapEffect(journal)`, and Layer-merges into
 * the runtime. `composition/host-live.ts` takes an array of adapters and
 * merges each.
 */

import type { HttpRouter, HttpServerRequest } from "@effect/platform"
import type { Effect, Schema, Stream } from "effect"
import type { ExternalIngressAppender } from "../capabilities/external-ingress-appender.ts"

/**
 * Errors raised while turning an inbound request into a Stream of events.
 * Signature mismatch, malformed payload, missing required header.
 */
export class ConnectorSourceError extends globalThis.Error {
  override readonly name = "ConnectorSourceError"
  constructor(
    readonly connectorId: string,
    readonly op: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Errors raised while journaling an event as a durable fact row.
 * Append failure, schema mismatch, idempotency-conflict.
 */
export class ConnectorJournalError extends globalThis.Error {
  override readonly name = "ConnectorJournalError"
  constructor(
    readonly connectorId: string,
    readonly op: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
  }
}

export interface ConnectorAdapter<Event, Fact> {
  /** Stable identifier for telemetry / wiring. e.g. "linear". */
  readonly id: string

  /**
   * The HTTP route at which the external system delivers events. Used by
   * `composeConnector` to mount the adapter on the host's `HttpRouter`.
   */
  readonly route: {
    readonly method: "POST"
    readonly path: HttpRouter.PathInput
  }

  /**
   * Emitter half. Takes an inbound HTTP request, verifies whatever needs
   * verifying (signature, timestamp window, etc.), decodes the body, and
   * returns a Stream of typed events.
   *
   * Returns `Stream` (not `Effect<Event>`) so that an inbound request that
   * carries N events — e.g., GitHub batch deliveries — fans out naturally.
   * Linear delivers one event per request, in which case `source` returns
   * a single-element Stream.
   *
   * Implementations MUST NOT reach `tables/` (no row authority here).
   * Implementations MAY use cryptographic primitives, schema decoding,
   * `Clock`, and `IdGenerator` from the requirement channel.
   */
  readonly source: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<Stream.Stream<Event, ConnectorSourceError>, ConnectorSourceError>

  /**
   * Writer half. Takes one event and journals it as a fact row through
   * the `ExternalIngressAppender` capability. The Tag is in the
   * requirement channel — the adapter cannot import `tables/` directly.
   *
   * Idempotency is the appender's responsibility (it uses the row's
   * `factKey` for `insertOrGet`).
   */
  readonly journal: (
    event: Event,
  ) => Effect.Effect<Fact, ConnectorJournalError, ExternalIngressAppender>

  /** Pure schemas used by the source decoder and the table writer. */
  readonly eventSchema: Schema.Schema<Event>
  readonly factSchema: Schema.Schema<Fact>
}
