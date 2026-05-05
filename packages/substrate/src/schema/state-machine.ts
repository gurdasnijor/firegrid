import type { ChangeEvent } from "@durable-streams/state"
import { createMachine, transition } from "xstate"
import { Data, Effect } from "effect"
import {
  type CompletionKind,
  type CompletionState,
  type CompletionValue,
  type RunState,
  type RunValue,
} from "./rows.ts"
import { substrateState } from "./state.ts"

type CompletionMachineState = CompletionState | "absent"
type RunMachineState = RunState | "absent"

type CompletionTransitionEvent = { readonly type: CompletionState }
type RunTransitionEvent = { readonly type: RunState }

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.1
// awakeables-and-runs.COMPLETION_TRANSITIONS.1
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
// awakeables-and-runs.COMPLETION_TRANSITIONS.3
// awakeables-and-runs.COMPLETION_TRANSITIONS.4
export const completionTransitionMachine = createMachine({
  id: "durable.completion",
  initial: "absent",
  states: {
    absent: {
      on: {
        pending: "pending",
      },
    },
    pending: {
      on: {
        resolved: "resolved",
        rejected: "rejected",
        cancelled: "cancelled",
      },
    },
    resolved: {},
    rejected: {},
    cancelled: {},
  },
})

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.1
// awakeables-and-runs.RUN_TRANSITIONS.1
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
// awakeables-and-runs.RUN_TRANSITIONS.4
// awakeables-and-runs.RUN_TRANSITIONS.5
export const runTransitionMachine = createMachine({
  id: "durable.run",
  initial: "absent",
  states: {
    absent: {
      on: {
        started: "started",
      },
    },
    started: {
      on: {
        blocked: "blocked",
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled",
      },
    },
    blocked: {
      on: {
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled",
      },
    },
    completed: {},
    failed: {},
    cancelled: {},
  },
})

const TERMINAL_COMPLETION_STATES = new Set<CompletionState>([
  "resolved",
  "rejected",
  "cancelled",
])

export function isTerminalCompletion(state: CompletionState): boolean {
  return TERMINAL_COMPLETION_STATES.has(state)
}

const TERMINAL_RUN_STATES = new Set<RunState>([
  "completed",
  "failed",
  "cancelled",
])

export function isTerminalRun(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state)
}

export function isLegalCompletionTransition(
  from: CompletionState | undefined,
  to: CompletionState,
): boolean {
  const event: CompletionTransitionEvent = { type: to }
  const snapshot = completionTransitionMachine.resolveState({
    value: (from ?? "absent") satisfies CompletionMachineState,
    context: {},
  })
  const [next] = transition(completionTransitionMachine, snapshot, event)
  return (
    completionTransitionMachine.getTransitionData(snapshot, event).length > 0 &&
    next.value === to
  )
}

export function isLegalRunTransition(
  from: RunState | undefined,
  to: RunState,
): boolean {
  const event: RunTransitionEvent = { type: to }
  const snapshot = runTransitionMachine.resolveState({
    value: (from ?? "absent") satisfies RunMachineState,
    context: {},
  })
  const [next] = transition(runTransitionMachine, snapshot, event)
  return (
    runTransitionMachine.getTransitionData(snapshot, event).length > 0 &&
    next.value === to
  )
}

export class IllegalCompletionTransition extends Data.TaggedError(
  "IllegalCompletionTransition",
)<{
  readonly completionId: string
  readonly from: CompletionState | undefined
  readonly to: CompletionState
}> {}

export class IllegalRunTransition extends Data.TaggedError(
  "IllegalRunTransition",
)<{
  readonly runId: string
  readonly from: RunState | undefined
  readonly to: RunState
}> {}

const validateCompletionTransition = (
  completionId: string,
  from: CompletionState | undefined,
  to: CompletionState,
): Effect.Effect<void, IllegalCompletionTransition> =>
  isLegalCompletionTransition(from, to)
    ? Effect.void
    : Effect.fail(new IllegalCompletionTransition({ completionId, from, to }))

const validateRunTransition = (
  runId: string,
  from: RunState | undefined,
  to: RunState,
): Effect.Effect<void, IllegalRunTransition> =>
  isLegalRunTransition(from, to)
    ? Effect.void
    : Effect.fail(new IllegalRunTransition({ runId, from, to }))

