import type { ChangeEvent } from "@durable-streams/state"
import { Effect, Either } from "effect"
import type {
  CompletionValue,
  RunValue,
} from "../schema/rows.ts"
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
  type CreatePendingCompletionInput,
} from "../schema/state-machine.ts"

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
} from "../schema/state-machine.ts"

const runSyncAtTestBoundary = <A, E extends Error>(
  effect: Effect.Effect<A, E>,
): A => {
  const result = Effect.runSync(Effect.either(effect))
  if (Either.isLeft(result)) throw result.left
  return result.right
}

export const createPendingCompletion = (
  input: CreatePendingCompletionInput,
): ChangeEvent => runSyncAtTestBoundary(createPendingCompletionEffect(input))

export const resolveCompletion = (
  current: CompletionValue,
  args: { readonly result: unknown },
): ChangeEvent => runSyncAtTestBoundary(resolveCompletionEffect(current, args))

export const rejectCompletion = (
  current: CompletionValue,
  args: { readonly error: unknown },
): ChangeEvent => runSyncAtTestBoundary(rejectCompletionEffect(current, args))

export const cancelCompletion = (
  current: CompletionValue,
  args: { readonly terminalReason: unknown },
): ChangeEvent => runSyncAtTestBoundary(cancelCompletionEffect(current, args))

export const startRun = (input: {
  readonly runId: string
  readonly data?: unknown
}): ChangeEvent => runSyncAtTestBoundary(startRunEffect(input))

export const blockRun = (
  current: RunValue,
  args: { readonly blockedOnCompletionId: string },
): ChangeEvent => runSyncAtTestBoundary(blockRunEffect(current, args))

export const completeRun = (
  current: RunValue,
  args: { readonly result: unknown },
): ChangeEvent => runSyncAtTestBoundary(completeRunEffect(current, args))

export const failRun = (
  current: RunValue,
  args: { readonly error: unknown },
): ChangeEvent => runSyncAtTestBoundary(failRunEffect(current, args))

export const cancelRun = (
  current: RunValue,
  args: { readonly terminalReason: unknown },
): ChangeEvent => runSyncAtTestBoundary(cancelRunEffect(current, args))
