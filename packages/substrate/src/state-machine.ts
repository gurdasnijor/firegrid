import type { ChangeEvent } from "@durable-streams/state"
import {
  type CompletionKind,
  type CompletionState,
  type CompletionValue,
  type RunState,
  type RunValue,
} from "./rows.js"
import { substrateState } from "./state-schema.js"

// awakeables-and-runs.COMPLETION_TRANSITIONS.3
const TERMINAL_COMPLETION_STATES = new Set<CompletionState>([
  "resolved",
  "rejected",
  "cancelled",
])
export function isTerminalCompletion(state: CompletionState): boolean {
  return TERMINAL_COMPLETION_STATES.has(state)
}

// awakeables-and-runs.RUN_TRANSITIONS.4
const TERMINAL_RUN_STATES = new Set<RunState>([
  "completed",
  "failed",
  "cancelled",
])
export function isTerminalRun(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state)
}

// awakeables-and-runs.COMPLETION_TRANSITIONS.1, .2, .4
export function isLegalCompletionTransition(
  from: CompletionState | undefined,
  to: CompletionState,
): boolean {
  if (from === undefined) return to === "pending"
  if (from === "pending") return TERMINAL_COMPLETION_STATES.has(to)
  // Terminal completions never transition again.
  return false
}

// awakeables-and-runs.RUN_TRANSITIONS.1, .2, .3, .5
export function isLegalRunTransition(
  from: RunState | undefined,
  to: RunState,
): boolean {
  if (from === undefined) return to === "started"
  if (from === "started") {
    return to === "blocked" || TERMINAL_RUN_STATES.has(to)
  }
  if (from === "blocked") return TERMINAL_RUN_STATES.has(to)
  // Terminal runs never transition again.
  return false
}

export class IllegalCompletionTransition extends Error {
  readonly _tag = "IllegalCompletionTransition"
  constructor(
    readonly completionId: string,
    readonly from: CompletionState | undefined,
    readonly to: CompletionState,
  ) {
    super(`illegal completion transition for ${completionId}: ${from ?? "absent"} -> ${to}`)
  }
}

export class IllegalRunTransition extends Error {
  readonly _tag = "IllegalRunTransition"
  constructor(
    readonly runId: string,
    readonly from: RunState | undefined,
    readonly to: RunState,
  ) {
    super(`illegal run transition for ${runId}: ${from ?? "absent"} -> ${to}`)
  }
}

// awakeables-and-runs.AWAKEABLE.1, .2 — completion creation.
// awakeables-and-runs.COMPLETION_TRANSITIONS.1
// durable-records-and-projections.RECORDS.9 — pending completions may carry optional data.
export interface CreatePendingCompletionInput {
  readonly completionId: string
  readonly workId?: string
  readonly kind: CompletionKind
  readonly data?: unknown
}

export function createPendingCompletion(
  input: CreatePendingCompletionInput,
): ChangeEvent {
  const value: CompletionValue = {
    completionId: input.completionId,
    ...(input.workId !== undefined ? { workId: input.workId } : {}),
    kind: input.kind,
    state: "pending",
    ...(input.data !== undefined ? { data: input.data } : {}),
  }
  if (!isLegalCompletionTransition(undefined, value.state)) {
    throw new IllegalCompletionTransition(input.completionId, undefined, value.state)
  }
  return substrateState.completions.insert({ value })
}

// awakeables-and-runs.AWAKEABLE.3
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export function resolveCompletion(
  current: CompletionValue,
  args: { result: unknown },
): ChangeEvent {
  if (!isLegalCompletionTransition(current.state, "resolved")) {
    throw new IllegalCompletionTransition(current.completionId, current.state, "resolved")
  }
  const value: CompletionValue = { ...current, state: "resolved", result: args.result }
  return substrateState.completions.upsert({ value })
}

// awakeables-and-runs.AWAKEABLE.4
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export function rejectCompletion(
  current: CompletionValue,
  args: { error: unknown },
): ChangeEvent {
  if (!isLegalCompletionTransition(current.state, "rejected")) {
    throw new IllegalCompletionTransition(current.completionId, current.state, "rejected")
  }
  const value: CompletionValue = { ...current, state: "rejected", error: args.error }
  return substrateState.completions.upsert({ value })
}

// awakeables-and-runs.AWAKEABLE.11
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export function cancelCompletion(
  current: CompletionValue,
  args: { terminalReason: unknown },
): ChangeEvent {
  if (!isLegalCompletionTransition(current.state, "cancelled")) {
    throw new IllegalCompletionTransition(current.completionId, current.state, "cancelled")
  }
  const value: CompletionValue = {
    ...current,
    state: "cancelled",
    terminalReason: args.terminalReason,
  }
  return substrateState.completions.upsert({ value })
}

// awakeables-and-runs.RUN.2
// awakeables-and-runs.RUN_TRANSITIONS.1
// launchable-substrate-host.CLIENT_SURFACE.11
// launchable-substrate-host.CLIENT_SURFACE.12
// `data` is optional caller input carried on the durable.run row from
// declaration onward. It is NOT enforced or interpreted by the substrate.
export function startRun(input: {
  readonly runId: string
  readonly data?: unknown
}): ChangeEvent {
  const value: RunValue = {
    runId: input.runId,
    state: "started",
    ...(input.data !== undefined ? { data: input.data } : {}),
  }
  if (!isLegalRunTransition(undefined, value.state)) {
    throw new IllegalRunTransition(input.runId, undefined, value.state)
  }
  return substrateState.runs.insert({ value })
}

