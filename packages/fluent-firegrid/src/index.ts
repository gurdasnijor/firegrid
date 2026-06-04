import { Data, Effect, Schema } from "effect"
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

const JournalEventSchema = Schema.Union(
  StepSucceededEventSchema,
  StepFailedEventSchema,
)

type JournalEvent = Schema.Schema.Type<typeof JournalEventSchema>
type StepSucceededEvent = Schema.Schema.Type<typeof StepSucceededEventSchema>
type StepFailedEvent = Schema.Schema.Type<typeof StepFailedEventSchema>
type JournalRequirements =
  ReturnType<DurableStream.Bound<JournalEvent, JournalEvent>["append"]> extends
    Effect.Effect<unknown, unknown, infer Requirements> ? Requirements : never

export interface ExecutionContext {
  // fluent-firegrid-keystone.PACKAGE.3
  readonly journal: {
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

  constructor(
    readonly effect: Effect.Effect<T, FluentFiregridError, JournalRequirements>,
  ) {
    this.leaf = makePrimitive({ _tag: "Leaf", future: this })
  }

  [Symbol.iterator](): Iterator<unknown, T, unknown> {
    return this.leaf[Symbol.iterator]()
  }
}

// fluent-firegrid-keystone.DURABLE_RUN.1
export type RunAction<T> = (
  options: { readonly signal: AbortSignal },
) => T | Promise<T> | Effect.Effect<T, unknown>

export interface RunOptions {
  readonly name?: string
}

export type Handler<Input, Output> = (
  ctx: ExecutionContext,
  input: Input,
) => Effect.Effect<Output, unknown, JournalRequirements>

type AnyHandler = Handler<never, unknown>

export interface ServiceDefinition<
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
> {
  readonly name: Name
  readonly handlers: Handlers
}

type InputOf<H> = H extends Handler<infer Input, unknown> ? Input : never
type OutputOf<H> = H extends Handler<never, infer Output> ? Output : never

type ServiceClient<Handlers extends Record<string, AnyHandler>> = {
  readonly [Key in keyof Handlers]: (
    input: InputOf<Handlers[Key]>,
  ) => Effect.Effect<OutputOf<Handlers[Key]>, unknown, JournalRequirements>
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

class Scheduler {
  private nextStepIndex = 0

  constructor(
    private readonly stream: DurableStream.Bound<JournalEvent, JournalEvent>,
    private readonly events: ReadonlyArray<JournalEvent>,
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

export const execute = <T>(
  ctx: ExecutionContext,
  operation: Operation<T>,
): Effect.Effect<T, unknown, JournalRequirements> =>
  Effect.gen(function* () {
    // fluent-firegrid-keystone.SUBSTRATE.2
    const journal = DurableStream.define({
      endpoint: ctx.journal.endpoint,
      schema: JournalEventSchema,
    })
    yield* journal.create({ contentType: "application/json" })
    const events = yield* journal.collect
    const scheduler = new Scheduler(journal, events)
    const iterator = operation[Symbol.iterator]()
    let resume: unknown = undefined

    while (true) {
      const next = withCurrentScheduler(scheduler, () => iterator.next(resume))
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
          resume = yield* node.future.effect
          break
        }
      }
    }
  })

// fluent-firegrid-keystone.PACKAGE.2
export const service = <
  const Name extends string,
  const Handlers extends Record<string, AnyHandler>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ServiceDefinition<Name, Handlers> => definition

export const invoke = <
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
  Key extends keyof Handlers,
>(
  definition: ServiceDefinition<Name, Handlers>,
  handlerName: Key,
  input: InputOf<Handlers[Key]>,
  ctx: ExecutionContext,
): Effect.Effect<OutputOf<Handlers[Key]>, unknown, JournalRequirements> =>
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
  Handlers extends Record<string, AnyHandler>,
>(
  definition: ServiceDefinition<Name, Handlers>,
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
