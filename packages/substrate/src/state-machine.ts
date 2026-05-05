import type { Effect } from "effect"
import { Either, Effect as EffectRuntime } from "effect"
import type { ChangeEvent } from "@durable-streams/state"
import type {
  CompletionValue,
  RunValue,
} from "./schema/rows.ts"
import {
  blockRun as blockRunEffect,
  cancelCompletion as cancelCompletionEffect,
  cancelRun as cancelRunEffect,
  completeRun as completeRunEffect,
  createPendingCompletion as createPendingCompletionEffect,
  failRun as failRunEffect,
  rejectCompletion as rejectCompletionEffect,
  resolveCompletion as resolveCompletionEffect,
  startRun as startRunEffect,
} from "./schema/state-machine.ts"
import type {
  CreatePendingCompletionInput,
} from "./schema/state-machine.ts"

export {
  completionTransitionMachine,
  deriveBlockedRunOutcome,
  foldCompletionRecords,
  foldRunRecords,
  IllegalCompletionTransition,
  IllegalRunTransition,
  isLegalCompletionTransition,
  isLegalRunTransition,
  isTerminalCompletion,
  isTerminalRun,
  runTransitionMachine,
  type CreatePendingCompletionInput,
  type DerivedRunOutcome,
} from "./schema/state-machine.ts"

const runUnsafe = <A, E extends Error>(effect: Effect.Effect<A, E>): A => {
  const result = EffectRuntime.runSync(EffectRuntime.either(effect))
  if (Either.isLeft(result)) {
    throw result.left
  }
  return result.right
}

export function createPendingCompletion(
  input: CreatePendingCompletionInput,
): ChangeEvent {
  return runUnsafe(createPendingCompletionEffect(input))
}

export function resolveCompletion(
  current: CompletionValue,
  args: { readonly result: unknown },
): ChangeEvent {
  return runUnsafe(resolveCompletionEffect(current, args))
}

export function rejectCompletion(
  current: CompletionValue,
  args: { readonly error: unknown },
): ChangeEvent {
  return runUnsafe(rejectCompletionEffect(current, args))
}

export function cancelCompletion(
  current: CompletionValue,
  args: { readonly terminalReason: unknown },
): ChangeEvent {
  return runUnsafe(cancelCompletionEffect(current, args))
}

export function startRun(input: {
  readonly runId: string
  readonly data?: unknown
}): ChangeEvent {
  return runUnsafe(startRunEffect(input))
}

export function blockRun(
  current: RunValue,
  args: { readonly blockedOnCompletionId: string },
): ChangeEvent {
  return runUnsafe(blockRunEffect(current, args))
}

export function completeRun(
  current: RunValue,
  args: { readonly result: unknown },
): ChangeEvent {
  return runUnsafe(completeRunEffect(current, args))
}

export function failRun(
  current: RunValue,
  args: { readonly error: unknown },
): ChangeEvent {
  return runUnsafe(failRunEffect(current, args))
}

export function cancelRun(
  current: RunValue,
  args: { readonly terminalReason: unknown },
): ChangeEvent {
  return runUnsafe(cancelRunEffect(current, args))
}
