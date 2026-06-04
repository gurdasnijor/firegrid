import { Deferred, Effect, Either } from "effect"
import { FluentFiregridError, toFluentError } from "./error.ts"
import { Future, type FutureSettledResult, type FutureValue, type FutureValues, type SelectBranches, type SelectResult } from "./future.ts"
import { isPrimitiveOperation, operationTag, type Operation } from "./operation.ts"
import { effectFromStep, type RunAction, type RunOptions, type SleepDuration } from "./run.ts"
import type { SharedState, State, TypedState, UntypedState } from "./state.ts"
import { withCurrentScheduler } from "./current.ts"
import type { FluentRequirements, JournalEvent, JournalStream, RaceCompletedEvent, SleepCompletedEvent, StateEvent, StateRuntime, StepFailedEvent, StepSucceededEvent } from "./schema.ts"

const isStepSucceeded = (
  event: JournalEvent,
  stepKey: string,
): event is StepSucceededEvent =>
  event.type === "StepSucceeded" && event.stepKey === stepKey

const isStepFailed = (
  event: JournalEvent,
  stepKey: string,
): event is StepFailedEvent =>
  event.type === "StepFailed" && event.stepKey === stepKey

const isSleepCompleted = (
  event: JournalEvent,
  sleepKey: string,
): event is SleepCompletedEvent =>
  event.type === "SleepCompleted" && event.sleepKey === sleepKey

const isRaceCompleted = (
  event: JournalEvent,
  raceKey: string,
): event is RaceCompletedEvent =>
  event.type === "RaceCompleted" && event.raceKey === raceKey

const failStep = <T>(
  stepKey: string,
  failed: StepFailedEvent,
): Effect.Effect<T, FluentFiregridError> =>
  Effect.fail(new FluentFiregridError({
    message: `Journaled step failed: ${stepKey}: ${failed.message}`,
    ...(failed.cause === undefined ? {} : { cause: failed.cause }),
  }))

const toSettled = <T>(
  future: Future<T>,
): Effect.Effect<FutureSettledResult<T>, never, FluentRequirements> =>
  Effect.match(future.effect, {
    onFailure: (reason): FutureSettledResult<T> => ({
      status: "rejected",
      reason: reason.cause ?? reason,
    }),
    onSuccess: (value): FutureSettledResult<T> => ({ status: "fulfilled", value }),
  })

const failFromSettled = <T>(
  settled: FutureSettledResult<T>,
  message: string,
): Effect.Effect<T, FluentFiregridError> =>
  settled.status === "fulfilled"
    ? Effect.succeed(settled.value)
    : Effect.fail(toFluentError(settled.reason, message))

const throwableFromFutureFailure = (error: FluentFiregridError): unknown =>
  error.cause instanceof AggregateError ? error.cause : error

type IndexedSettled = {
  readonly index: number
  readonly result: FutureSettledResult<unknown>
}


// fluent-firegrid-keystone.ENGINE.2
export class Scheduler {
  private nextStepIndex = 0

  constructor(
    private readonly stream: JournalStream,
    private readonly events: ReadonlyArray<JournalEvent>,
    private readonly stateRuntime?: StateRuntime,
  ) {}

  run<T>(action: RunAction<T>, options: RunOptions = {}): Future<T> {
    // fluent-firegrid-keystone.DURABLE_RUN.4
    const name = options.name ?? (action.name || "run")
    const stepKey = `${this.nextStepIndex}:${name}`
    this.nextStepIndex += 1

    return new Future(
      Effect.gen(this, function* () {
        const succeeded = this.events.find((event) => isStepSucceeded(event, stepKey))
        if (succeeded !== undefined) {
          // fluent-firegrid-keystone.DURABLE_RUN.3
          return succeeded.value as T
        }
        const failed = this.events.find((event) => isStepFailed(event, stepKey))
        if (failed !== undefined) {
          return yield* failStep<T>(stepKey, failed)
        }

        const value = yield* effectFromStep(action).pipe(
          Effect.mapError((cause) =>
            new FluentFiregridError({
              message: `Step failed before journal append: ${stepKey}`,
              cause,
            }),
          ),
        )

        // fluent-firegrid-keystone.DURABLE_RUN.2
        yield* this.stream.append({
          type: "StepSucceeded",
          stepKey,
          name,
          value,
        }).pipe(
          Effect.mapError((cause) =>
            new FluentFiregridError({
              message: `Failed to append journal event for ${stepKey}`,
              cause,
            }),
          ),
        )

        return value
      }),
    )
  }

