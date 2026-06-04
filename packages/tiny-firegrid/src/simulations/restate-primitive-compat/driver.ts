import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import { FiregridConfig } from "@firegrid/client-sdk/config"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/unified"
import { DurableTable } from "effect-durable-operators"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Ref, Schema } from "effect"

const futureSymbol: unique symbol = Symbol("tiny-firegrid.restate-compat.Future")

const FutureRowSchema = Schema.Struct({
  futureId: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  name: Schema.String,
  backing: Schema.String,
  status: Schema.String,
  resultJson: Schema.String,
})

const WaiterRowSchema = Schema.Struct({
  waiterId: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  branchFutureIdsJson: Schema.String,
  winnerFutureId: Schema.String,
})

const ClaimRowSchema = Schema.Struct({
  claimId: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  futureId: Schema.String,
  worker: Schema.String,
  generation: Schema.Number,
  status: Schema.String,
})

const StateRowSchema = Schema.Struct({
  stateKey: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  scope: Schema.String,
  name: Schema.String,
  valueJson: Schema.String,
})

const ChannelRowSchema = Schema.Struct({
  channelId: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  name: Schema.String,
  status: Schema.String,
  valueJson: Schema.String,
})

const RoutineRowSchema = Schema.Struct({
  routineId: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  name: Schema.String,
  status: Schema.String,
  resultJson: Schema.String,
})

const CancellationRowSchema = Schema.Struct({
  cancellationId: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  targetFutureId: Schema.String,
  status: Schema.String,
  reasonJson: Schema.String,
})

const ServiceCallRowSchema = Schema.Struct({
  invocationId: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  kind: Schema.String,
  target: Schema.String,
  status: Schema.String,
  payloadJson: Schema.String,
  resultJson: Schema.String,
})

class RestateCompatSchedulerTable extends DurableTable("tiny.firegrid.restatePrimitiveCompat", {
  futures: FutureRowSchema,
  waiters: WaiterRowSchema,
  claims: ClaimRowSchema,
  stateRows: StateRowSchema,
  channels: ChannelRowSchema,
  routines: RoutineRowSchema,
  cancellations: CancellationRowSchema,
  serviceCalls: ServiceCallRowSchema,
}) {}

type SchedulerEnv =
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | RestateCompatSchedulerTable

interface Operation<T> {
  [Symbol.iterator](): Generator<Future<unknown>, T, unknown>
}

interface Future<T> extends Operation<T> {
  readonly [futureSymbol]: true
  readonly futureId: string
  readonly name: string
  readonly backing: "journal" | "timer" | "awakeable" | "routine" | "combinator"
  readonly startEffect: Effect.Effect<void, never, SchedulerEnv>
  readonly awaitEffect: Effect.Effect<T, unknown, SchedulerEnv>
}

type RunAction<T> = (
  options: { readonly signal: AbortSignal },
) => Effect.Effect<T, unknown, unknown> | Promise<T> | T

type SelectResult<B extends Record<string, Future<unknown>>> = {
  [K in keyof B]: { readonly tag: K; readonly future: B[K] }
}[keyof B]

interface StateCell<T> {
  readonly get: () => Future<T>
  readonly set: (value: T) => Future<void>
}

interface CompatChannel<T> {
  readonly id: string
  readonly send: (value: T) => Future<void>
  readonly receive: Future<T>
}

interface WorkflowPromiseHandle<T> {
  readonly id: DurableDeferred.Token
  readonly promise: Future<T>
  readonly resolve: (value: T) => Future<void>
}

// eslint-disable-next-line local/no-module-durable-cache -- sdk-gen free functions use a synchronous current scheduler slot.
let currentScheduler: RestateGenScheduler | undefined

const getCurrentScheduler = (): RestateGenScheduler => {
  if (currentScheduler === undefined) {
    throw new Error("restate-primitive-compat free function called outside execute(gen(...))")
  }
  return currentScheduler
}

const withCurrentScheduler = <A, E, R>(
  scheduler: RestateGenScheduler,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = currentScheduler
      currentScheduler = scheduler
      return previous
    }),
    () => effect,
    previous => Effect.sync(() => {
      currentScheduler = previous
    }),
  )

const gen = <T>(
  body: () => Generator<Future<unknown>, T, unknown>,
): Operation<T> => ({ [Symbol.iterator]: body })

const makeFutureIterator = <T>(
  future: Future<T>,
): Generator<Future<unknown>, T, unknown> => {
  function* iterator() {
    return (yield future) as T
  }
  return iterator()
}

class RestateGenScheduler {
  private readonly pendingStarts: Array<Effect.Effect<void, never, SchedulerEnv>> = []
  private readonly activeFibers: Array<Fiber.Fiber<void, never>> = []
  private readonly abortController = new AbortController()
  private futureCounter = 0
  private waiterCounter = 0

  constructor(
    private readonly instance: WorkflowEngine.WorkflowInstance["Type"],
    private readonly table: RestateCompatSchedulerTable["Type"],
  ) {}

