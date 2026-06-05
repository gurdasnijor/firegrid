import { setWorldConstructor, World, type IWorldOptions } from "@cucumber/cucumber"

/**
 * A recorded durable-stream envelope (minimal shape for the harness). The real
 * fluent stream carries richer payloads; the acceptance lane only needs the
 * product-observable facets a `Then` step asserts on.
 */
export interface Envelope {
  readonly direction: "user" | "agent" | "bridge"
  readonly payload: unknown
}

/**
 * The fluent acceptance World — holds the system-under-test handles and the
 * product-observable read helpers a `Then` step asserts against.
 *
 * V1 ships an in-memory stream so the harness pipeline (runner → World → steps →
 * observable assertion) can be proven end to end with NO external infra. V2
 * swaps in a firelab-backed driver that appends real durable-streams envelopes
 * and reads real client projections. Either way, `Then` steps assert on these
 * observable reads — never on OpenTelemetry span names.
 */
export class FluentWorld extends World {
  /** Set true by the @real-agent Before hook only when the live lane is enabled. */
  realAgentEnabled = false

  private readonly stream: Envelope[] = []

  constructor(options: IWorldOptions) {
    super(options)
  }

  /** Append an envelope to the in-memory stream (V1 smoke surface). */
  append(envelope: Envelope): void {
    this.stream.push(envelope)
  }

  /** Product-observable read: stream contents in append order. */
  readStream(): ReadonlyArray<Envelope> {
    return [...this.stream]
  }
}

setWorldConstructor(FluentWorld)