  sleep(durationMs: SleepDuration, name = "sleep"): Future<void> {
    // fluent-firegrid-keystone.FREE.3
    const sleepKey = `${this.nextStepIndex}:${name}`
    this.nextStepIndex += 1

    return new Future(
      Effect.gen(this, function* () {
        const completed = this.events.find((event) => isSleepCompleted(event, sleepKey))
        if (completed !== undefined) return

        yield* Effect.sleep(durationMs)
        yield* this.stream.append({
          type: "SleepCompleted",
          sleepKey,
          name,
          durationMs,
        }).pipe(
          Effect.mapError((cause) =>
            new FluentFiregridError({
              message: `Failed to append sleep event for ${sleepKey}`,
              cause,
            }),
          ),
        )
      }),
    )
  }

  all<const T extends readonly Future<unknown>[] | []>(
    futures: T,
  ): Future<FutureValues<T>> {
    // fluent-firegrid-keystone.FREE.1
    return new Future(
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
    )
  }

  state<TState extends TypedState = UntypedState>(): State<TState> {
    // fluent-firegrid-keystone.STATE.1
    const impl: State<TState> = {
      get: <TValue, TKey extends keyof TState = string>(
        name: TState extends UntypedState ? string : TKey,
      ): Future<(TState extends UntypedState ? TValue : TState[TKey]) | null> =>
        this.getStateValue(name as string),
      keys: (): Future<Array<string>> => this.getStateKeys(),
      set: <TValue, TKey extends keyof TState = string>(
        name: TState extends UntypedState ? string : TKey,
        value: TState extends UntypedState ? TValue : TState[TKey],
      ): void => {
        this.appendStateEvent({ type: "StateSet", name: name as string, value })
      },
      clear: <TKey extends keyof TState>(
        name: TState extends UntypedState ? string : TKey,
      ): void => {
        this.appendStateEvent({ type: "StateCleared", name: name as string })
      },
      clearAll: (): void => {
        this.appendStateEvent({ type: "StateClearedAll" })
      },
    }
    return impl
  }

  sharedState<TState extends TypedState = UntypedState>(): SharedState<TState> {
    // fluent-firegrid-keystone.STATE.4
    return this.state<TState>()
  }

  race<const T extends readonly [Future<unknown>, ...Array<Future<unknown>>]>(
    futures: T,
  ): Future<FutureValue<T[number]>> {
    // fluent-firegrid-keystone.FREE.5
    const raceKey = `${this.nextStepIndex}:race`
    this.nextStepIndex += 1

    return new Future(
      Effect.gen(this, function* () {
        const winner = yield* this.raceIndexed(
          futures,
          { raceKey, name: "race" },
        ).effect
        return yield* failFromSettled(
          winner.result,
          "race() winner rejected",
        ) as Effect.Effect<FutureValue<T[number]>, FluentFiregridError>
      }),
    )
  }

  any<const T extends readonly Future<unknown>[] | []>(
    futures: T,
  ): Future<FutureValue<T[number]>> {
    // fluent-firegrid-keystone.FREE.5
    return new Future(
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
          const winner = yield* this.raceIndexed(nonEmptyRemaining).effect
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
    )
  }

  allSettled<const T extends readonly Future<unknown>[] | []>(
    futures: T,
  ): Future<{ -readonly [P in keyof T]: FutureSettledResult<FutureValue<T[P]>> }> {
    // fluent-firegrid-keystone.FREE.5
    return new Future(
      Effect.gen(function* () {
        const results = yield* Effect.all(
          futures.map((future) => toSettled(future)),
          { concurrency: "unbounded" },
        )
        return results as { -readonly [P in keyof T]: FutureSettledResult<FutureValue<T[P]>> }
      }),
    )
  }