  readonly runOperation = <T>(
    operation: Operation<T>,
    options?: { readonly waitForStarted?: boolean },
  ): Effect.Effect<T, unknown, SchedulerEnv> =>
    Effect.gen(this, function*() {
      const iterator = operation[Symbol.iterator]()
      let resume: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown } | undefined
      while (true) {
        const next = yield* withCurrentScheduler(
          this,
          Effect.sync(() => {
            if (resume === undefined) return iterator.next(undefined)
            if (resume.ok) return iterator.next(resume.value)
            if (iterator.throw === undefined) throw resume.error
            return iterator.throw(resume.error)
          }),
        )
        yield* this.drainStarts()
        if (next.done === true) {
          if (options?.waitForStarted !== false) {
            yield* this.waitForStarted()
          }
          return next.value
        }
        resume = yield* next.value.awaitEffect.pipe(
          Effect.map(value => ({ ok: true as const, value })),
          Effect.catchAll(error => Effect.succeed({ ok: false as const, error })),
        )
      }
    })

  readonly makeFuture = <T>(options: {
    readonly name: string
    readonly backing: Future<T>["backing"]
    readonly effect: Effect.Effect<T, unknown, SchedulerEnv>
  }): Future<T> => {
    const futureId = `${this.instance.executionId}:future:${++this.futureCounter}:${options.name}`
    let state:
      | { readonly _tag: "pending"; readonly promise: Promise<T> }
      | { readonly _tag: "started"; readonly promise: Promise<T> }
      | { readonly _tag: "settled"; readonly exit: Exit.Exit<T, unknown> }
    let resolvePromise: ((value: T) => void) | undefined
    let rejectPromise: ((error: unknown) => void) | undefined

    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    state = { _tag: "pending", promise }

    const pendingRow = {
      futureId,
      executionId: this.instance.executionId,
      name: options.name,
      backing: options.backing,
      status: "pending",
      resultJson: "",
    }

    const claimId = `${futureId}:claim:1`

    const writeFuture = (
      status: string,
      resultJson: string,
    ): Effect.Effect<void, never, never> =>
      this.table.futures.upsert({
        ...pendingRow,
        status,
        resultJson,
      }).pipe(
        Effect.orDie,
        Effect.withSpan("tiny_firegrid.restate_primitive_compat.state.future_upsert", {
          kind: "internal",
          attributes: {
            "firegrid.restate_compat.future_id": futureId,
            "firegrid.restate_compat.future_name": options.name,
            "firegrid.restate_compat.future_status": status,
            "firegrid.restate_compat.state_protocol": "upsert",
          },
        }),
      )

    const writeClaim = (
      status: string,
    ): Effect.Effect<void, never, never> =>
      this.table.claims.upsert({
        claimId,
        executionId: this.instance.executionId,
        futureId,
        worker: "tiny-firegrid-sim-scheduler",
        generation: 1,
        status,
      }).pipe(
        Effect.orDie,
        Effect.withSpan(
          status === "claimed"
            ? "tiny_firegrid.restate_primitive_compat.pull_wake.claim"
            : "tiny_firegrid.restate_primitive_compat.pull_wake.ack",
          {
            kind: "internal",
            attributes: {
              "firegrid.restate_compat.future_id": futureId,
              "firegrid.restate_compat.claim_id": claimId,
              "firegrid.restate_compat.generation": 1,
              "firegrid.restate_compat.pull_wake_status": status,
            },
          },
        ),
      )

    const start = Effect.gen(this, function*() {
      if (state._tag !== "pending") return
      state = { _tag: "started", promise }
      yield* this.table.futures.insertOrGet(pendingRow).pipe(Effect.orDie)
      yield* writeClaim("claimed")
      yield* writeFuture("running", "")
      const fiber = yield* options.effect.pipe(
        Effect.exit,
        Effect.flatMap(exit => {
          const status = Exit.isSuccess(exit) ? "succeeded" : "failed"
          const resultJson = Exit.isSuccess(exit)
            ? stringifyResult(exit.value)
            : stringifyResult(Cause.squash(exit.cause))
          return writeFuture(status, resultJson).pipe(
            Effect.zipRight(writeClaim("acked")),
            Effect.zipRight(
              Effect.sync(() => {
                state = { _tag: "settled", exit }
            if (Exit.isSuccess(exit)) {
              resolvePromise?.(exit.value)
            } else {
              rejectPromise?.(errorFromUnknown(Cause.squash(exit.cause)))
            }
          }),
        ),
          )
        }),
        Effect.forkDaemon,
      )
      this.activeFibers.push(fiber)
    })

    const future: Future<T> = {
      [futureSymbol]: true,
      futureId,
      name: options.name,
      backing: options.backing,
      startEffect: start,
      awaitEffect: start.pipe(
        Effect.zipRight(Effect.tryPromise({
          try: () => state._tag === "settled"
            ? Exit.isSuccess(state.exit)
              ? Promise.resolve(state.exit.value)
              : Promise.reject(errorFromUnknown(Cause.squash(state.exit.cause)))
            : promise,
          catch: error => error,
        })),
      ),
      [Symbol.iterator]: () => makeFutureIterator(future),
    }
    this.pendingStarts.push(start)
    return future
  }

  readonly recordWaiter = (
    name: string,
    kind: string,
    futures: readonly Future<unknown>[],
  ): Effect.Effect<string, never, never> =>
    Effect.gen(this, function*() {
      const waiterId = `${this.instance.executionId}:waiter:${++this.waiterCounter}:${name}`
      yield* this.table.waiters.upsert({
        waiterId,
        executionId: this.instance.executionId,
        name,
        kind,
        status: "waiting",
        branchFutureIdsJson: JSON.stringify(futures.map(future => future.futureId)),
        winnerFutureId: "",
      }).pipe(
        Effect.orDie,
        Effect.withSpan("tiny_firegrid.restate_primitive_compat.scheduler.waiter_register", {
          kind: "internal",
          attributes: {
            "firegrid.restate_compat.waiter_id": waiterId,
            "firegrid.restate_compat.waiter_kind": kind,
            "firegrid.restate_compat.branch_count": futures.length,
          },
        }),
      )
      return waiterId
    })

  readonly completeWaiter = (
    waiterId: string,
    name: string,
    kind: string,
    futures: readonly Future<unknown>[],
    winnerFutureId: string,
  ): Effect.Effect<void, never, never> =>
    this.table.waiters.upsert({
      waiterId,
      executionId: this.instance.executionId,
      name,
      kind,
      status: "won",
      branchFutureIdsJson: JSON.stringify(futures.map(future => future.futureId)),
      winnerFutureId,
    }).pipe(
      Effect.orDie,
      Effect.withSpan("tiny_firegrid.restate_primitive_compat.scheduler.waiter_resolve", {
        kind: "internal",
        attributes: {
          "firegrid.restate_compat.waiter_id": waiterId,
          "firegrid.restate_compat.waiter_kind": kind,
          "firegrid.restate_compat.winner_future_id": winnerFutureId,
        },
      }),
    )

  readonly race = <const T extends readonly Future<unknown>[]>(
    futures: T,
    name: string,
  ): Future<T[number] extends Future<infer U> ? U : never> =>
    this.makeFuture({
      name,
      backing: "combinator",
      effect: futures.length === 0
        ? Effect.fail(new Error("race requires at least one future"))
        : Effect.gen(this, function*() {
          const waiterId = yield* this.recordWaiter(name, "race", futures)
          const winner = yield* Deferred.make<{
            readonly futureId: string
            readonly value: T[number] extends Future<infer U> ? U : never
          }, unknown>()
          const watchers = yield* Effect.forEach(
            futures,
            future =>
              future.awaitEffect.pipe(
                Effect.exit,
                Effect.flatMap(exit =>
                  Exit.isSuccess(exit)
                    ? Deferred.succeed(winner, {
                      futureId: future.futureId,
                      value: exit.value as T[number] extends Future<infer U> ? U : never,
                    }).pipe(Effect.asVoid)
                    : Deferred.fail(winner, Cause.squash(exit.cause)).pipe(Effect.asVoid),
                ),
                Effect.catchAll(() => Effect.void),
                Effect.forkDaemon,
              ),
          )
          this.activeFibers.push(...watchers)
          const won = yield* Deferred.await(winner)
          yield* this.completeWaiter(waiterId, name, "race", futures, won.futureId)
          return won.value
        }) as Effect.Effect<
          T[number] extends Future<infer U> ? U : never,
          unknown,
          SchedulerEnv
        >,
    })

  readonly all = <const T extends readonly Future<unknown>[]>(
    futures: T,
    name: string,
  ): Future<{ -readonly [P in keyof T]: T[P] extends Future<infer U> ? U : never }> =>
    this.makeFuture({
      name,
      backing: "combinator",
      effect: Effect.all(
        futures.map(future => future.awaitEffect),
        { concurrency: "unbounded" },
      ) as Effect.Effect<
        { -readonly [P in keyof T]: T[P] extends Future<infer U> ? U : never },
        unknown,
        SchedulerEnv
      >,
    })

  readonly state = <T>(
    name: string,
    initial: T,
    shared: boolean,
  ): StateCell<T> => {
    const stateKey = shared
      ? `shared:${name}`
      : `${this.instance.executionId}:state:${name}`
    const scope = shared ? "shared" : "workflow"

    return {
      get: () =>
        this.makeFuture({
          name: `${scope}-state/${name}/get`,
          backing: "combinator",
          effect: this.table.stateRows.get(stateKey).pipe(
            Effect.orDie,
            Effect.map(option => option._tag === "Some"
              ? parseJson<T>(option.value.valueJson)
              : initial),
            Effect.withSpan("tiny_firegrid.restate_primitive_compat.state.get", {
              kind: "internal",
              attributes: {
                "firegrid.restate_compat.state_name": name,
                "firegrid.restate_compat.state_scope": scope,
              },
            }),
          ),
        }),
      set: (value: T) =>
        this.makeFuture({
          name: `${scope}-state/${name}/set`,
          backing: "combinator",
          effect: this.table.stateRows.upsert({
            stateKey,
            executionId: this.instance.executionId,
            scope,
            name,
            valueJson: stringifyResult(value),
          }).pipe(
            Effect.orDie,
            Effect.withSpan("tiny_firegrid.restate_primitive_compat.state.set", {
              kind: "internal",
              attributes: {
                "firegrid.restate_compat.state_name": name,
                "firegrid.restate_compat.state_scope": scope,
              },
            }),
          ),
        }),
    }
  }

  readonly channel = <T>(name: string): CompatChannel<T> => {
    const channelId = `${this.instance.executionId}:channel:${name}:${++this.waiterCounter}`
    const deferredEffect = Deferred.make<T, never>()
    let deferred: Deferred.Deferred<T, never> | undefined

    const ensureDeferred = Effect.gen(function*() {
      if (deferred === undefined) {
        deferred = yield* deferredEffect
      }
      return deferred
    })

    return {
      id: channelId,
      receive: this.makeFuture({
        name: `channel/${name}/receive`,
        backing: "combinator",
        effect: ensureDeferred.pipe(
          Effect.flatMap(Deferred.await),
          Effect.withSpan("tiny_firegrid.restate_primitive_compat.channel.receive", {
            kind: "internal",
            attributes: {
              "firegrid.restate_compat.channel_id": channelId,
              "firegrid.restate_compat.channel_name": name,
            },
          }),
        ),
      }),
      send: (value: T) =>
        this.makeFuture({
          name: `channel/${name}/send`,
          backing: "combinator",
          effect: ensureDeferred.pipe(
            Effect.flatMap(deferredValue => Deferred.succeed(deferredValue, value)),
            Effect.zipRight(this.table.channels.upsert({
              channelId,
              executionId: this.instance.executionId,
              name,
              status: "sent",
              valueJson: stringifyResult(value),
            }).pipe(Effect.orDie)),
            Effect.withSpan("tiny_firegrid.restate_primitive_compat.channel.send", {
              kind: "internal",
              attributes: {
                "firegrid.restate_compat.channel_id": channelId,
                "firegrid.restate_compat.channel_name": name,
              },
            }),
          ),
        }),
    }
  }

  readonly workflowPromise = <T>(
    name: string,
    schema: Schema.Schema<T>,
  ): WorkflowPromiseHandle<T> => {
    const awake = this.awakeable(`workflow-promise/${name}`, schema)
    return {
      id: awake.id,
      promise: awake.promise,
      resolve: (value: T) => {
        this.resolveAwakeable(awake.id, `workflow-promise/${name}`, schema, value)
        return this.makeFuture({
          name: `workflow-promise/${name}/resolve`,
          backing: "awakeable",
          effect: Effect.void,
        })
      },
    }
  }

  readonly serviceCall = <T>(
    kind: string,
    target: string,
    payload: unknown,
    effect: Effect.Effect<T, unknown, SchedulerEnv>,
  ): Future<T> =>
    this.makeFuture({
      name: `${kind}/${target}`,
      backing: "routine",
      effect: Effect.gen(this, function*() {
        const invocationId = `${this.instance.executionId}:invoke:${kind}:${target}:${++this.waiterCounter}`
        yield* this.table.serviceCalls.upsert({
          invocationId,
          executionId: this.instance.executionId,
          kind,
          target,
          status: "running",
          payloadJson: stringifyResult(payload),
          resultJson: "",
        }).pipe(Effect.orDie)
        const result = yield* effect
        yield* this.table.serviceCalls.upsert({
          invocationId,
          executionId: this.instance.executionId,
          kind,
          target,
          status: "succeeded",
          payloadJson: stringifyResult(payload),
          resultJson: stringifyResult(result),
        }).pipe(
          Effect.orDie,
          Effect.withSpan("tiny_firegrid.restate_primitive_compat.client.call", {
            kind: "internal",
            attributes: {
              "firegrid.restate_compat.invocation_id": invocationId,
              "firegrid.restate_compat.invocation_kind": kind,
              "firegrid.restate_compat.invocation_target": target,
            },
          }),
        )
        return result
      }),
    })

  readonly send = (
    kind: string,
    target: string,
    payload: unknown,
  ): Future<string> =>
    this.makeFuture({
      name: `${kind}-send/${target}`,
      backing: "routine",
      effect: Effect.gen(this, function*() {
        const invocationId = `${this.instance.executionId}:send:${kind}:${target}:${++this.waiterCounter}`
        yield* this.table.serviceCalls.upsert({
          invocationId,
          executionId: this.instance.executionId,
          kind: `${kind}-send`,
          target,
          status: "accepted",
          payloadJson: stringifyResult(payload),
          resultJson: "",
        }).pipe(
          Effect.orDie,
          Effect.withSpan("tiny_firegrid.restate_primitive_compat.client.send", {
            kind: "internal",
            attributes: {
              "firegrid.restate_compat.invocation_id": invocationId,
              "firegrid.restate_compat.invocation_kind": kind,
              "firegrid.restate_compat.invocation_target": target,
            },
          }),
        )
        return invocationId
      }),
    })

  readonly cancel = (
    future: Future<unknown>,
    reason: unknown,
  ): Future<string> =>
    this.makeFuture({
      name: `cancel/${future.name}`,
      backing: "combinator",
      effect: Effect.gen(this, function*() {
        const cancellationId = `${this.instance.executionId}:cancel:${++this.waiterCounter}`
        this.abortController.abort(errorFromUnknown(reason))
        yield* this.table.cancellations.upsert({
          cancellationId,
          executionId: this.instance.executionId,
          targetFutureId: future.futureId,
          status: "requested",
          reasonJson: stringifyResult(reason),
        }).pipe(
          Effect.orDie,
          Effect.withSpan("tiny_firegrid.restate_primitive_compat.cancel", {
            kind: "internal",
            attributes: {
              "firegrid.restate_compat.cancellation_id": cancellationId,
              "firegrid.restate_compat.cancel_target_future_id": future.futureId,
            },
          }),
        )
        return cancellationId
      }),
    })

  readonly longClockProbe = (
    name: string,
    duration: Duration.DurationInput,
  ): Future<string> =>
    this.makeFuture({
      name: `long-clock-probe/${name}`,
      backing: "timer",
      effect: Effect.gen(this, function*() {
        const engine = yield* WorkflowEngine.WorkflowEngine
        const clock = DurableClock.make({
          name: `restate-gen/sleep/${name}`,
          duration,
        })
        yield* engine.scheduleClock(this.instance.workflow, {
          executionId: this.instance.executionId,
          clock,
        })
        yield* Effect.void.pipe(
          Effect.withSpan("tiny_firegrid.restate_primitive_compat.long_clock_probe", {
            kind: "internal",
            attributes: {
              "firegrid.restate_compat.clock_name": name,
              "firegrid.restate_compat.long_clock_probe": "scheduled_without_await",
            },
          }),
        )
        return "long-durable-clock-scheduled"
      }),
    })

  readonly run = <T>(
    action: RunAction<T>,
    options: { readonly name: string },
  ): Future<T> => {
    const effect = Activity.make({
      name: `restate-gen/run/${options.name}`,
      success: Schema.Unknown,
      error: Schema.Unknown,
      execute: Effect.suspend(() => {
        const result = action({ signal: this.abortController.signal })
        return Effect.isEffect(result)
          ? result
          : result instanceof Promise
          ? Effect.tryPromise({ try: () => result, catch: error => error })
          : Effect.succeed(result)
      }),
    }) as Effect.Effect<T, unknown, SchedulerEnv>
    return this.makeFuture({
      name: options.name,
      backing: "journal",
      effect,
    })
  }

  readonly sleep = (
    duration: Duration.DurationInput,
    options: {
      readonly name: string
      readonly inMemoryThreshold?: Duration.DurationInput
    },
  ): Future<void> =>
    this.makeFuture({
      name: options.name,
      backing: "timer",
      effect: DurableClock.sleep({
        name: `restate-gen/sleep/${options.name}`,
        duration,
        inMemoryThreshold: options.inMemoryThreshold ?? Duration.seconds(30),
      }),
    })

  readonly awakeable = <T>(
    name: string,
    schema: Schema.Schema<T>,
  ): { readonly id: DurableDeferred.Token; readonly promise: Future<T> } => {
    const deferred = DurableDeferred.make(`restate-gen/awakeable/${name}`, {
      success: schema,
      error: Schema.Unknown,
    })
    const id = DurableDeferred.tokenFromExecutionId(deferred, {
      workflow: this.instance.workflow,
      executionId: this.instance.executionId,
    })
    return {
      id,
      promise: this.makeFuture({
        name,
        backing: "awakeable",
        effect: DurableDeferred.await(deferred),
      }),
    }
  }

  readonly resolveAwakeable = <T>(
    token: DurableDeferred.Token,
    name: string,
    schema: Schema.Schema<T>,
    value: T,
  ): void => {
    const deferred = DurableDeferred.make(`restate-gen/awakeable/${name}`, {
      success: schema,
      error: Schema.Unknown,
    })
    this.pendingStarts.push(
      DurableDeferred.succeed(deferred, { token, value }),
    )
  }

  readonly spawn = <T>(
    operation: Operation<T>,
    name: string,
  ): Future<T> =>
    this.makeFuture({
      name,
      backing: "routine",
      effect: Effect.gen(this, function*() {
        const routineId = `${this.instance.executionId}:routine:${++this.waiterCounter}:${name}`
        yield* this.table.routines.upsert({
          routineId,
          executionId: this.instance.executionId,
          name,
          status: "running",
          resultJson: "",
        }).pipe(Effect.orDie)
        const result = yield* this.runOperation(operation, { waitForStarted: false })
        yield* this.table.routines.upsert({
          routineId,
          executionId: this.instance.executionId,
          name,
          status: "succeeded",
          resultJson: stringifyResult(result),
        }).pipe(
          Effect.orDie,
          Effect.withSpan("tiny_firegrid.restate_primitive_compat.spawn.routine_row", {
            kind: "internal",
            attributes: {
              "firegrid.restate_compat.routine_id": routineId,
              "firegrid.restate_compat.routine_name": name,
            },
          }),
        )
        return result
      }),
    })

  private readonly drainStarts = (): Effect.Effect<void, never, SchedulerEnv> =>
    Effect.gen(this, function*() {
      while (this.pendingStarts.length > 0) {
        const starts = this.pendingStarts.splice(0)
        const fibers = yield* Effect.forEach(starts, start => Effect.forkDaemon(start))
        this.activeFibers.push(...fibers)
      }
    })

  private readonly waitForStarted = (): Effect.Effect<void, never> =>
    Effect.gen(this, function*() {
      while (this.activeFibers.length > 0) {
        const fibers = this.activeFibers.splice(0)
        yield* Effect.forEach(fibers, Fiber.join, { discard: true })
      }
    })
}

