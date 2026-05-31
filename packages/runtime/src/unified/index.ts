/**
 * `@firegrid/runtime/unified` — the unified subscriber architecture.
 *
 * Single coherent module containing:
 *
 *   - The durable signal primitive (`signal.ts`) — the standard
 *     durable-execution wake-with-payload capability (analog of
 *     Temporal Signals, Restate Awakeables, AWS SFN task tokens,
 *     Cadence Signals).
 *
 *   - The unified table (`tables.ts`) — the four row families that
 *     hold data the engine doesn't already track (permissions,
 *     schedules, webhookFacts, peerEvents). NO `inputIntents` /
 *     `startRequests` / lifecycle status columns; those collapse into
 *     signal events.
 *
 *   - Signal-based subscriber workflows (`subscribers/`) — the
 *     replacements for Shape C subscriber loops. Each is one
 *     `Workflow.make` body that parks via `awaitSignal` / iterates
 *     via `readSignalsFor` / completes by returning a final result.
 *
 * Per `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION` phase 2: this
 * module is the production-side home of the architecture validated
 * by the `unified-kernel-validation` simulation. The simulation
 * sources its primitives from here via re-export so it continues to
 * serve as the runnable proof-generation + alignment harness.
 */

export * from "./signal.ts"
export * from "./tables.ts"
export * from "./subscribers/runtime-context.ts"
export * from "./subscribers/permission-and-tool.ts"
export * from "./subscribers/scheduled-webhook-peer.ts"