  select<const Branches extends SelectBranches>(
    branches: Branches,
  ): Future<SelectResult<Branches>> {
    // fluent-firegrid-keystone.FREE.6
    const raceKey = `${this.nextStepIndex}:select`
    this.nextStepIndex += 1

    return new Future(
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
        const winner = yield* this.raceIndexed(
          nonEmptyFutures,
          { raceKey, name: "select" },
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
    )
  }

  spawn<T>(operation: Operation<T>): Future<T> {
    // fluent-firegrid-keystone.FREE.7
    return new Future(this.drive(operation))
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
        yield* this.flushPendingState()
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

  private raceIndexed(
    futures: readonly [Future<unknown>, ...Array<Future<unknown>>],
    replay?: { readonly raceKey: string; readonly name: string },
  ): Future<IndexedSettled> {
    return new Future(
      Effect.gen(this, function* () {
        if (replay !== undefined) {
          const completed = this.events.find((event) =>
            isRaceCompleted(event, replay.raceKey),
          )
          const future = completed === undefined
            ? undefined
            : futures[completed.winnerIndex]
          if (future !== undefined && completed !== undefined) {
            const result = yield* toSettled(future)
            return { index: completed.winnerIndex, result }
          }
        }

        const winner = yield* Deferred.make<IndexedSettled>()
        yield* Effect.all(
          futures.map((future, index) =>
            toSettled(future).pipe(
              Effect.map((result): IndexedSettled => ({ index, result })),
              Effect.intoDeferred(winner),
              Effect.forkDaemon,
            ),
          ),
          { concurrency: "unbounded", discard: true },
        )
        const result = yield* Deferred.await(winner)
        if (replay !== undefined) {
          yield* this.stream.append({
            type: "RaceCompleted",
            raceKey: replay.raceKey,
            name: replay.name,
            winnerIndex: result.index,
          }).pipe(
            Effect.mapError((cause) =>
              new FluentFiregridError({
                message: `Failed to append race event for ${replay.raceKey}`,
                cause,
              }),
            ),
          )
        }
        return result
      }),
    )
  }

  private getStateValue<T>(name: string): Future<T | null> {
    // fluent-firegrid-keystone.STATE.2
    return new Future(
      Effect.suspend(() => {
        const runtime = this.stateRuntime
        if (runtime === undefined) {
          return Effect.fail(new FluentFiregridError({
            message: "state() requires execute(ctx, op) to provide state substrate",
          }))
        }
        return Effect.succeed(
          runtime.values.has(name) ? runtime.values.get(name) as T : null,
        )
      }),
    )
  }

  private getStateKeys(): Future<Array<string>> {
    // fluent-firegrid-keystone.STATE.2
    return new Future(
      Effect.suspend(() => {
        const runtime = this.stateRuntime
        if (runtime === undefined) {
          return Effect.fail(new FluentFiregridError({
            message: "state().keys() requires execute(ctx, op) to provide state substrate",
          }))
        }
        return Effect.succeed(Array.from(runtime.values.keys()))
      }),
    )
  }

  private appendStateEvent(event: StateEvent): void {
    // fluent-firegrid-keystone.STATE.3
    const runtime = this.stateRuntime
    if (runtime === undefined) {
      throw new FluentFiregridError({
        message: "state() requires execute(ctx, op) to provide state substrate",
      })
    }
    switch (event.type) {
      case "StateSet": {
        runtime.values.set(event.name, event.value)
        break
      }
      case "StateCleared": {
        runtime.values.delete(event.name)
        break
      }
      case "StateClearedAll": {
        runtime.values.clear()
        break
      }
    }
    runtime.pending.push(event)
  }

  private flushPendingState(): Effect.Effect<void, FluentFiregridError, FluentRequirements> {
    const runtime = this.stateRuntime
    if (runtime === undefined || runtime.pending.length === 0) {
      return Effect.void
    }
    const events = runtime.pending.slice()
    return Effect.all(
      events.map((event) =>
        runtime.stream.append(event).pipe(
          Effect.mapError((cause) =>
            new FluentFiregridError({
              message: "Failed to append state event",
              cause,
            }),
          ),
        ),
      ),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          runtime.pending.splice(0, events.length)
        }),
      ),
    )
  }
}
