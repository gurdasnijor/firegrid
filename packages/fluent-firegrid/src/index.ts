import { Data, Deferred, Effect, Either, Schema } from "effect"
import { DurableStream, type Endpoint } from "effect-durable-streams"

// fluent-firegrid-keystone.SUBSTRATE.1
export class FluentFiregridError extends Data.TaggedError("FluentFiregridError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const StepSucceededEventSchema = Schema.Struct({
  type: Schema.Literal("StepSucceeded"),
  stepKey: Schema.String,
  name: Schema.String,
  value: Schema.Unknown,
})

const StepFailedEventSchema = Schema.Struct({
  type: Schema.Literal("StepFailed"),
  stepKey: Schema.String,
  name: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
})

const SleepCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("SleepCompleted"),
  sleepKey: Schema.String,
  name: Schema.String,
  durationMs: Schema.Number,
})

const RaceCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("RaceCompleted"),
  raceKey: Schema.String,
  name: Schema.String,
  winnerIndex: Schema.Number,
})

const StateSetEventSchema = Schema.Struct({
  type: Schema.Literal("StateSet"),
  name: Schema.String,
  value: Schema.Unknown,
})

const StateClearedEventSchema = Schema.Struct({
  type: Schema.Literal("StateCleared"),
  name: Schema.String,
})

const StateClearedAllEventSchema = Schema.Struct({
  type: Schema.Literal("StateClearedAll"),
})

const JournalEventSchema = Schema.Union(
  StepSucceededEventSchema,
  StepFailedEventSchema,
  SleepCompletedEventSchema,
  RaceCompletedEventSchema,
)

const StateEventSchema = Schema.Union(
  StateSetEventSchema,
  StateClearedEventSchema,
  StateClearedAllEventSchema,
)

type JournalEvent = Schema.Schema.Type<typeof JournalEventSchema>
type StateEvent = Schema.Schema.Type<typeof StateEventSchema>
type StepSucceededEvent = Schema.Schema.Type<typeof StepSucceededEventSchema>
type StepFailedEvent = Schema.Schema.Type<typeof StepFailedEventSchema>
type SleepCompletedEvent = Schema.Schema.Type<typeof SleepCompletedEventSchema>
type RaceCompletedEvent = Schema.Schema.Type<typeof RaceCompletedEventSchema>
type StreamRequirements<Event> =
  ReturnType<DurableStream.Bound<Event, Event>["append"]> extends
    Effect.Effect<unknown, unknown, infer Requirements> ? Requirements : never
type JournalRequirements = StreamRequirements<JournalEvent>
type FluentRequirements = JournalRequirements
type StateStream = DurableStream.Bound<StateEvent, StateEvent>
type JournalStream = DurableStream.Bound<JournalEvent, JournalEvent>

interface StateRuntime {
  readonly stream: StateStream
  readonly values: Map<string, unknown>
  readonly pending: Array<StateEvent>
}

export interface ExecutionContext {
  // fluent-firegrid-keystone.PACKAGE.3
  readonly journal: {
    readonly endpoint: Endpoint
  }
  readonly state?: {
    readonly endpoint: Endpoint
  }
}

// fluent-firegrid-keystone.PACKAGE.4
export interface Operation<T> {
  [Symbol.iterator](): Iterator<unknown, T, unknown>
}

const operationTag = Symbol("fluentFiregridOperation")

interface LeafNode<T> {
  readonly _tag: "Leaf"
  readonly future: Future<T>
}

interface PrimitiveOperation<T> extends Operation<T> {
  readonly [operationTag]: LeafNode<T>
}

const makePrimitive = <T>(node: LeafNode<T>): PrimitiveOperation<T> => {
  const operation: PrimitiveOperation<T> = {
    [operationTag]: node,
    *[Symbol.iterator]() {
      return (yield operation) as T
    },
  } satisfies PrimitiveOperation<T>

  return operation
}

const isPrimitiveOperation = (
  value: unknown,
): value is PrimitiveOperation<unknown> =>
  typeof value === "object" && value !== null && operationTag in value

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

// fluent-firegrid-keystone.DURABLE_RUN.1
export type RunAction<T> = (
  options: { readonly signal: AbortSignal },
) => T | Promise<T> | Effect.Effect<T, unknown>

export interface RunOptions {
  readonly name?: string
}

export type SleepDuration = number

export type Handler<Input, Output> = (
  ctx: ExecutionContext,
  input: Input,
) => Effect.Effect<Output, unknown, FluentRequirements>

type AnyHandler = Handler<never, unknown>
type AnyOperationHandler = (input: never) => Operation<unknown>
type HandlerEntry = AnyHandler | AnyOperationHandler