const stringifyResult = (value: unknown): string => {
  const json = JSON.stringify(value)
  return json === undefined ? "undefined" : json
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T

const errorFromUnknown = (error: unknown): Error =>
  error instanceof Error ? error : new Error(stringifyResult(error))

interface HttpProbeResponse {
  readonly status: number
  readonly statusText: string
  readonly body: unknown
}

interface PullWakeRouteProbeResult {
  readonly createData: string
  readonly createWake: string
  readonly createSubscription: string
  readonly appendData: string
  readonly claim: string
  readonly claimWhileHeld: string
  readonly claimWhileHeldError: string
  readonly release: string
  readonly reclaimAfterRelease: string
  readonly staleAckAfterRelease: string
  readonly staleAckAfterReleaseError: string
  readonly ack: string
  readonly ackNextWake: boolean
  readonly claimNextWake: string
  readonly ackNextWakeClaim: string
  readonly claimAfterAck: string
  readonly wakeIdSeen: boolean
  readonly claimedStreamCount: number
  readonly noPendingAfterAck: boolean
  readonly leaseClaim: string
  readonly leaseClaimWhileHeld: string
  readonly leaseClaimWhileHeldError: string
  readonly leaseClaimAfterTtl: string
  readonly timerClaimBeforeAppend: string
  readonly timerClaimBeforeAppendError: string
  readonly timerClaimAfterAppend: string
  readonly timerWakeSeen: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readProbeResponse = async (response: Response): Promise<HttpProbeResponse> => {
  const text = await response.text()
  let body: unknown
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = text
    }
  } else {
    body = null
  }
  return {
    status: response.status,
    statusText: response.statusText,
    body,
  }
}

