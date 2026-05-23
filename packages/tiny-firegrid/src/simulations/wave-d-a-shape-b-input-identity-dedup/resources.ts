// Wave D-A Shape (b) — in-memory substrate for the loop-body proof.
//
// Mirrors the typed-fact surfaces the production Shape C subscriber consumes:
//
//   inputs   : RuntimeContextInputFacts.forContext(contextId)         → identity-keyed (inputId)
//   outputs  : runtime-output-table (per-context).rows()              → sequence-keyed
//   state    : RuntimeContextStateStore.{load,save}                    → per-contextId row
//
// Identity-keyed input dedup is the CC2 directive; this module materializes
// the schema change (`processedInputIds: ReadonlyArray<string>` in place of
// `lastProcessedInputSequence: number`) that the sim's handler operates on.
//
// Pure in-memory (SubscriptionRef + Ref). No DurableTable — durability is not
// what this sim proves; identity-keyed dedup + restart idempotency at the
// handler layer is. "Restart" is modeled by reading the saved state row
// fresh on each handler materialization (no in-memory threading across calls)
// — exactly what the production handler does after #633 (durable state row
// reloaded on every handler call).

import { Effect, Ref, Stream, SubscriptionRef } from "effect"

// ── Typed events (sim-local; mirror the production schemas) ───────────────

export interface RuntimeIngressInputRow {
  readonly inputId: string
  readonly contextId: string
  // sequence intentionally absent: Shape C input facts have no sequence
  // allocator (cf. `tables/runtime-context-input-facts.ts:53-57`). The
  // current production handler's `event.event.sequence ?? -1` is the bug
  // this sim falsifies.
  readonly kind: "message" | "permission_response"
  readonly payload: unknown
}

export interface RuntimeAgentOutputObservation {
  readonly contextId: string
  // Outputs DO carry a kernel-allocated sequence (per-context monotonic). This
  // is the asymmetry the production substrate exposes: input-fact identity
  // vs output ordinal. Sequence-keyed dedup is correct for outputs.
  readonly sequence: number
  readonly kind: "text" | "permission_request" | "tool_use" | "terminated"
  readonly payload: unknown
}

export type RuntimeContextTargetEvent =
  | { readonly _tag: "Input"; readonly event: RuntimeIngressInputRow }
  | { readonly _tag: "Output"; readonly event: RuntimeAgentOutputObservation }

// ── Loop state (the schema change this sim validates) ─────────────────────

/**
 * `processedInputIds` is the CC2 directive — identity-keyed input dedup.
 *
 * `lastProcessedOutputSequence` stays a number because outputs carry a real
 * sequence allocator from the substrate. Asymmetric on purpose.
 */
export interface RuntimeContextEventState {
  readonly processedInputIds: ReadonlyArray<string>
  readonly lastProcessedOutputSequence: number
  // Action ledger: every dispatched action appends a stable id. Used by
  // tests to assert "input dispatched exactly once" across restarts.
  readonly dispatchedActionIds: ReadonlyArray<string>
}

export const initialRuntimeContextEventState: RuntimeContextEventState = {
  processedInputIds: [],
  lastProcessedOutputSequence: -1,
  dispatchedActionIds: [],
}

// ── Substrate (in-memory analogues of the production tables) ──────────────

export interface Substrate {
  /** Append log for input facts (identity-keyed, no sequence). */
  readonly inputs: SubscriptionRef.SubscriptionRef<ReadonlyArray<RuntimeIngressInputRow>>
  /** Append log for outputs (sequence-keyed). */
  readonly outputs: SubscriptionRef.SubscriptionRef<ReadonlyArray<RuntimeAgentOutputObservation>>
  /** Per-contextId state row store. `null` ⇒ initial state. */
  readonly states: Ref.Ref<ReadonlyMap<string, RuntimeContextEventState>>
  // ── Counters (observability for tests; not part of the production
  //    primitive). ─────────────────────────────────────────────────────────
  readonly handlerInvocations: Ref.Ref<number>
  readonly handlerDispatches: Ref.Ref<number>
  readonly handlerSkips: Ref.Ref<number>
  readonly stateReloads: Ref.Ref<number>
}

