import { Effect, Either } from "effect"
import { fromEffect } from "./awaitable.ts"
import { FluentFiregridError, toFluentError } from "./error.ts"
import {
  Future,
  type FutureSettledResult,
  type FutureValue,
  type FutureValues,
  type SelectBranches,
  type SelectResult,
} from "./future.ts"
import { isPrimitiveOperation, operationTag, type Operation } from "./operation.ts"
import {
  failFromSettled,
  type OperationProducers,
  toSettled,
} from "./operations.ts"
import type { RunAction, RunOptions, SleepDuration } from "./run.ts"
import type { FluentRequirements } from "./schema.ts"
import type { SharedState, State, TypedState, UntypedState } from "./state.ts"
import { withCurrentScheduler } from "./current.ts"

const throwableFromFutureFailure = (error: FluentFiregridError): unknown =>
  error.cause instanceof AggregateError ? error.cause : error

// fluent-firegrid-keystone.ENGINE.2
export class Scheduler {
  constructor(
    private readonly operations: OperationProducers,
  ) {}

  run<T>(action: RunAction<T>, options: RunOptions = {}): Future<T> {
    return this.operations.run(action, options)
  }

  sleep(durationMs: SleepDuration, name = "sleep"): Future<void> {
    return this.operations.sleep(durationMs, name)
  }

  all<const T extends readonly Future<unknown>[] | []>(
    futures: T,
  ): Future<FutureValues<T>> {
    // fluent-firegrid-keystone.FREE.1
    return new Future(fromEffect(
      Effect.gen(function* () {
        const unique: Array<Future<unknown>> = []
        const positions = new Map<Future<unknown>, number>()
        const resultPositions = new Array<number>(futures.length)

        for (let index = 0; index < futures.length; index += 1) {
          const future = futures[index]
          if (future === undefined) continue
          const knownPosition = positions.get(future)
          if (knownPosition !== undefined) {
            resultPositions[index] = knownPosition
            continue
          }
          const position = unique.length
          positions.set(future, position)
          resultPositions[index] = position
          unique.push(future)
        }

        const uniqueResults = yield* Effect.all(
          unique.map((future) => future.effect),
          { concurrency: "unbounded" },
        )
        return resultPositions.map((position) => uniqueResults[position]) as FutureValues<T>
      }),
    ))
  }

  state<TState extends TypedState = UntypedState>(): State<TState> {
    return this.operations.state<TState>()
  }

  sharedState<TState extends TypedState = UntypedState>(): SharedState<TState> {
    return this.operations.sharedState<TState>()
  }

  race<const T extends readonly [Future<unknown>, ...Array<Future<unknown>>]>(
    futures: T,
  ): Future<FutureValue<T[number]>> {
    // fluent-firegrid-keystone.FREE.5
    return new Future(fromEffect(
      Effect.gen(this, function* () {
        const winner = yield* this.operations.raceIndexed(
          futures,
          { name: "race" },
        ).effect
        return yield* failFromSettled(
          winner.result,
          "race() winner rejected",
        ) as Effect.Effect<FutureValue<T[number]>, FluentFiregridError>
      }),
    ))
  }

  any<const T extends readonly Future<unknown>[] | []>(
    futures: T,
  ): Future<FutureValue<T[number]>> {
    // fluent-firegrid-keystone.FREE.5
    return new Future(fromEffect(
      Effect.gen(this, function* () {
        const remaining = futures.slice()
        const errors: Array<unknown> = []

        while (remaining.length > 0) {
          const first = remaining[0]
          if (first === undefined) break
          const nonEmptyRemaining: [Future<unknown>, ...Array<Future<unknown>>] = [
            first,
            ...remaining.slice(1),
          ]
          const winner = yield* this.operations.raceIndexed(nonEmptyRemaining).effect
          if (winner.result.status === "fulfilled") {
            return winner.result.value as FutureValue<T[number]>
          }
          errors.push(winner.result.reason)
          remaining.splice(winner.index, 1)
        }

        return yield* new FluentFiregridError({
          message: "any() rejected because every Future rejected",
          cause: new AggregateError(errors),
        })
      }),
    ))
  }

  allSettled<const T extends readonly Future<unknown>[] | []>(
    futures: T,
  ): Future<{ -readonly [P in keyof T]: FutureSettledResult<FutureValue<T[P]>> }> {
    // fluent-firegrid-keystone.FREE.5
    return new Future(fromEffect(
      Effect.gen(function* () {
        const results = yield* Effect.all(
          futures.map((future) => toSettled(future)),
          { concurrency: "unbounded" },
        )
        return results as { -readonly [P in keyof T]: FutureSettledResult<FutureValue<T[P]>> }
      }),
    ))
  }

  select<const Branches extends SelectBranches>(
    branches: Branches,
  ): Future<SelectResult<Branches>> {
    // fluent-firegrid-keystone.FREE.6
    return new Future(fromEffect(
      Effect.gen(this, function* () {
        const entries = Object.entries(branches) as Array<
          [keyof Branches, Branches[keyof Branches]]
        >
        if (entries.length === 0) {
          return yield* new FluentFiregridError({
            message: "select() requires at least one branch",
          })
        }
        const futures = entries.map((entry) => entry[1])
        const first = futures[0]
        if (first === undefined) {
          return yield* new FluentFiregridError({
            message: "select() requires at least one branch",
          })
        }
        const nonEmptyFutures: [Future<unknown>, ...Array<Future<unknown>>] = [
          first,
          ...futures.slice(1),
        ]
        const winner = yield* this.operations.raceIndexed(
          nonEmptyFutures,
          { name: "select" },
        ).effect
        const entry = entries[winner.index]
        if (entry === undefined) {
          return yield* new FluentFiregridError({
            message: `select() winner index ${winner.index} did not match a branch`,
          })
        }
        const selected: SelectResult<Branches> = {
          tag: entry[0],
          future: entry[1],
        }
        return selected
      }),
    ))
  }

  spawn<T>(operation: Operation<T>): Future<T> {
    return this.operations.spawn(operation)
  }

  drive<T>(operation: Operation<T>): Effect.Effect<T, FluentFiregridError, FluentRequirements> {
    return Effect.gen(this, function* () {
      const iterator = operation[Symbol.iterator]()
      let resume: unknown = undefined
      let failure: unknown = undefined

      while (true) {
        const next = yield* Effect.sync(() =>
          withCurrentScheduler(this, () => {
            if (failure === undefined) return iterator.next(resume)
            if (iterator.throw === undefined) {
              throw toFluentError(failure, "Operation failed without generator.throw")
            }
            const throwable = failure
            failure = undefined
            return iterator.throw(throwable)
          }),
        ).pipe(
          Effect.mapError((cause) =>
            toFluentError(cause, "Operation failed while advancing generator"),
          ),
        )
        yield* this.operations.flushPendingState()
        if (next.done === true) return next.value
        if (!isPrimitiveOperation(next.value)) {
          return yield* new FluentFiregridError({
            message: "Unsupported operation yielded by fluent-firegrid scheduler",
            cause: next.value,
          })
        }
        const node = next.value[operationTag]
        switch (node._tag) {
          case "Leaf": {
            const settled = yield* Effect.either(node.future.effect)
            if (Either.isRight(settled)) {
              resume = settled.right
            } else {
              resume = undefined
              failure = throwableFromFutureFailure(settled.left)
            }
            break
          }
        }
      }
    })
  }
}