const statusLabel = (response: HttpProbeResponse): string =>
  `${response.status} ${response.statusText}`

const bodyRecord = (response: HttpProbeResponse): Record<string, unknown> =>
  isRecord(response.body) ? response.body : {}

const errorCode = (response: HttpProbeResponse): string => {
  const body = bodyRecord(response)
  const error = isRecord(body.error) ? body.error : {}
  return typeof error.code === "string" ? error.code : ""
}

const pause = (durationMs: number): Promise<void> =>
  // eslint-disable-next-line local/no-production-js-timers
  new Promise(resolve => setTimeout(resolve, durationMs))

const probePullWakeSubscriptionRoutes = (
  baseUrl: string,
  scenarioId: string,
): Effect.Effect<PullWakeRouteProbeResult, never, never> =>
  Effect.tryPromise({
    try: async () => {
      const suffix = `restate-compat/${scenarioId}`
      const dataStream = `${suffix}/data`
      const wakeStream = `${suffix}/wake`
      const subscriptionId = `restate-compat-${scenarioId}`
      const requestJson = (path: string, init: RequestInit) =>
        fetch(`${baseUrl}${path}`, init).then(readProbeResponse)
      const putStream = (
        path: string,
        contentType: string = "application/octet-stream",
        body?: string,
      ) =>
        requestJson(`/v1/stream/${path}`, {
          method: "PUT",
          headers: { "content-type": contentType },
          ...(body === undefined ? {} : { body }),
        })
      const appendStream = (path: string, body: string) =>
        requestJson(`/v1/stream/${path}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body,
        })
      const subscriptionPath = (id: string, action?: string) =>
        `/v1/stream/__ds/subscriptions/${id}${action === undefined ? "" : `/${action}`}`
      const createPullWakeSubscription = (
        id: string,
        stream: string,
        wake: string,
      ) =>
        requestJson(subscriptionPath(id), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "pull-wake",
            streams: [stream],
            wake_stream: wake,
            lease_ttl_ms: 1_000,
          }),
        })
      const claimSubscription = (id: string, worker: string) =>
        requestJson(subscriptionPath(id, "claim"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worker }),
        })
      const claimAckBody = (response: HttpProbeResponse, stream: string) => {
        const body = bodyRecord(response)
        const streams = Array.isArray(body.streams) ? body.streams : []
        const claimed = streams.find((item): item is Record<string, unknown> =>
          isRecord(item) && item.path === stream)
        return {
          token: typeof body.token === "string" ? body.token : "",
          request: {
            wake_id: typeof body.wake_id === "string" ? body.wake_id : "",
            generation: typeof body.generation === "number" ? body.generation : 0,
            acks: [{
              stream,
              offset: typeof claimed?.tail_offset === "string" ? claimed.tail_offset : "",
            }],
            done: true,
          },
          wakeIdSeen: typeof body.wake_id === "string" && body.wake_id.length > 0,
          claimedStreamCount: streams.length,
        }
      }
      const ackSubscription = (
        id: string,
        token: string,
        request: Record<string, unknown>,
      ) =>
        requestJson(subscriptionPath(id, "ack"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
        })
      const releaseSubscription = (
        id: string,
        token: string,
        request: Record<string, unknown>,
      ) =>
        requestJson(subscriptionPath(id, "release"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
        })

      const createData = await requestJson(`/v1/stream/${dataStream}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
      })
      const createWake = await putStream(wakeStream, "application/json", "[]")
      const createSubscription = await createPullWakeSubscription(
        subscriptionId,
        dataStream,
        wakeStream,
      )
      const appendData = await appendStream(dataStream, `hello:${scenarioId}:1`)
      const claim = await claimSubscription(subscriptionId, "tiny-firegrid-spike-a")
      const claimA = claimAckBody(claim, dataStream)
      const claimWhileHeld = await claimSubscription(subscriptionId, "tiny-firegrid-spike-b")
      const release = await releaseSubscription(
        subscriptionId,
        claimA.token,
        {
          wake_id: claimA.request.wake_id,
          generation: claimA.request.generation,
        },
      )
      const reclaimAfterRelease = await claimSubscription(
        subscriptionId,
        "tiny-firegrid-spike-b",
      )
      const claimB = claimAckBody(reclaimAfterRelease, dataStream)
      const staleAckAfterRelease = await ackSubscription(
        subscriptionId,
        claimA.token,
        claimA.request,
      )
      await appendStream(dataStream, `hello:${scenarioId}:2`)
      const ack = await ackSubscription(subscriptionId, claimB.token, claimB.request)
      const ackBody = bodyRecord(ack)
      const claimNextWake = await claimSubscription(subscriptionId, "tiny-firegrid-spike-c")
      const claimC = claimAckBody(claimNextWake, dataStream)
      const ackNextWakeClaim = await ackSubscription(
        subscriptionId,
        claimC.token,
        claimC.request,
      )
      const claimAfterAck = await claimSubscription(subscriptionId, "tiny-firegrid-spike-d")

      const leaseSubscriptionId = `${subscriptionId}-lease`
      const leaseStream = `${suffix}/lease-data`
      const leaseWakeStream = `${suffix}/lease-wake`
      await putStream(leaseStream)
      await putStream(leaseWakeStream, "application/json", "[]")
      await createPullWakeSubscription(leaseSubscriptionId, leaseStream, leaseWakeStream)
      await appendStream(leaseStream, `lease:${scenarioId}`)
      const leaseClaim = await claimSubscription(leaseSubscriptionId, "lease-a")
      const leaseClaimWhileHeld = await claimSubscription(leaseSubscriptionId, "lease-b")
      await pause(1_200)
      const leaseClaimAfterTtl = await claimSubscription(leaseSubscriptionId, "lease-b")

      const timerSubscriptionId = `${subscriptionId}-timer`
      const timerStream = `${suffix}/timer-data`
      const timerWakeStream = `${suffix}/timer-wake`
      await putStream(timerStream)
      await putStream(timerWakeStream, "application/json", "[]")
      await createPullWakeSubscription(timerSubscriptionId, timerStream, timerWakeStream)
      const timerClaimBeforeAppend = await claimSubscription(timerSubscriptionId, "timer")
      await pause(80)
      await appendStream(timerStream, `timer:${scenarioId}`)
      await pause(50)
      const timerClaimAfterAppend = await claimSubscription(timerSubscriptionId, "timer")
      const timerClaimAfterAppendBody = bodyRecord(timerClaimAfterAppend)

      return {
        createData: statusLabel(createData),
        createWake: statusLabel(createWake),
        createSubscription: statusLabel(createSubscription),
        appendData: statusLabel(appendData),
        claim: statusLabel(claim),
        claimWhileHeld: statusLabel(claimWhileHeld),
        claimWhileHeldError: errorCode(claimWhileHeld),
        release: statusLabel(release),
        reclaimAfterRelease: statusLabel(reclaimAfterRelease),
        staleAckAfterRelease: statusLabel(staleAckAfterRelease),
        staleAckAfterReleaseError: errorCode(staleAckAfterRelease),
        ack: statusLabel(ack),
        ackNextWake: ackBody.next_wake === true,
        claimNextWake: statusLabel(claimNextWake),
        ackNextWakeClaim: statusLabel(ackNextWakeClaim),
        claimAfterAck: statusLabel(claimAfterAck),
        wakeIdSeen: claimA.wakeIdSeen,
        claimedStreamCount: claimA.claimedStreamCount,
        noPendingAfterAck: errorCode(claimAfterAck) === "NO_PENDING_WORK",
        leaseClaim: statusLabel(leaseClaim),
        leaseClaimWhileHeld: statusLabel(leaseClaimWhileHeld),
        leaseClaimWhileHeldError: errorCode(leaseClaimWhileHeld),
        leaseClaimAfterTtl: statusLabel(leaseClaimAfterTtl),
        timerClaimBeforeAppend: statusLabel(timerClaimBeforeAppend),
        timerClaimBeforeAppendError: errorCode(timerClaimBeforeAppend),
        timerClaimAfterAppend: statusLabel(timerClaimAfterAppend),
        timerWakeSeen:
          typeof timerClaimAfterAppendBody.wake_id === "string" &&
          timerClaimAfterAppendBody.wake_id.length > 0,
      }
    },
    catch: error => error,
  }).pipe(
    Effect.catchAll(error =>
      Effect.succeed({
        createData: "request-error",
        createWake: "request-error",
        createSubscription: "request-error",
        appendData: "request-error",
        claim: "request-error",
        claimWhileHeld: "request-error",
        claimWhileHeldError: "",
        release: "request-error",
        reclaimAfterRelease: "request-error",
        staleAckAfterRelease: "request-error",
        staleAckAfterReleaseError: "",
        ack: "request-error",
        ackNextWake: false,
        claimNextWake: "request-error",
        ackNextWakeClaim: "request-error",
        claimAfterAck: `request-error:${stringifyResult(error)}`,
        wakeIdSeen: false,
        claimedStreamCount: 0,
        noPendingAfterAck: false,
        leaseClaim: "request-error",
        leaseClaimWhileHeld: "request-error",
        leaseClaimWhileHeldError: "",
        leaseClaimAfterTtl: "request-error",
        timerClaimBeforeAppend: "request-error",
        timerClaimBeforeAppendError: "",
        timerClaimAfterAppend: "request-error",
        timerWakeSeen: false,
      })),
    Effect.tap(result =>
      Effect.void.pipe(
        Effect.withSpan("tiny_firegrid.restate_primitive_compat.pull_wake.route_probe", {
          kind: "client",
          attributes: {
            "firegrid.restate_compat.pull_wake_probe_url":
              `${baseUrl}/v1/stream/__ds/subscriptions/restate-compat-${scenarioId}/claim`,
            "firegrid.restate_compat.pull_wake_probe_result": JSON.stringify(result),
            "firegrid.restate_compat.pull_wake_create_subscription_status":
              result.createSubscription,
            "firegrid.restate_compat.pull_wake_claim_status": result.claim,
            "firegrid.restate_compat.pull_wake_ack_status": result.ack,
            "firegrid.restate_compat.pull_wake_after_ack_status": result.claimAfterAck,
            "firegrid.restate_compat.pull_wake_no_pending_after_ack":
              result.noPendingAfterAck,
            "firegrid.restate_compat.pull_wake_release_reclaim":
              result.release === "204 No Content" &&
              result.reclaimAfterRelease === "200 OK",
            "firegrid.restate_compat.pull_wake_stale_ack_fenced":
              result.staleAckAfterReleaseError === "FENCED",
            "firegrid.restate_compat.pull_wake_ack_next_wake": result.ackNextWake,
            "firegrid.restate_compat.pull_wake_lease_reclaim":
              result.leaseClaimAfterTtl === "200 OK",
            "firegrid.restate_compat.pull_wake_timer_wake": result.timerWakeSeen,
            "firegrid.restate_compat.pull_wake_probe_note":
              "reserved route installed from @durable-streams/server@0.3.7; this exercises create/claim/release/reclaim/ack/lease/timer wake over the local server",
          },
        }),
      ),
    ),
  )

