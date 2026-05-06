import type { ChangeEvent } from "@durable-streams/state"
import { Data, Effect, Match } from "effect"
import {
  type CompletionKind,
  type CompletionState,
  type CompletionValue,
  type RunState,
  type RunValue,
} from "./schema/rows.ts"
import { substrateState } from "./schema/state.ts"

type CompletionMachineState = CompletionState | "absent"
type RunMachineState = RunState | "absent"

type TransitionAdjacency<State extends string, Target extends string> = {
  readonly [Key in State]: readonly Target[]
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.1
// awakeables-and-runs.COMPLETION_TRANSITIONS.1
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
// awakeables-and-runs.COMPLETION_TRANSITIONS.3
// awakeables-and-runs.COMPLETION_TRANSITIONS.4
export const completionTransitionMachine = {
  absent: ["pending"],
  pending: ["resolved", "rejected", "cancelled"],
  resolved: [],
  rejected: [],
  cancelled: [],
} as const satisfies TransitionAdjacency<
  CompletionMachineState,
  CompletionState
>

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.1
// awakeables-and-runs.RUN_TRANSITIONS.1
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
// awakeables-and-runs.RUN_TRANSITIONS.4
// awakeables-and-runs.RUN_TRANSITIONS.5
export const runTransitionMachine = {
  absent: ["started"],
  started: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionAdjacency<RunMachineState, RunState>

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

const isLegalTransition = <State extends string>(
  machine: TransitionAdjacency<State | "absent", State>,
  from: State | undefined,
  to: State,
): boolean => machine[from ?? "absent"].includes(to)

export function isLegalCompletionTransition(
  from: CompletionState | undefined,
  to: CompletionState,
): boolean {
  return isLegalTransition(completionTransitionMachine, from, to)
}

export function isLegalRunTransition(
  from: RunState | undefined,
  to: RunState,
): boolean {
  return isLegalTransition(runTransitionMachine, from, to)
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

const validatedChangeEvent = <E>(
  validate: Effect.Effect<void, E>,
  event: ChangeEvent,
): Effect.Effect<ChangeEvent, E> => validate.pipe(Effect.as(event))

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
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> => {
  const value: CompletionValue = {
    completionId: input.completionId,
    ...(input.workId !== undefined ? { workId: input.workId } : {}),
    kind: input.kind,
    state: "pending",
    ...(input.data !== undefined ? { data: input.data } : {}),
  }
  return validatedChangeEvent(
    validateCompletionTransition(
      input.completionId,
      undefined,
      value.state,
    ),
    substrateState.completions.insert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.AWAKEABLE.3
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export const resolveCompletion = (
  current: CompletionValue,
  args: { readonly result: unknown },
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> => {
  const value: CompletionValue = {
    ...current,
    state: "resolved",
    result: args.result,
  }
  return validatedChangeEvent(
    validateCompletionTransition(current.completionId, current.state, "resolved"),
    substrateState.completions.upsert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.AWAKEABLE.4
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export const rejectCompletion = (
  current: CompletionValue,
  args: { readonly error: unknown },
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> => {
  const value: CompletionValue = {
    ...current,
    state: "rejected",
    error: args.error,
  }
  return validatedChangeEvent(
    validateCompletionTransition(current.completionId, current.state, "rejected"),
    substrateState.completions.upsert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.AWAKEABLE.11
// awakeables-and-runs.COMPLETION_TRANSITIONS.2
export const cancelCompletion = (
  current: CompletionValue,
  args: { readonly terminalReason: unknown },
): Effect.Effect<ChangeEvent, IllegalCompletionTransition> => {
  const value: CompletionValue = {
    ...current,
    state: "cancelled",
    terminalReason: args.terminalReason,
  }
  return validatedChangeEvent(
    validateCompletionTransition(current.completionId, current.state, "cancelled"),
    substrateState.completions.upsert({ value }),
  )
}

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
}): Effect.Effect<ChangeEvent, IllegalRunTransition> => {
  const value: RunValue = {
    runId: input.runId,
    state: "started",
    ...(input.data !== undefined ? { data: input.data } : {}),
  }
  return validatedChangeEvent(
    validateRunTransition(input.runId, undefined, value.state),
    substrateState.runs.insert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.3
// awakeables-and-runs.RUN_TRANSITIONS.2
export const blockRun = (
  current: RunValue,
  args: { readonly blockedOnCompletionId: string },
): Effect.Effect<ChangeEvent, IllegalRunTransition> => {
  const value: RunValue = {
    ...current,
    state: "blocked",
    blockedOnCompletionId: args.blockedOnCompletionId,
  }
  return validatedChangeEvent(
    validateRunTransition(current.runId, current.state, "blocked"),
    substrateState.runs.upsert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.4
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
export const completeRun = (
  current: RunValue,
  args: { readonly result: unknown },
): Effect.Effect<ChangeEvent, IllegalRunTransition> => {
  const value: RunValue = { ...current, state: "completed", result: args.result }
  return validatedChangeEvent(
    validateRunTransition(current.runId, current.state, "completed"),
    substrateState.runs.upsert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.5
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
export const failRun = (
  current: RunValue,
  args: { readonly error: unknown },
): Effect.Effect<ChangeEvent, IllegalRunTransition> => {
  const value: RunValue = { ...current, state: "failed", error: args.error }
  return validatedChangeEvent(
    validateRunTransition(current.runId, current.state, "failed"),
    substrateState.runs.upsert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3
// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// awakeables-and-runs.RUN.6
// awakeables-and-runs.RUN_TRANSITIONS.2
// awakeables-and-runs.RUN_TRANSITIONS.3
export const cancelRun = (
  current: RunValue,
  args: { readonly terminalReason: unknown },
): Effect.Effect<ChangeEvent, IllegalRunTransition> => {
  const value: RunValue = {
    ...current,
    state: "cancelled",
    terminalReason: args.terminalReason,
  }
  return validatedChangeEvent(
    validateRunTransition(current.runId, current.state, "cancelled"),
    substrateState.runs.upsert({ value }),
  )
}

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.5
const foldFirstValidTerminalWinner = <A>(
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
  return foldFirstValidTerminalWinner(
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
  return foldFirstValidTerminalWinner(
    records,
    (record) => record.runId === runId,
    (record) => isTerminalRun(record.state),
  )
}

type DerivedRunOutcome =
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
  return Match.value(awaitedCompletion).pipe(
    Match.when({ state: "rejected" }, (completion) => ({
      kind: "fail" as const,
      error: completion.error,
    })),
    Match.when({ state: "cancelled" }, (completion) => ({
      kind: "cancel" as const,
      terminalReason: completion.terminalReason,
    })),
    Match.orElse(() => ({ kind: "noop" as const })),
  )
}
