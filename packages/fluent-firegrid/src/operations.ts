import { Deferred, Effect } from "effect"
import { fromEffect } from "./awaitable.ts"
import { FluentFiregridError, toFluentError } from "./error.ts"
import {
  Future,
  type FutureSettledResult,
} from "./future.ts"
import type { Operation } from "./operation.ts"
import { effectFromStep, type RunAction, type RunOptions, type SleepDuration } from "./run.ts"
import type {
  FluentRequirements,
  JournalEvent,
  JournalStream,
  RaceCompletedEvent,
  SleepCompletedEvent,
  StateEvent,
  StateRuntime,
  StepFailedEvent,
  StepSucceededEvent,
} from "./schema.ts"
import type { SharedState, State, TypedState, UntypedState } from "./state.ts"

type IndexedSettled = {
  readonly index: number
  readonly result: FutureSettledResult<unknown>
}

export interface OperationProducers {
  run<T>(action: RunAction<T>, options?: RunOptions): Future<T>
  sleep(durationMs: SleepDuration, name?: string): Future<void>
  raceIndexed(
    futures: readonly [Future<unknown>, ...Array<Future<unknown>>],
    replay?: { readonly name: string },
  ): Future<IndexedSettled>
  state<TState extends TypedState = UntypedState>(): State<TState>
  sharedState<TState extends TypedState = UntypedState>(): SharedState<TState>
  spawn<T>(operation: Operation<T>): Future<T>
  flushPendingState(): Effect.Effect<void, FluentFiregridError, FluentRequirements>
}

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

export const toSettled = <T>(
  future: Future<T>,
): Effect.Effect<FutureSettledResult<T>, never, FluentRequirements> =>
  Effect.match(future.effect, {
    onFailure: (reason): FutureSettledResult<T> => ({
      status: "rejected",
      reason: reason.cause ?? reason,
    }),
    onSuccess: (value): FutureSettledResult<T> => ({ status: "fulfilled", value }),
  })

export const failFromSettled = <T>(
  settled: FutureSettledResult<T>,
  message: string,
): Effect.Effect<T, FluentFiregridError> =>
  settled.status === "fulfilled"
    ? Effect.succeed(settled.value)
    : Effect.fail(toFluentError(settled.reason, message))

const failStep = <T>(
  stepKey: string,
  failed: StepFailedEvent,
): Effect.Effect<T, FluentFiregridError> =>
  Effect.fail(new FluentFiregridError({
    message: `Journaled step failed: ${stepKey}: ${failed.message}`,
    ...(failed.cause === undefined ? {} : { cause: failed.cause }),
  }))

export class DurableOperationProducers implements OperationProducers {
  private nextStepIndex = 0

  constructor(
    private readonly stream: JournalStream,
    private readonly events: ReadonlyArray<JournalEvent>,
    private readonly drive: <T>(
      operation: Operation<T>,
    ) => Effect.Effect<T, FluentFiregridError, FluentRequirements>,
    private readonly stateRuntime?: StateRuntime,
  ) {}

  run<T>(action: RunAction<T>, options: RunOptions = {}): Future<T> {
    // fluent-firegrid-keystone.AWAITABLE.3
    // fluent-firegrid-keystone.DURABLE_RUN.4
    const name = options.name ?? (action.name || "run")
    const stepKey = `${this.nextStepIndex}:${name}`
    this.nextStepIndex += 1

    return new Future(fromEffect(
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
    ))
  }

  sleep(durationMs: SleepDuration, name = "sleep"): Future<void> {
    // fluent-firegrid-keystone.FREE.3
    const sleepKey = `${this.nextStepIndex}:${name}`
    this.nextStepIndex += 1

    return new Future(fromEffect(
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
    ))
  }

  raceIndexed(
    futures: readonly [Future<unknown>, ...Array<Future<unknown>>],
    replay?: { readonly name: string },
  ): Future<IndexedSettled> {
    const raceKey = replay === undefined
      ? undefined
      : `${this.nextStepIndex}:${replay.name}`
    if (replay !== undefined) {
      this.nextStepIndex += 1
    }

    return new Future(fromEffect(
      Effect.gen(this, function* () {
        if (replay !== undefined && raceKey !== undefined) {
          const completed = this.events.find((event) =>
            isRaceCompleted(event, raceKey),
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
        if (replay !== undefined && raceKey !== undefined) {
          yield* this.stream.append({
            type: "RaceCompleted",
            raceKey,
            name: replay.name,
            winnerIndex: result.index,
          }).pipe(
            Effect.mapError((cause) =>
              new FluentFiregridError({
                message: `Failed to append race event for ${raceKey}`,
                cause,
              }),
            ),
          )
        }
        return result
      }),
    ))
  }

  state<TState extends TypedState = UntypedState>(): State<TState> {
    // fluent-firegrid-keystone.STATE.1
    return {
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
  }

  sharedState<TState extends TypedState = UntypedState>(): SharedState<TState> {
    // fluent-firegrid-keystone.STATE.4
    return this.state<TState>()
  }

  spawn<T>(operation: Operation<T>): Future<T> {
    // fluent-firegrid-keystone.FREE.7
    return new Future(fromEffect(this.drive(operation)))
  }

  flushPendingState(): Effect.Effect<void, FluentFiregridError, FluentRequirements> {
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

  private getStateValue<T>(name: string): Future<T | null> {
    // fluent-firegrid-keystone.STATE.2
    return new Future(fromEffect(
      Effect.gen(this, function* () {
        const runtime = yield* this.getStateRuntime(
          "state() requires execute(ctx, op) to provide state substrate",
        )
        return runtime.values.has(name) ? runtime.values.get(name) as T : null
      }),
    ))
  }

  private getStateKeys(): Future<Array<string>> {
    // fluent-firegrid-keystone.STATE.2
    return new Future(fromEffect(
      Effect.gen(this, function* () {
        const runtime = yield* this.getStateRuntime(
          "state().keys() requires execute(ctx, op) to provide state substrate",
        )
        return Array.from(runtime.values.keys())
      }),
    ))
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

  private getStateRuntime(
    message: string,
  ): Effect.Effect<StateRuntime, FluentFiregridError> {
    const runtime = this.stateRuntime
    if (runtime === undefined) {
      return Effect.fail(new FluentFiregridError({ message }))
    }
    return Effect.succeed(runtime)
  }
}