const execute = <T>(
  operation: Operation<T>,
): Effect.Effect<T, unknown, SchedulerEnv> => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable's dynamic Context.Tag widens the pipe return.
  return WorkflowEngine.WorkflowInstance.pipe(
    Effect.flatMap(instance =>
      RestateCompatSchedulerTable.pipe(
        Effect.flatMap(table => new RestateGenScheduler(instance, table).runOperation(operation)),
      ),
    ),
  )
}

const run = <T>(
  action: RunAction<T>,
  options: { readonly name: string },
): Future<T> => getCurrentScheduler().run(action, options)

const sleep = (
  duration: Duration.DurationInput,
  options: {
    readonly name: string
    readonly inMemoryThreshold?: Duration.DurationInput
  },
): Future<void> => getCurrentScheduler().sleep(duration, options)

const awakeable = <T>(
  name: string,
  schema: Schema.Schema<T>,
): { readonly id: DurableDeferred.Token; readonly promise: Future<T> } =>
  getCurrentScheduler().awakeable(name, schema)

const resolveAwakeable = <T>(
  token: DurableDeferred.Token,
  name: string,
  schema: Schema.Schema<T>,
  value: T,
): void => getCurrentScheduler().resolveAwakeable(token, name, schema, value)

const spawn = <T>(
  operation: Operation<T>,
  options: { readonly name: string },
): Future<T> => getCurrentScheduler().spawn(operation, options.name)

