import { Effect } from "effect"
import { type FluentFiregridError } from "./error.ts"
import { makePrimitive, type Operation, type PrimitiveOperation } from "./operation.ts"
import type { FluentRequirements } from "./schema.ts"

export class Future<T> implements Operation<T> {
  private readonly leaf: PrimitiveOperation<T>
  private memo:
    | { readonly _tag: "Success"; readonly value: T }
    | { readonly _tag: "Failure"; readonly error: FluentFiregridError }
    | undefined
  readonly effect: Effect.Effect<T, FluentFiregridError, FluentRequirements>

  constructor(
    backing: Effect.Effect<T, FluentFiregridError, FluentRequirements>,
  ) {
    this.leaf = makePrimitive({ _tag: "Leaf", future: this })
    this.effect = Effect.suspend(() => {
      if (this.memo !== undefined) {
        return this.memo._tag === "Success"
          ? Effect.succeed(this.memo.value)
          : Effect.fail(this.memo.error)
      }
      return Effect.matchEffect(backing, {
        onFailure: (error) =>
          Effect.sync(() => {
            this.memo = { _tag: "Failure", error }
          }).pipe(Effect.andThen(Effect.fail(error))),
        onSuccess: (value) =>
          Effect.sync(() => {
            this.memo = { _tag: "Success", value }
          }).pipe(Effect.andThen(Effect.succeed(value))),
      })
    })
  }

  [Symbol.iterator](): Iterator<unknown, T, unknown> {
    return this.leaf[Symbol.iterator]()
  }
}

export type FutureValues<T extends readonly Future<unknown>[] | []> = {
  -readonly [P in keyof T]: T[P] extends Future<infer Value> ? Value : never
}

export type FutureValue<T> = T extends Future<infer Value> ? Value : never

export type FutureSettledResult<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }

export type SelectBranches = Record<string, Future<unknown>>

export type SelectResult<Branches extends SelectBranches> = {
  readonly [Key in keyof Branches]: {
    readonly tag: Key
    readonly future: Branches[Key]
  }
}[keyof Branches]
