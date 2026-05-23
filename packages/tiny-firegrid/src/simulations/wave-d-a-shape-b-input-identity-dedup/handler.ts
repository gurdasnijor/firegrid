// Wave D-A Shape (b) — pure event handlers.
//
// Two handlers, identical except for the input-dedup gate:
//
//   `sequenceKeyedHandler` — current production shape (Shape C as of #633).
//     Falsification baseline: `event.event.sequence ?? -1` against
//     `state.lastProcessedInputSequence`. Drops the first input because the
//     input fact carries no sequence (intent-derived rows have
//     `sequence: undefined`); `(undefined ?? -1) <= -1` is TRUE.
//
//   `identityKeyedHandler` — Shape (b) target. CC2 directive: membership
//     test against `state.processedInputIds`. First input always delivered;
//     restart idempotency via durable state reload.
//
// Both handlers materialize identical Action ledgers on the GREEN path so
// tests can compare invocation counts and dispatched-action sets directly.
//
// No `WorkflowEngine` in `R`. Pure (state, event) → { newState, action }.

import { Effect, Ref } from "effect"
import {
  loadState,
  saveState,
  type RuntimeContextEventState,
  type RuntimeContextTargetEvent,
  type Substrate,
} from "./resources.ts"

/** Action ledger entry. Every transition emits one — the sim treats a
 *  successful transition as producing a `Dispatched` action whose
 *  `actionId` is stable per event identity (so restart idempotency can be
 *  asserted on the ledger). */
export type Action =
  | { readonly _tag: "Dispatched"; readonly actionId: string }
  | { readonly _tag: "Skipped"; readonly reason: string }

const actionIdForInput = (row: { readonly inputId: string }): string =>
  `dispatched-input-${row.inputId}`

const actionIdForOutput = (row: {
  readonly contextId: string
  readonly sequence: number
}): string => `dispatched-output-${row.contextId}-${row.sequence}`

// ── Shape (b) GREEN handler — identity-keyed input dedup ─────────────────

/**
 * Pure transition. Identity-keyed input dedup (`processedInputIds`
 * membership); sequence-keyed output dedup (outputs DO carry an allocated
 * sequence — asymmetry is correct per the substrate's actual contract).
 */
export const identityKeyedTransition = (
  state: RuntimeContextEventState,
  event: RuntimeContextTargetEvent,
): { readonly newState: RuntimeContextEventState; readonly action: Action } => {
  switch (event._tag) {
    case "Input": {
      if (state.processedInputIds.includes(event.event.inputId)) {
        return {
          newState: state,
          action: { _tag: "Skipped", reason: "input-already-processed" },
        }
      }
      const actionId = actionIdForInput(event.event)
      return {
        newState: {
          ...state,
          processedInputIds: [...state.processedInputIds, event.event.inputId],
          dispatchedActionIds: [...state.dispatchedActionIds, actionId],
        },
        action: { _tag: "Dispatched", actionId },
      }
    }
    case "Output": {
      if (event.event.sequence <= state.lastProcessedOutputSequence) {
        return {
          newState: state,
          action: { _tag: "Skipped", reason: "output-already-processed" },
        }
      }
      const actionId = actionIdForOutput(event.event)
      return {
        newState: {
          ...state,
          lastProcessedOutputSequence: event.event.sequence,
          dispatchedActionIds: [...state.dispatchedActionIds, actionId],
        },
        action: { _tag: "Dispatched", actionId },
      }
    }
  }
}

// ── Falsification baseline — sequence-keyed input dedup (current bug) ────

interface SequenceKeyedState {
  readonly lastProcessedInputSequence: number
  readonly lastProcessedOutputSequence: number
  readonly dispatchedActionIds: ReadonlyArray<string>
}

const initialSequenceKeyedState: SequenceKeyedState = {
  lastProcessedInputSequence: -1,
  lastProcessedOutputSequence: -1,
  dispatchedActionIds: [],
}

/**
 * Mirrors the current `eventAlreadyProcessed` gate at
 * `packages/runtime/src/subscribers/runtime-context/handler.ts:103-120`.
 * `event.event.sequence` is the optional field that intent-derived input
 * rows leave undefined. `??` coerces to `-1`, equal to the initial cursor
 * value ⇒ first input dropped, forever.
 */