const all = <const T extends readonly Future<unknown>[]>(
  futures: T,
  options: { readonly name: string },
): Future<{ -readonly [P in keyof T]: T[P] extends Future<infer U> ? U : never }> =>
  getCurrentScheduler().all(futures, options.name)

const race = <const T extends readonly Future<unknown>[]>(
  futures: T,
  options: { readonly name: string },
): Future<T[number] extends Future<infer U> ? U : never> =>
  getCurrentScheduler().race(futures, options.name)

const state = <T>(
  name: string,
  initial: T,
): StateCell<T> => getCurrentScheduler().state(name, initial, false)

const sharedState = <T>(
  name: string,
  initial: T,
): StateCell<T> => getCurrentScheduler().state(name, initial, true)

const channel = <T>(
  name: string,
): CompatChannel<T> => getCurrentScheduler().channel(name)

const workflowPromise = <T>(
  name: string,
  schema: Schema.Schema<T>,
): WorkflowPromiseHandle<T> =>
  getCurrentScheduler().workflowPromise(name, schema)

const serviceClient = <I, O>(
  target: string,
  handler: (input: I) => Effect.Effect<O, unknown, SchedulerEnv>,
): { readonly call: (input: I) => Future<O>; readonly send: (input: I) => Future<string> } => ({
  call: input => getCurrentScheduler().serviceCall("service", target, input, handler(input)),
  send: input => getCurrentScheduler().send("service", target, input),
})

const objectClient = <I, O>(
  target: string,
  handler: (input: I) => Effect.Effect<O, unknown, SchedulerEnv>,
): { readonly call: (input: I) => Future<O>; readonly send: (input: I) => Future<string> } => ({
  call: input => getCurrentScheduler().serviceCall("object", target, input, handler(input)),
  send: input => getCurrentScheduler().send("object", target, input),
})

const workflowClient = <I, O>(
  target: string,
  handler: (input: I) => Effect.Effect<O, unknown, SchedulerEnv>,
): { readonly call: (input: I) => Future<O>; readonly send: (input: I) => Future<string> } => ({
  call: input => getCurrentScheduler().serviceCall("workflow", target, input, handler(input)),
  send: input => getCurrentScheduler().send("workflow", target, input),
})

const genericCall = <O>(
  target: string,
  payload: unknown,
  handler: Effect.Effect<O, unknown, SchedulerEnv>,
): Future<O> => getCurrentScheduler().serviceCall("generic", target, payload, handler)

const genericSend = (
  target: string,
  payload: unknown,
): Future<string> => getCurrentScheduler().send("generic", target, payload)

const cancel = (
  future: Future<unknown>,
  reason: unknown,
): Future<string> => getCurrentScheduler().cancel(future, reason)

const longClockProbe = (
  name: string,
  duration: Duration.DurationInput,
): Future<string> => getCurrentScheduler().longClockProbe(name, duration)

const selectByTag = <B extends Record<string, Future<unknown>>>(
  branches: B,
): Operation<SelectResult<B>> =>
  gen(function*() {
    const tagged = Object.entries(branches).map(([tag, future]) =>
      getCurrentScheduler().makeFuture({
        name: `select/${tag}`,
        backing: "combinator",
        effect: future.awaitEffect.pipe(Effect.as(tag)),
      }),
    )
    const winningTag = yield* race(tagged, { name: "select-tag" })
    return {
      tag: winningTag,
      future: branches[winningTag]!,
    } as SelectResult<B>
  })