// awakeables-and-runs.RUN.3
// awakeables-and-runs.RUN_TRANSITIONS.2
export function blockRun(
  current: RunValue,
  args: { blockedOnCompletionId: string },
): ChangeEvent {
  if (!isLegalRunTransition(current.state, "blocked")) {
    throw new IllegalRunTransition(current.runId, current.state, "blocked")
  }
  const value: RunValue = {
    ...current,
    state: "blocked",
    blockedOnCompletionId: args.blockedOnCompletionId,
  }
  return substrateState.runs.upsert({ value })
}

// awakeables-and-runs.RUN.4
// awakeables-and-runs.RUN_TRANSITIONS.2, .3
export function completeRun(
  current: RunValue,
  args: { result: unknown },
): ChangeEvent {
  if (!isLegalRunTransition(current.state, "completed")) {
    throw new IllegalRunTransition(current.runId, current.state, "completed")
  }
  const value: RunValue = { ...current, state: "completed", result: args.result }
  return substrateState.runs.upsert({ value })
}

// awakeables-and-runs.RUN.5
// awakeables-and-runs.RUN_TRANSITIONS.2, .3
export function failRun(
  current: RunValue,
  args: { error: unknown },
): ChangeEvent {
  if (!isLegalRunTransition(current.state, "failed")) {
    throw new IllegalRunTransition(current.runId, current.state, "failed")
  }
  const value: RunValue = { ...current, state: "failed", error: args.error }
  return substrateState.runs.upsert({ value })
}

// awakeables-and-runs.RUN.6
// awakeables-and-runs.RUN_TRANSITIONS.2, .3
export function cancelRun(
  current: RunValue,
  args: { terminalReason: unknown },
): ChangeEvent {
  if (!isLegalRunTransition(current.state, "cancelled")) {
    throw new IllegalRunTransition(current.runId, current.state, "cancelled")
  }
  const value: RunValue = {
    ...current,
    state: "cancelled",
    terminalReason: args.terminalReason,
  }
  return substrateState.runs.upsert({ value })
}

// awakeables-and-runs.COMPLETION_TRANSITIONS.5, .6
// awakeables-and-runs.AWAKEABLE.10
// First-valid-terminal-wins fold over in-order completion records, scoped to a
// target completionId. Records for other completionIds are filtered out so a
// caller can pass a broader retained list (later raw retained reads will
// naturally include records for multiple ids) without affecting the winner.
// Later conflicting terminal records for the target id remain in the input as
// evidence; the fold only chooses the winner and never mutates the input.
export function foldCompletionRecords(
  completionId: string,
  records: ReadonlyArray<CompletionValue>,
): CompletionValue | undefined {
  let winner: CompletionValue | undefined
  for (const r of records) {
    if (r.completionId !== completionId) continue
    if (winner === undefined) {
      winner = r
      continue
    }
    if (isTerminalCompletion(winner.state)) {
      // First-valid-terminal already chosen; later records are evidence only.
      continue
    }
    winner = r
  }
  return winner
}

// awakeables-and-runs.RUN_TRANSITIONS.6, .7
// First-valid-terminal-wins fold over in-order run records, scoped to a target
// runId. Records for other runIds are filtered out for the same reason as
// foldCompletionRecords above.
export function foldRunRecords(
  runId: string,
  records: ReadonlyArray<RunValue>,
): RunValue | undefined {
  let winner: RunValue | undefined
  for (const r of records) {
    if (r.runId !== runId) continue
    if (winner === undefined) {
      winner = r
      continue
    }
    if (isTerminalRun(winner.state)) {
      continue
    }
    winner = r
  }
  return winner
}

// awakeables-and-runs.RUN.8, .9, .10, .11
// Pure policy function: when a blocked run's awaited completion terminalizes,
// derive the run's downstream outcome under the minimal profile.
//   rejected  completion -> fail   (RUN.8)
//   cancelled completion -> cancel (RUN.9)
//   resolved  completion -> noop here; ReadyWorkProjection re-arms the run (RUN.11)
// RUN.10 is satisfied across the rejected/cancelled branches; the resolved branch
// is satisfied by ready-work derivation in a later feature, not by this policy.
export type DerivedRunOutcome =
  | { readonly kind: "noop" }
  | { readonly kind: "fail"; readonly error: unknown }
  | { readonly kind: "cancel"; readonly terminalReason: unknown }

export function deriveBlockedRunOutcome(
  blockedRun: RunValue,
  awaitedCompletion: CompletionValue,
): DerivedRunOutcome {
  if (
    blockedRun.state !== "blocked" ||
    blockedRun.blockedOnCompletionId !== awaitedCompletion.completionId
  ) {
    return { kind: "noop" }
  }
  switch (awaitedCompletion.state) {
    case "rejected":
      return { kind: "fail", error: awaitedCompletion.error }
    case "cancelled":
      return { kind: "cancel", terminalReason: awaitedCompletion.terminalReason }
    case "resolved":
    case "pending":
      return { kind: "noop" }
  }
}