type HandlerEntryInput<Entry> =
  Entry extends Handler<infer Input, unknown> ? Input
    : Entry extends (input: infer Input) => Operation<unknown> ? Input
    : never

type HandlerEntryOutput<Entry> =
  Entry extends Handler<never, infer Output> ? Output
    : Entry extends (input: never) => Operation<infer Output> ? Output
    : never

type NormalizeHandlers<Entries extends Record<string, HandlerEntry>> = {
  readonly [Key in keyof Entries]: Handler<
    HandlerEntryInput<Entries[Key]>,
    HandlerEntryOutput<Entries[Key]>
  >
}

export type DefinitionKind = "service" | "object" | "workflow"

export interface Definition<
  Name extends string,
  Kind extends DefinitionKind,
  Handlers extends Record<string, AnyHandler>,
> {
  readonly name: Name
  readonly _kind: Kind
  readonly handlers: Handlers
}

export type ServiceDefinition<
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
> = Definition<Name, "service", Handlers>

export type ObjectDefinition<
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
> = Definition<Name, "object", Handlers>

export type WorkflowDefinition<
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
> = Definition<Name, "workflow", Handlers>

type InputOf<H> = H extends Handler<infer Input, unknown> ? Input : never
type OutputOf<H> = H extends Handler<never, infer Output> ? Output : never

type ServiceClient<Handlers extends Record<string, AnyHandler>> = {
  readonly [Key in keyof Handlers]: (
    input: InputOf<Handlers[Key]>,
  ) => Effect.Effect<OutputOf<Handlers[Key]>, unknown, FluentRequirements>
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

const effectFromStep = <T>(
  action: RunAction<T>,
): Effect.Effect<T, unknown> =>
  Effect.suspend(() => {
    const result = action({ signal: new AbortController().signal })
    if (Effect.isEffect(result)) return result
    return Effect.promise(() => Promise.resolve(result))
  })

const failStep = <T>(
  stepKey: string,
  failed: StepFailedEvent,
): Effect.Effect<T, FluentFiregridError> =>
  Effect.fail(new FluentFiregridError({
    message: `Journaled step failed: ${stepKey}: ${failed.message}`,
    ...(failed.cause === undefined ? {} : { cause: failed.cause }),
  }))

const toFluentError = (cause: unknown, message: string): FluentFiregridError =>
  cause instanceof FluentFiregridError ? cause : new FluentFiregridError({
    message,
    cause,
  })

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

const foldStateEvents = (
  events: ReadonlyArray<StateEvent>,
): Map<string, unknown> => {
  const values = new Map<string, unknown>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    switch (event.type) {
      case "StateSet": {
        values.set(event.name, event.value)
        break
      }
      case "StateCleared": {
        values.delete(event.name)
        break
      }
      case "StateClearedAll": {
        values.clear()
        break
      }
    }
  }
  return values
}

class Scheduler {
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

// sdk-gen-style synchronous current-fiber slot; not durable replay state.
// eslint-disable-next-line local/no-module-durable-cache
let currentScheduler: Scheduler | undefined

const withCurrentScheduler = <T>(
  scheduler: Scheduler,
  body: () => T,
): T => {
  const previous = currentScheduler
  currentScheduler = scheduler
  try {
    return body()
  } finally {
    currentScheduler = previous
  }
}

export const gen = <T>(
  factory: () => Generator<unknown, T, unknown>,
): Operation<T> => ({
  [Symbol.iterator]: factory,
})

export const run = <T>(
  action: RunAction<T>,
  options?: RunOptions,
): Future<T> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "run() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.run(action, options)
}

export const all = <const T extends readonly Future<unknown>[] | []>(
  futures: T,
): Future<FutureValues<T>> => {
  // fluent-firegrid-keystone.FREE.2
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "all() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.all(futures)
}

export const state = <
  TState extends TypedState = UntypedState,
>(): State<TState> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "state() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.state<TState>()
}

export const sharedState = <
  TState extends TypedState = UntypedState,
>(): SharedState<TState> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "sharedState() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.sharedState<TState>()
}

export const race = <const T extends readonly [Future<unknown>, ...Array<Future<unknown>>]>(
  futures: T,
): Future<FutureValue<T[number]>> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "race() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.race(futures)
}

export const any = <const T extends readonly Future<unknown>[] | []>(
  futures: T,
): Future<FutureValue<T[number]>> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "any() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.any(futures)
}

export const allSettled = <const T extends readonly Future<unknown>[] | []>(
  futures: T,
): Future<{ -readonly [P in keyof T]: FutureSettledResult<FutureValue<T[P]>> }> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "allSettled() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.allSettled(futures)
}