const ChildOperation = (input: string): Operation<string> =>
  gen(function*() {
    const childStep = run(
      () => Effect.succeed(`${input}:child-step`),
      { name: `child-${input}` },
    )
    return yield* childStep
  })

const CompatPayloadSchema = Schema.Struct({
  scenarioId: Schema.String,
})

const CompatOutputSchema = Schema.Struct({
  allValue: Schema.String,
  raceValue: Schema.String,
  selectTag: Schema.String,
  selectValue: Schema.String,
  spawnedValue: Schema.String,
  awakeableValue: Schema.String,
  stateValue: Schema.String,
  sharedStateValue: Schema.String,
  channelValue: Schema.String,
  workflowPromiseValue: Schema.String,
  clientValues: Schema.String,
  sendIds: Schema.String,
  cancellationId: Schema.String,
  longSleepValue: Schema.String,
  runCount: Schema.Number,
})

const CompatWorkflow = Workflow.make({
  name: "tiny-firegrid.restate-primitive-compat.gen",
  payload: CompatPayloadSchema,
  success: CompatOutputSchema,
  error: Schema.Unknown,
  idempotencyKey: payload => payload.scenarioId,
})

const compatWorkflowLayer = (
  runCount: Ref.Ref<number>,
) =>
  CompatWorkflow.toLayer(payload =>
    execute(gen(function*() {
      const stepA = run(
        () =>
          Ref.updateAndGet(runCount, n => n + 1).pipe(
            Effect.map(n => `A${n}`),
          ),
        { name: `${payload.scenarioId}/step-a` },
      )
      const stepB = run(
        () =>
          Ref.updateAndGet(runCount, n => n + 1).pipe(
            Effect.map(n => `B${n}`),
          ),
        { name: `${payload.scenarioId}/step-b` },
      )
      const [a, b] = yield* all([stepA, stepB], { name: "all-a-b" })

      const slow = run(
        () => Effect.sleep(Duration.millis(15)).pipe(Effect.as("slow")),
        { name: `${payload.scenarioId}/slow-loser` },
      )
      const fast = run(
        () => Effect.succeed("fast"),
        { name: `${payload.scenarioId}/fast-winner` },
      )
      const raceValue = yield* race([slow, fast], { name: "race-fast-slow" })

      const selected = yield* selectByTag({
        tick: sleep(Duration.millis(1), { name: `${payload.scenarioId}/tick` }),
        done: run(
          () => Effect.sleep(Duration.millis(5)).pipe(Effect.as("done")),
          { name: `${payload.scenarioId}/done` },
        ),
      })
      const selectValue = yield* selected.future

      const spawned = spawn(ChildOperation(`${a}-${b}`), { name: "spawn-child" })
      const awake = awakeable("external-signal", Schema.String)
      resolveAwakeable(awake.id, "external-signal", Schema.String, "awakeable-resolved")

      const [spawnedValue, awakeableValue] = yield* all(
        [spawned, awake.promise],
        { name: "spawn-and-awakeable" },
      )

      const localState = state("local-counter", "unset")
      yield* localState.set("local-state-ok")
      const stateValue = yield* localState.get()

      const globalState = sharedState("global-flag", "unset")
      yield* globalState.set("shared-state-ok")
      const sharedStateValue = yield* globalState.get()

      const inbox = channel<string>("single-shot-inbox")
      const channelSend = inbox.send("channel-ok")
      const [channelValue] = yield* all(
        [inbox.receive, channelSend],
        { name: "channel-send-receive" },
      )

      const approval = workflowPromise("approval", Schema.String)
      yield* approval.resolve("workflow-promise-ok")
      const workflowPromiseValue = yield* approval.promise

      const greeter = serviceClient<string, string>(
        "greeter.greet",
        name => Effect.succeed(`service:${name}`),
      )
      const keyedObject = objectClient<string, string>(
        "counter[demo].add",
        value => Effect.succeed(`object:${value}`),
      )
      const workflow = workflowClient<string, string>(
        "workflow.transform",
        value => Effect.succeed(`workflow:${value}`),
      )
      const [serviceValue, objectValue, workflowValue, genericValue] = yield* all(
        [
          greeter.call("firegrid"),
          keyedObject.call("keyed"),
          workflow.call("flow"),
          genericCall("raw.echo", { value: "generic" }, Effect.succeed("generic:ok")),
        ],
        { name: "client-calls" },
      )
      const sendIds = yield* all(
        [
          greeter.send("fire-and-forget"),
          keyedObject.send("fire-and-forget"),
          workflow.send("fire-and-forget"),
          genericSend("raw.notify", { value: "sent" }),
        ],
        { name: "client-sends" },
      )

      const longSleepValue = yield* longClockProbe(
        `${payload.scenarioId}/long-durable-clock`,
        Duration.millis(5),
      )
      yield* run(
        () => Effect.sleep(Duration.millis(20)),
        { name: `${payload.scenarioId}/long-clock-settle` },
      )

      const cancelTarget = run(
        ({ signal }) =>
          Effect.tryPromise({
            try: () =>
              new Promise<string>((resolve) => {
                if (signal.aborted) {
                  resolve("abort-signal-observed")
                  return
                }
                signal.addEventListener(
                  "abort",
                  () => resolve("abort-signal-observed"),
                  { once: true },
                )
              }),
            catch: error => error,
          }),
        { name: `${payload.scenarioId}/cancel-target` },
      )
      const cancellationId = yield* cancel(cancelTarget, "sim cancellation")

      const observedRunCount = yield* run(
        () => Ref.get(runCount),
        { name: `${payload.scenarioId}/observe-run-count` },
      )

      return {
        allValue: `${a}+${b}`,
        raceValue,
        selectTag: String(selected.tag),
        selectValue: String(selectValue),
        spawnedValue,
        awakeableValue,
        stateValue,
        sharedStateValue,
        channelValue,
        workflowPromiseValue,
        clientValues: [serviceValue, objectValue, workflowValue, genericValue].join("|"),
        sendIds: sendIds.join("|"),
        cancellationId,
        longSleepValue,
        runCount: observedRunCount,
      }
    })).pipe(
      Effect.withSpan("tiny_firegrid.restate_primitive_compat.gen_body", {
        kind: "internal",
        attributes: {
          "firegrid.restate_compat.api_shape": "free-standing Operation/Future combinators",
          "firegrid.restate_compat.source_docs": "DESIGN.md,guide.md",
        },
      }),
    ),
  )