export const makeSubstrate = (): Effect.Effect<Substrate> =>
  Effect.gen(function* () {
    return {
      inputs: yield* SubscriptionRef.make<ReadonlyArray<RuntimeIngressInputRow>>([]),
      outputs: yield* SubscriptionRef.make<ReadonlyArray<RuntimeAgentOutputObservation>>([]),
      states: yield* Ref.make<ReadonlyMap<string, RuntimeContextEventState>>(new Map()),
      handlerInvocations: yield* Ref.make(0),
      handlerDispatches: yield* Ref.make(0),
      handlerSkips: yield* Ref.make(0),
      stateReloads: yield* Ref.make(0),
    }
  })

// ── State store accessors (mirror `RuntimeContextStateStore`) ─────────────

export const loadState = (
  substrate: Substrate,
  contextId: string,
): Effect.Effect<RuntimeContextEventState> =>
  Effect.gen(function* () {
    yield* Ref.update(substrate.stateReloads, (n) => n + 1)
    const map = yield* Ref.get(substrate.states)
    return map.get(contextId) ?? initialRuntimeContextEventState
  })

export const saveState = (
  substrate: Substrate,
  contextId: string,
  state: RuntimeContextEventState,
): Effect.Effect<void> =>
  Ref.update(substrate.states, (map) => {
    const next = new Map(map)
    next.set(contextId, state)
    return next
  })

// ── Producers (the wire-edge that real Shape C substrate exposes) ─────────

export const appendInput = (
  substrate: Substrate,
  row: RuntimeIngressInputRow,
): Effect.Effect<void> =>
  SubscriptionRef.update(substrate.inputs, (rows) => {
    // `insertOrGet` idempotency on inputId — same identity ⇒ no duplicate row.
    if (rows.some((r) => r.inputId === row.inputId)) return rows
    return [...rows, row]
  })

export const appendOutput = (
  substrate: Substrate,
  row: RuntimeAgentOutputObservation,
): Effect.Effect<void> =>
  SubscriptionRef.update(substrate.outputs, (rows) => [...rows, row])

// ── Tail sources (mirror the production `.rows()` streams) ────────────────

/**
 * Per-context input fact tail. Emits every input row whose contextId matches,
 * in insertion order. Stream stays open while the substrate accumulates rows
 * (subscriber lifetime model — termination via fiber interrupt, per the
 * shape-c-non-recursive-start precedent).
 */
export const inputFactsForContext = (
  substrate: Substrate,
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow> =>
  substrate.inputs.changes.pipe(
    Stream.scan(
      { lastIndex: -1, emit: [] as ReadonlyArray<RuntimeIngressInputRow> },
      (acc, rows) => {
        // Emit only the suffix added since the last snapshot, filtered by
        // contextId. Mirrors the per-context tail filter in
        // `tables/runtime-context-input-facts.ts:107-110`.
        const fresh = rows.slice(acc.lastIndex + 1).filter((r) => r.contextId === contextId)
        return { lastIndex: rows.length - 1, emit: fresh }
      },
    ),
    Stream.flatMap((acc) => Stream.fromIterable(acc.emit)),
  )

export const outputsForContext = (
  substrate: Substrate,
  contextId: string,
): Stream.Stream<RuntimeAgentOutputObservation> =>
  substrate.outputs.changes.pipe(
    Stream.scan(
      { lastIndex: -1, emit: [] as ReadonlyArray<RuntimeAgentOutputObservation> },
      (acc, rows) => {
        const fresh = rows.slice(acc.lastIndex + 1).filter((r) => r.contextId === contextId)
        return { lastIndex: rows.length - 1, emit: fresh }
      },
    ),
    Stream.flatMap((acc) => Stream.fromIterable(acc.emit)),
  )