export const sequenceKeyedTransition = (
  state: SequenceKeyedState,
  event: RuntimeContextTargetEvent,
): { readonly newState: SequenceKeyedState; readonly action: Action } => {
  switch (event._tag) {
    case "Input": {
      // THE BUG: `RuntimeIngressInputRow` intent-derived rows have no
      // sequence; `(undefined ?? -1) <= -1` is TRUE on first input.
      const seq =
        (event.event as RuntimeIngressInputRowWithMaybeSequence).sequence ?? -1
      if (seq <= state.lastProcessedInputSequence) {
        return {
          newState: state,
          action: { _tag: "Skipped", reason: "input-already-processed" },
        }
      }
      const actionId = actionIdForInput(event.event)
      return {
        newState: {
          ...state,
          lastProcessedInputSequence: seq,
          dispatchedActionIds: [...state.dispatchedActionIds, actionId],
        },
        action: { _tag: "Dispatched", actionId },
      }
    }
    case "Output": {
      if (event.event.sequence <= state.lastProcessedOutputSequence) {
        return {
          newState: state,
          action: { _tag: "Skipped", reason: "output-already-processed" },
        }
      }
      const actionId = actionIdForOutput(event.event)
      return {
        newState: {
          ...state,
          lastProcessedOutputSequence: event.event.sequence,
          dispatchedActionIds: [...state.dispatchedActionIds, actionId],
        },
        action: { _tag: "Dispatched", actionId },
      }
    }
  }
}

interface RuntimeIngressInputRowWithMaybeSequence {
  readonly inputId: string
  readonly contextId: string
  readonly sequence?: number
  readonly kind: "message" | "permission_response"
  readonly payload: unknown
}

// ── Handler (substrate-wired) ─────────────────────────────────────────────

/**
 * Substrate-wired handler. Loads state, applies the pure transition, saves
 * state, advances counters. "Restart" = a second invocation reloads the
 * just-saved state row.
 *
 * Both handlers below are the same shape; only the transition differs.
 */
export const identityKeyedHandler = (substrate: Substrate) =>
  (contextId: string, event: RuntimeContextTargetEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.update(substrate.handlerInvocations, (n) => n + 1)
      const state = yield* loadState(substrate, contextId)
      const { newState, action } = identityKeyedTransition(state, event)
      yield* saveState(substrate, contextId, newState)
      if (action._tag === "Dispatched") {
        yield* Ref.update(substrate.handlerDispatches, (n) => n + 1)
      } else {
        yield* Ref.update(substrate.handlerSkips, (n) => n + 1)
      }
    })

/**
 * Sequence-keyed handler that demonstrates the falsification baseline.
 * Stores its own state shape in a separate Map keyed by contextId — the
 * substrate's per-context state map is the identity-keyed schema.
 */
export const sequenceKeyedHandler = (
  substrate: Substrate,
  legacyStates: Ref.Ref<ReadonlyMap<string, SequenceKeyedState>>,
) =>
  (contextId: string, event: RuntimeContextTargetEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.update(substrate.handlerInvocations, (n) => n + 1)
      yield* Ref.update(substrate.stateReloads, (n) => n + 1)
      const map = yield* Ref.get(legacyStates)
      const state = map.get(contextId) ?? initialSequenceKeyedState
      const { newState, action } = sequenceKeyedTransition(state, event)
      yield* Ref.update(legacyStates, (m) => {
        const next = new Map(m)
        next.set(contextId, newState)
        return next
      })
      if (action._tag === "Dispatched") {
        yield* Ref.update(substrate.handlerDispatches, (n) => n + 1)
      } else {
        yield* Ref.update(substrate.handlerSkips, (n) => n + 1)
      }
    })

export const makeLegacyStateRef = (): Effect.Effect<Ref.Ref<ReadonlyMap<string, SequenceKeyedState>>> =>
  Ref.make<ReadonlyMap<string, SequenceKeyedState>>(new Map())