const emitMappingSpans = Effect.all([
  Effect.void.pipe(
    Effect.withSpan("tiny_firegrid.restate_primitive_compat.mapping.operation_future", {
      kind: "internal",
      attributes: {
        "firegrid.restate_compat.restate": "Operation<T>/Future<T>",
        "firegrid.restate_compat.firegrid":
          "generator driver plus scheduler-owned future rows over DurableTable",
        "firegrid.restate_compat.compat":
          "promising: user code shape matches free-standing gen/run/all/race/select/spawn",
      },
    }),
  ),
  Effect.void.pipe(
    Effect.withSpan("tiny_firegrid.restate_primitive_compat.mapping.scheduler_ledger", {
      kind: "internal",
      attributes: {
        "firegrid.restate_compat.restate": "Future state plus routine waiters",
        "firegrid.restate_compat.firegrid":
          "DurableTable state-protocol rows for futures/waiters/claim lifecycle",
        "firegrid.restate_compat.compat":
          "partial: row ledger matches the needed scheduler shape; upstream PR #361 provides reserved HTTP pull-wake APIs but this sim uses local rows",
      },
    }),
  ),
  Effect.void.pipe(
    Effect.withSpan("tiny_firegrid.restate_primitive_compat.mapping.run", {
      kind: "internal",
      attributes: {
        "firegrid.restate_compat.restate": "run(action,{name})",
        "firegrid.restate_compat.firegrid": "Activity.make",
        "firegrid.restate_compat.compat": "strong: durable memoized journal step",
      },
    }),
  ),
  Effect.void.pipe(
    Effect.withSpan("tiny_firegrid.restate_primitive_compat.mapping.sleep", {
      kind: "internal",
      attributes: {
        "firegrid.restate_compat.restate": "sleep(duration)",
        "firegrid.restate_compat.firegrid": "DurableClock.sleep",
        "firegrid.restate_compat.compat": "partial: short branch exercised; long park/resume still separate evidence",
      },
    }),
  ),
  Effect.void.pipe(
    Effect.withSpan("tiny_firegrid.restate_primitive_compat.mapping.awakeable", {
      kind: "internal",
      attributes: {
        "firegrid.restate_compat.restate": "awakeable<T>()",
        "firegrid.restate_compat.firegrid": "DurableDeferred token/succeed/await",
        "firegrid.restate_compat.compat": "promising substrate; public resolver ingress not built",
      },
    }),
  ),
], { discard: true })

export const restatePrimitiveCompatDriver = Effect.gen(function*() {
  const config = yield* FiregridConfig
  if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
    return yield* Effect.fail(
      new Error("restate-primitive-compat requires durableStreamsBaseUrl and namespace"),
    )
  }
  const durableStreamsBaseUrl = config.durableStreamsBaseUrl
  const namespace = config.namespace

  const runCount = yield* Ref.make(0)
  const schedulerTableLayer = RestateCompatSchedulerTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        durableStreamsBaseUrl,
        `${namespace}.tiny-firegrid.restate-compat.scheduler-ledger`,
      ),
      contentType: "application/json",
    },
  })
  const workflowEngineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(
      durableStreamsBaseUrl,
      `${namespace}.tiny-firegrid.restate-compat.workflow-engine`,
    ),
  })
  const workflowLayer = compatWorkflowLayer(runCount).pipe(
    Layer.provideMerge(workflowEngineLayer),
    Layer.provideMerge(schedulerTableLayer),
  )
  return yield* Effect.gen(function*() {
    const scenarioId = `gen-${globalThis.crypto.randomUUID()}`
    yield* emitMappingSpans
    const pullWakeRouteProbe = yield* probePullWakeSubscriptionRoutes(
      durableStreamsBaseUrl,
      scenarioId,
    )
    const first = yield* CompatWorkflow.execute({ scenarioId })
    const second = yield* CompatWorkflow.execute({ scenarioId })
    const schedulerTable = yield* RestateCompatSchedulerTable
    const futureRows = yield* schedulerTable.futures.query(collection => collection.toArray)
    const waiterRows = yield* schedulerTable.waiters.query(collection => collection.toArray)
    const claimRows = yield* schedulerTable.claims.query(collection => collection.toArray)
    const stateRows = yield* schedulerTable.stateRows.query(collection => collection.toArray)
    const channelRows = yield* schedulerTable.channels.query(collection => collection.toArray)
    const routineRows = yield* schedulerTable.routines.query(collection => collection.toArray)
    const cancellationRows = yield* schedulerTable.cancellations.query(collection => collection.toArray)
    const serviceCallRows = yield* schedulerTable.serviceCalls.query(collection => collection.toArray)
    const succeededLosers = futureRows.filter(row =>
      row.status === "succeeded" &&
      (row.name.includes("slow-loser") || row.name.includes("done")),
    ).length
    yield* Effect.void.pipe(
      Effect.withSpan("tiny_firegrid.restate_primitive_compat.exercise_summary", {
        kind: "internal",
        attributes: {
          "firegrid.restate_compat.scenario_count": 15,
          "firegrid.restate_compat.free_functions":
            "gen,execute,run,sleep,awakeable,workflowPromise,all,race,select,spawn,state,sharedState,channel,serviceClient,objectClient,workflowClient,genericCall,genericSend,cancel",
          "firegrid.restate_compat.first_result": JSON.stringify(first),
          "firegrid.restate_compat.second_result": JSON.stringify(second),
          "firegrid.restate_compat.activity_runs_after_duplicate_execute": first.runCount,
          "firegrid.restate_compat.future_row_count": futureRows.length,
          "firegrid.restate_compat.waiter_row_count": waiterRows.length,
          "firegrid.restate_compat.claim_row_count": claimRows.length,
          "firegrid.restate_compat.state_row_count": stateRows.length,
          "firegrid.restate_compat.channel_row_count": channelRows.length,
          "firegrid.restate_compat.routine_row_count": routineRows.length,
          "firegrid.restate_compat.cancellation_row_count": cancellationRows.length,
          "firegrid.restate_compat.service_call_row_count": serviceCallRows.length,
          "firegrid.restate_compat.race_select_loser_success_count": succeededLosers,
          "firegrid.restate_compat.pull_wake_route_probe": JSON.stringify(pullWakeRouteProbe),
          "firegrid.restate_compat.pull_wake_claim_status": pullWakeRouteProbe.claim,
          "firegrid.restate_compat.pull_wake_ack_status": pullWakeRouteProbe.ack,
          "firegrid.restate_compat.pull_wake_no_pending_after_ack":
            pullWakeRouteProbe.noPendingAfterAck,
          "firegrid.restate_compat.major_gap_1":
            "@durable-streams/server@0.3.7 reserved subscription APIs can deliver pull-wake create/claim/ack; remaining work is mapping Restate Future scheduling onto that transport and durable state rows",
          "firegrid.restate_compat.major_gap_2":
            "routine-backed spawn writes sim rows but is not yet mapped onto durable routine rows and reclaim semantics as a restart-safe routine Future",
          "firegrid.restate_compat.major_gap_3": "cancellation writes rows and aborts run signals but is not invocation-level TerminalError semantics",
          "firegrid.restate_compat.major_gap_4":
            "service/object/workflow client helpers are out-of-scope for the free-standing Operation/Future scheduler spike",
        },
      }),
    )
  }).pipe(
    Effect.provide(
      Layer.mergeAll(schedulerTableLayer, workflowLayer),
    ),
    Effect.withSpan("tiny_firegrid.restate_primitive_compat.driver_workbench", {
      kind: "client",
      attributes: {
        "firegrid.restate_compat.greenfield_substrate": true,
        "firegrid.restate_compat.hostless_sim": true,
      },
    }),
  )
}).pipe(
  Effect.withSpan("tiny_firegrid.restate_primitive_compat.driver", {
    kind: "client",
  }),
)