export const select = <const Branches extends SelectBranches>(
  branches: Branches,
): Future<SelectResult<Branches>> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "select() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.select(branches)
}

export const spawn = <T>(operation: Operation<T>): Future<T> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "spawn() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.spawn(operation)
}

export const sleep = (
  durationMs: SleepDuration,
  name?: string,
): Future<void> => {
  const scheduler = currentScheduler
  if (scheduler === undefined) {
    throw new FluentFiregridError({
      message: "sleep() must be called inside execute(ctx, gen(...))",
    })
  }
  return scheduler.sleep(durationMs, name)
}

export const execute = <T>(
  ctx: ExecutionContext,
  operation: Operation<T>,
): Effect.Effect<T, unknown, FluentRequirements> =>
  Effect.gen(function* () {
    // fluent-firegrid-keystone.SUBSTRATE.2
    const journal = DurableStream.define({
      endpoint: ctx.journal.endpoint,
      schema: JournalEventSchema,
    })
    yield* journal.create({ contentType: "application/json" })
    const events = yield* journal.collect
    const state = ctx.state
    const stateRuntime = state === undefined
      ? undefined
      : yield* Effect.gen(function* () {
        const stream = DurableStream.define({
          endpoint: state.endpoint,
          schema: StateEventSchema,
        })
        yield* stream.create({ contentType: "application/json" })
        const stateEvents = yield* stream.collect
        return {
          stream,
          values: foldStateEvents(stateEvents),
          pending: [],
        } satisfies StateRuntime
      })
    const scheduler = new Scheduler(journal, events, stateRuntime)
    return yield* scheduler.drive(operation)
  })

const isExecutionHandler = (entry: HandlerEntry): entry is AnyHandler =>
  entry.length >= 2

const normalizeHandlers = <const Entries extends Record<string, HandlerEntry>>(
  entries: Entries,
): NormalizeHandlers<Entries> => {
  const normalized: Record<string, AnyHandler> = {}
  const keys = Object.keys(entries)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) continue
    const entry = entries[key]
    if (entry === undefined) continue
    normalized[key] = ((ctx: ExecutionContext, input: never) => {
      if (isExecutionHandler(entry)) return entry(ctx, input)
      return execute(ctx, entry(input))
    })
  }
  return normalized as NormalizeHandlers<Entries>
}

// fluent-firegrid-keystone.PACKAGE.2
export const service = <
  const Name extends string,
  const Handlers extends Record<string, HandlerEntry>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ServiceDefinition<Name, NormalizeHandlers<Handlers>> => ({
  name: definition.name,
  _kind: "service",
  handlers: normalizeHandlers(definition.handlers),
})

export const object = <
  const Name extends string,
  const Handlers extends Record<string, HandlerEntry>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ObjectDefinition<Name, NormalizeHandlers<Handlers>> => ({
  name: definition.name,
  _kind: "object",
  handlers: normalizeHandlers(definition.handlers),
})

export const workflow = <
  const Name extends string,
  const Handlers extends Record<string, HandlerEntry>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): WorkflowDefinition<Name, NormalizeHandlers<Handlers>> => ({
  // fluent-firegrid-keystone.DEFINITIONS.3
  name: definition.name,
  _kind: "workflow",
  handlers: normalizeHandlers(definition.handlers),
})

export const invoke = <
  Name extends string,
  Kind extends DefinitionKind,
  Handlers extends Record<string, AnyHandler>,
  Key extends keyof Handlers,
>(
  definition: Definition<Name, Kind, Handlers>,
  handlerName: Key,
  input: InputOf<Handlers[Key]>,
  ctx: ExecutionContext,
): Effect.Effect<OutputOf<Handlers[Key]>, unknown, FluentRequirements> =>
  Effect.gen(function* () {
    const handler = definition.handlers[handlerName]
    if (handler === undefined) {
      return yield* new FluentFiregridError({
        message: `Unknown handler ${String(handlerName)} on service ${definition.name}`,
      })
    }
    const typedHandler = handler as Handler<
      InputOf<Handlers[Key]>,
      OutputOf<Handlers[Key]>
    >
    return yield* typedHandler(ctx, input)
  })

export const client = <
  Name extends string,
  Kind extends DefinitionKind,
  Handlers extends Record<string, AnyHandler>,
>(
  definition: Definition<Name, Kind, Handlers>,
  ctx: ExecutionContext,
): ServiceClient<Handlers> =>
  new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined
      return (input: unknown) => invoke(
        definition,
        property as keyof Handlers,
        input as InputOf<Handlers[keyof Handlers]>,
        ctx,
      )
    },
  }) as ServiceClient<Handlers>
