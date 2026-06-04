import type { Future } from "./future.ts"

export type TypedState = Record<string, unknown>
export type UntypedState = { readonly _: never }

export interface SharedState<TState extends TypedState = UntypedState> {
  get<TValue, TKey extends keyof TState = string>(
    name: TState extends UntypedState ? string : TKey,
  ): Future<(TState extends UntypedState ? TValue : TState[TKey]) | null>

  keys(): Future<Array<string>>
}

export interface State<TState extends TypedState = UntypedState>
  extends SharedState<TState>
{
  set<TValue, TKey extends keyof TState = string>(
    name: TState extends UntypedState ? string : TKey,
    value: TState extends UntypedState ? TValue : TState[TKey],
  ): void

  clear<TKey extends keyof TState>(
    name: TState extends UntypedState ? string : TKey,
  ): void

  clearAll(): void
}
