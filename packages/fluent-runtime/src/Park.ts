/**
 * The **park interface** (SDD Appendix E; fluent-park-interface.feature):
 * how a parking durable tool ends the external harness's turn WITHOUT Firegrid
 * owning the model loop.
 *
 * Mechanism (b) — *transport end-of-turn* (the recommended one): when a durable
 * tool must wait, the binding records the durable suspension and returns a
 * **run-terminating tool result** that the harness treats as ending its turn.
 * The park is then a substrate guarantee — not mechanism (a), where the binding
 * returns a plain pending result and *hopes* the model stops.
 *
 * The native run-terminating result is harness-specific, so it comes from the
 * adapter (`AgentAdapter.runTerminatingToolResult`). A harness whose transport
 * offers no such result cannot prove the park interface.
 *
 * Firegrid never re-drives the model loop: the later wake re-enters the harness
 * via native resume (Bridge / Adapter.prepareResume) using the recorded
 * suspension; this module only ends the turn and records the suspension.
 */
import { Effect } from "effect"
import type { AgentAdapter } from "./Adapter.ts"

/** What the session is durably waiting on while parked. */
export interface ParkWaitIntent {
  readonly channel: string
  readonly afterOffset?: string
}

/** A durable tool's decision that it must wait — the input to the park. */
export interface ParkDecision {
  readonly toolCallId: string
  readonly reason: string
  readonly waitIntent: ParkWaitIntent
}

/**
 * The durable suspension fact — recorded BEFORE the run-terminating result is
 * returned, so a crash after recording still resumes (the wait is durable), and
 * it carries everything needed to re-register the wake and re-enter natively.
 */
export interface ParkSuspensionRecord {
  readonly type: "turn_parked"
  readonly toolCallId: string
  readonly reason: string
  readonly waitIntent: ParkWaitIntent
}

/** The mechanism-(b) transport surface: produce a native run-terminating result. */
export interface ParkTransport {
  readonly runTerminatingToolResult: (toolCallId: string) => object
}

/**
 * Resolve the park transport from an adapter. Returns `undefined` when the
 * harness offers no run-terminating tool result — i.e. mechanism (b) is
 * unavailable, so the park interface CANNOT be proven (relying on the model to
 * stop is mechanism (a), which this interface rejects as proof).
 */
export const parkTransportFor = (
  adapter: AgentAdapter,
): ParkTransport | undefined =>
  adapter.runTerminatingToolResult === undefined
    ? undefined
    : { runTerminatingToolResult: adapter.runTerminatingToolResult }

export interface ParkDeps<E = never, R = never> {
  /**
   * Append the durable suspension fact (run FIRST). This is a durable-stream
   * append — an Effect, not a sync callback.
   */
  readonly recordSuspension: (record: ParkSuspensionRecord) => Effect.Effect<void, E, R>
  /** Forward the run-terminating tool result to the harness — a transport Effect. */
  readonly sendToolResult: (raw: object) => Effect.Effect<void, E, R>
  /** End the current harness turn (stop forwarding; the session is now parked). */
  readonly endTurn: Effect.Effect<void, E, R>
  /** Mechanism (b) producer — mandatory; without it there is no park guarantee. */
  readonly transport: ParkTransport
}

export interface ParkOutcome {
  readonly _tag: "Parked"
  readonly suspension: ParkSuspensionRecord
  /** The native run-terminating result that was sent to end the turn. */
  readonly runTerminatingResult: object
}

/**
 * Execute the park interface (mechanism b): record the durable suspension FIRST,
 * then send the harness's native run-terminating tool result and end the turn.
 * The harness ends its turn because the binding sent a run-terminating result —
 * not because the model chose to stop.
 */
export const executePark = <E = never, R = never>(
  decision: ParkDecision,
  deps: ParkDeps<E, R>,
): Effect.Effect<ParkOutcome, E, R> =>
  Effect.gen(function* () {
    const suspension: ParkSuspensionRecord = {
      type: "turn_parked",
      toolCallId: decision.toolCallId,
      reason: decision.reason,
      waitIntent: decision.waitIntent,
    }
    // 1. durable suspension appended BEFORE the run-terminating result is returned
    yield* deps.recordSuspension(suspension)
    // 2. mechanism (b): the native run-terminating tool result ends the turn
    const runTerminatingResult = deps.transport.runTerminatingToolResult(decision.toolCallId)
    yield* deps.sendToolResult(runTerminatingResult)
    // 3. the turn ends over the transport — the session is parked until a wake
    yield* deps.endTurn
    return { _tag: "Parked", suspension, runTerminatingResult }
  })
