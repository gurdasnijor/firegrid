import type { Effect } from "effect"

export interface OperatorSource<Fact, Error = never, Requirements = never> {
  readonly sourceId: string
  readonly scan: Effect.Effect<ReadonlyArray<Fact>, Error, Requirements>
}