export interface CreatePendingCompletionInput {
  readonly completionId: string
  readonly workId?: string
  readonly kind: CompletionKind
  readonly data?: unknown
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.AWAKEABLE.1
// awakeables-and-runs.AWAKEABLE.2
// awakeables-and-runs.COMPLETION_TRANSITIONS.1
// durable-records-and-projections.RECORDS.9
export const createPendingCompletion = (
  input: CreatePendingCompletionInput,
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> =>
  Effect.gen(function* () {
    const value: CompletionValue = {
      completionId: input.completionId,
      ...(input.workId !== undefined ? { workId: input.workId } : {}),
      kind: input.kind,
      state: "pending",
      ...(input.data !== undefined ? { data: input.data } : {}),
    }
    yield* validateCompletionTransition(
      input.completionId,
      undefined,
      value.state,
    )
    return substrateState.completions.insert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.AWAKEABLE.3
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export const resolveCompletion = (
  current: CompletionValue,
  args: { readonly result: unknown },
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> =>
  Effect.gen(function* () {
    yield* validateCompletionTransition(
      current.completionId,
      current.state,
      "resolved",
    )
    const value: CompletionValue = {
      ...current,
      state: "resolved",
      result: args.result,
    }
    return substrateState.completions.upsert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.AWAKEABLE.4
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export const rejectCompletion = (
  current: CompletionValue,
  args: { readonly error: unknown },
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> =>
  Effect.gen(function* () {
    yield* validateCompletionTransition(
      current.completionId,
      current.state,
      "rejected",
    )
    const value: CompletionValue = {
      ...current,
      state: "rejected",
      error: args.error,
    }
    return substrateState.completions.upsert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.AWAKEABLE.11
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export const cancelCompletion = (
  current: CompletionValue,
  args: { readonly terminalReason: unknown },
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> =>
  Effect.gen(function* () {
    yield* validateCompletionTransition(
      current.completionId,
      current.state,
      "cancelled",
    )
    const value: CompletionValue = {
      ...current,
      state: "cancelled",
      terminalReason: args.terminalReason,
    }
    return substrateState.completions.upsert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.2
// awakeables-and-runs.RUN_TRANSITIONS.1
// launchable-substrate-host.CLIENT_SURFACE.11
// launchable-substrate-host.CLIENT_SURFACE.12
export const startRun = (input: {
  readonly runId: string
  readonly data?: unknown
}): Effect.Effect<ChangeEvent, IllegalRunTransition> =>
  Effect.gen(function* () {
    const value: RunValue = {
      runId: input.runId,
      state: "started",
      ...(input.data !== undefined ? { data: input.data } : {}),
    }
    yield* validateRunTransition(input.runId, undefined, value.state)
    return substrateState.runs.insert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.3
// awakeables-and-runs.RUN_TRANSITIONS.2
export const blockRun = (
  current: RunValue,
  args: { readonly blockedOnCompletionId: string },
): Effect.Effect<ChangeEvent, IllegalRunTransition> =>
  Effect.gen(function* () {
    yield* validateRunTransition(current.runId, current.state, "blocked")
    const value: RunValue = {
      ...current,
      state: "blocked",
      blockedOnCompletionId: args.blockedOnCompletionId,
    }
    return substrateState.runs.upsert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.4
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
export const completeRun = (
  current: RunValue,
  args: { readonly result: unknown },
): Effect.Effect<ChangeEvent, IllegalRunTransition> =>
  Effect.gen(function* () {
    yield* validateRunTransition(current.runId, current.state, "completed")
    const value: RunValue = { ...current, state: "completed", result: args.result }
    return substrateState.runs.upsert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.5
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
export const failRun = (
  current: RunValue,
  args: { readonly error: unknown },
): Effect.Effect<ChangeEvent, IllegalRunTransition> =>
  Effect.gen(function* () {
    yield* validateRunTransition(current.runId, current.state, "failed")
    const value: RunValue = { ...current, state: "failed", error: args.error }
    return substrateState.runs.upsert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.6
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
export const cancelRun = (
  current: RunValue,
  args: { readonly terminalReason: unknown },
): Effect.Effect<ChangeEvent, IllegalRunTransition> =>
  Effect.gen(function* () {
    yield* validateRunTransition(current.runId, current.state, "cancelled")
    const value: RunValue = {
      ...current,
      state: "cancelled",
      terminalReason: args.terminalReason,
    }
    return substrateState.runs.upsert({ value })
  })

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.5
const firstValidTerminalFold = <A>(
  records: ReadonlyArray<A>,
  matchesTarget: (record: A) => boolean,
  isTerminal: (record: A) => boolean,
): A | undefined => {
  let winner: A | undefined
  for (const record of records) {
    if (!matchesTarget(record)) continue
    if (winner === undefined) {
      winner = record
      continue
    }
    if (isTerminal(winner)) {
      continue
    }
    winner = record
  }
  return winner
}

// awakeables-and-runs.COMPLETION_TRANSITIONS.5
// awakeables-and-runs.COMPLETION_TRANSITIONS.6
// awakeables-and-runs.AWAKEABLE.10
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.5
export function foldCompletionRecords(
  completionId: string,
  records: ReadonlyArray<CompletionValue>,
): CompletionValue | undefined {
  return firstValidTerminalFold(
    records,
    (record) => record.completionId === completionId,
    (record) => isTerminalCompletion(record.state),
  )
}

// awakeables-and-runs.RUN_TRANSITIONS.6
// awakeables-and-runs.RUN_TRANSITIONS.7
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.5
export function foldRunRecords(
  runId: string,
  records: ReadonlyArray<RunValue>,
): RunValue | undefined {
  return firstValidTerminalFold(
    records,
    (record) => record.runId === runId,
    (record) => isTerminalRun(record.state),
  )
}

export type DerivedRunOutcome =
  | { readonly kind: "noop" }
  | { readonly kind: "fail"; readonly error: unknown }
  | { readonly kind: "cancel"; readonly terminalReason: unknown }

// awakeables-and-runs.RUN.8
// awakeables-and-runs.RUN.9
// awakeables-and-runs.RUN.10
// awakeables-and-runs.RUN.11
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
