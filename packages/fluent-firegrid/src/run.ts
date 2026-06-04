import { Effect } from "effect"

// fluent-firegrid-keystone.DURABLE_RUN.1
export type RunAction<T> = (
  options: { readonly signal: AbortSignal },
) => T | Promise<T> | Effect.Effect<T, unknown>

export interface RunOptions {
  readonly name?: string
}

export type SleepDuration = number


export const effectFromStep = <T>(
  action: RunAction<T>,
): Effect.Effect<T, unknown> =>
  Effect.suspend(() => {
    const result = action({ signal: new AbortController().signal })
    if (Effect.isEffect(result)) return result
    return Effect.promise(() => Promise.resolve(result))
  })
