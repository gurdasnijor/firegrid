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

class RestateCompatSchedulerTable extends DurableTable("tiny.firegrid.restatePrimitiveCompat", {
  futures: FutureRowSchema,
  waiters: WaiterRowSchema,
  claims: ClaimRowSchema,
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
    name: string,
  ): Future<void> =>
    this.makeFuture({
      name,
      backing: "timer",
      effect: DurableClock.sleep({
        name: `restate-gen/sleep/${name}`,
        duration,
        inMemoryThreshold: Duration.seconds(30),
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
      effect: this.runOperation(operation, { waitForStarted: false }),
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

const errorFromUnknown = (error: unknown): Error =>
  error instanceof Error ? error : new Error(stringifyResult(error))

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
  options: { readonly name: string },
): Future<void> => getCurrentScheduler().sleep(duration, options.name)

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
          "partial: row ledger matches the needed scheduler shape; pull-wake is simulated, not an HTTP subscription worker",
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

  const runCount = yield* Ref.make(0)
  const schedulerTableLayer = RestateCompatSchedulerTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        config.durableStreamsBaseUrl,
        `${config.namespace}.tiny-firegrid.restate-compat.scheduler-ledger`,
      ),
      contentType: "application/json",
    },
  })
  const workflowEngineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(
      config.durableStreamsBaseUrl,
      `${config.namespace}.tiny-firegrid.restate-compat.workflow-engine`,
    ),
  })
  const workflowLayer = compatWorkflowLayer(runCount).pipe(
    Layer.provideMerge(workflowEngineLayer),
    Layer.provideMerge(schedulerTableLayer),
  )
  return yield* Effect.gen(function*() {
    const scenarioId = `gen-${globalThis.crypto.randomUUID()}`
    yield* emitMappingSpans
    const first = yield* CompatWorkflow.execute({ scenarioId })
    const second = yield* CompatWorkflow.execute({ scenarioId })
    const schedulerTable = yield* RestateCompatSchedulerTable
    const futureRows = yield* schedulerTable.futures.query(collection => collection.toArray)
    const waiterRows = yield* schedulerTable.waiters.query(collection => collection.toArray)
    const claimRows = yield* schedulerTable.claims.query(collection => collection.toArray)
    const succeededLosers = futureRows.filter(row =>
      row.status === "succeeded" &&
      (row.name.includes("slow-loser") || row.name.includes("done")),
    ).length
    yield* Effect.void.pipe(
      Effect.withSpan("tiny_firegrid.restate_primitive_compat.exercise_summary", {
        kind: "internal",
        attributes: {
          "firegrid.restate_compat.scenario_count": 7,
          "firegrid.restate_compat.free_functions":
            "gen,execute,run,sleep,awakeable,resolveAwakeable,all,race,select,spawn",
          "firegrid.restate_compat.first_result": JSON.stringify(first),
          "firegrid.restate_compat.second_result": JSON.stringify(second),
          "firegrid.restate_compat.activity_runs_after_duplicate_execute": first.runCount,
          "firegrid.restate_compat.future_row_count": futureRows.length,
          "firegrid.restate_compat.waiter_row_count": waiterRows.length,
          "firegrid.restate_compat.claim_row_count": claimRows.length,
          "firegrid.restate_compat.race_select_loser_success_count": succeededLosers,
          "firegrid.restate_compat.major_gap_1":
            "scheduler ledger is sim-local; pull-wake claim/ack/release is represented as rows/spans, not a product worker",
          "firegrid.restate_compat.major_gap_2": "routine-backed spawn is not durable across process restart",
          "firegrid.restate_compat.major_gap_3": "cancellation fan-out and AbortSignal hygiene are only sketched",
          "firegrid.restate_compat.major_gap_4": "state/sharedState/client/channel primitives not implemented in this pass",
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
