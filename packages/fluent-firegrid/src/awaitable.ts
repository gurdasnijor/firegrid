import { Effect } from "effect"
import type { FluentFiregridError } from "./error.ts"
import type { FluentRequirements } from "./schema.ts"

// fluent-firegrid-keystone.AWAITABLE.1
export interface Awaitable<T> {
  readonly effect: Effect.Effect<T, FluentFiregridError, FluentRequirements>
  readonly map: <U>(
    mapper: (value: T | undefined, error: unknown) => U,
  ) => Awaitable<U>
}

class EffectAwaitable<T> implements Awaitable<T> {
  constructor(
    readonly effect: Effect.Effect<T, FluentFiregridError, FluentRequirements>,
  ) {}

  map<U>(
    mapper: (value: T | undefined, error: unknown) => U,
  ): Awaitable<U> {
    return new EffectAwaitable(
      Effect.match(this.effect, {
        onFailure: (error) => mapper(undefined, error),
        onSuccess: (value) => mapper(value, undefined),
      }),
    )
  }
}

export const fromEffect = <T>(
  effect: Effect.Effect<T, FluentFiregridError, FluentRequirements>,
): Awaitable<T> => new EffectAwaitable(effect)
