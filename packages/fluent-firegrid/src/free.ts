import { FluentFiregridError } from "./error.ts"
import { type Future, type FutureSettledResult, type FutureValue, type FutureValues, type SelectBranches, type SelectResult } from "./future.ts"
import { getCurrentScheduler } from "./current.ts"
import type { Operation } from "./operation.ts"
import type { RunAction, RunOptions, SleepDuration } from "./run.ts"
import type { SharedState, State, TypedState, UntypedState } from "./state.ts"

const requireScheduler = (name: string) => {
  const scheduler = getCurrentScheduler()
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: `${name}() must be called inside execute(ctx, gen(...))`,
    })
  }
  return scheduler
}

export const run = <T>(
  action: RunAction<T>,
  options?: RunOptions,
): Future<T> => requireScheduler("run").run(action, options)

export const all = <const T extends readonly Future<unknown>[] | []>(
  futures: T,
): Future<FutureValues<T>> =>
  // fluent-firegrid-keystone.FREE.2
  requireScheduler("all").all(futures)

export const state = <
  TState extends TypedState = UntypedState,
>(): State<TState> => requireScheduler("state").state<TState>()

export const sharedState = <
  TState extends TypedState = UntypedState,
>(): SharedState<TState> => requireScheduler("sharedState").sharedState<TState>()

export const race = <const T extends readonly [Future<unknown>, ...Array<Future<unknown>>]>(
  futures: T,
): Future<FutureValue<T[number]>> => requireScheduler("race").race(futures)

export const any = <const T extends readonly Future<unknown>[] | []>(
  futures: T,
): Future<FutureValue<T[number]>> => requireScheduler("any").any(futures)

export const allSettled = <const T extends readonly Future<unknown>[] | []>(
  futures: T,
): Future<{ -readonly [P in keyof T]: FutureSettledResult<FutureValue<T[P]>> }> =>
  requireScheduler("allSettled").allSettled(futures)

export const select = <const Branches extends SelectBranches>(
  branches: Branches,
): Future<SelectResult<Branches>> => requireScheduler("select").select(branches)

export const spawn = <T>(operation: Operation<T>): Future<T> =>
  requireScheduler("spawn").spawn(operation)

export const sleep = (
  durationMs: SleepDuration,
  name?: string,
): Future<void> => requireScheduler("sleep").sleep(durationMs, name)
