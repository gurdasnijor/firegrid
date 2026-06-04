import { Data, Effect, Schema } from "effect"
import { DurableStream, type Endpoint } from "effect-durable-streams"

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

export interface HandlerContext {
  readonly run: <A>(
    name: string,
    fn: (options: { readonly signal: AbortSignal }) => A | Promise<A> | Effect.Effect<A, unknown>,
  ) => Effect.Effect<A, FluentFiregridError, JournalRequirements>
}

export type Handler<Input, Output> = (
  ctx: HandlerContext,
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

export interface InvocationOptions {
  readonly journal: {
    readonly endpoint: Endpoint
  }
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

const effectFromStep = <A>(
  fn: (options: { readonly signal: AbortSignal }) => A | Promise<A> | Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.suspend(() => {
    const result = fn({ signal: new AbortController().signal })
    if (Effect.isEffect(result)) return result
    return Effect.promise(() => Promise.resolve(result))
  })

const failStep = <A>(
  stepKey: string,
  failed: StepFailedEvent,
): Effect.Effect<A, FluentFiregridError> =>
  Effect.fail(new FluentFiregridError({
    message: `Journaled step failed: ${stepKey}: ${failed.message}`,
    ...(failed.cause === undefined ? {} : { cause: failed.cause }),
  }))

const makeContext = (
  stream: DurableStream.Bound<JournalEvent, JournalEvent>,
  events: ReadonlyArray<JournalEvent>,
): HandlerContext => {
  let nextStepIndex = 0
  return {
    run: <A>(name: string, fn: (options: { readonly signal: AbortSignal }) => A | Promise<A> | Effect.Effect<A, unknown>) =>
      Effect.gen(function* () {
        // fluent-firegrid-keystone.DURABLE_RUN.4
        const stepKey = `${nextStepIndex}:${name}`
        nextStepIndex += 1

        const succeeded = events.find((event) => isStepSucceeded(event, stepKey))
        if (succeeded !== undefined) {
          // fluent-firegrid-keystone.DURABLE_RUN.3
          return succeeded.value as A
        }
        const failed = events.find((event) => isStepFailed(event, stepKey))
        if (failed !== undefined) {
          return yield* failStep<A>(stepKey, failed)
        }

        const value = yield* effectFromStep(fn).pipe(
          Effect.mapError((cause) =>
            new FluentFiregridError({
              message: `Step failed before journal append: ${stepKey}`,
              cause,
            }),
          ),
        )

        // fluent-firegrid-keystone.DURABLE_RUN.2
        yield* stream.append({
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
  }
}

export const service = <
  const Name extends string,
  const Handlers extends Record<string, AnyHandler>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ServiceDefinition<Name, Handlers> => definition

export const execute = <
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
  Key extends keyof Handlers,
>(
  definition: ServiceDefinition<Name, Handlers>,
  handlerName: Key,
  input: InputOf<Handlers[Key]>,
  options: InvocationOptions,
): Effect.Effect<OutputOf<Handlers[Key]>, unknown, JournalRequirements> =>
  Effect.gen(function* () {
    const journal = DurableStream.define({
      endpoint: options.journal.endpoint,
      schema: JournalEventSchema,
    })
    yield* journal.create({ contentType: "application/json" })
    const events = yield* journal.collect
    const ctx = makeContext(journal, events)
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
  options: InvocationOptions,
): ServiceClient<Handlers> =>
  new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined
      return (input: unknown) => execute(
        definition,
        property as keyof Handlers,
        input as InputOf<Handlers[keyof Handlers]>,
        options,
      )
    },
  }) as ServiceClient<Handlers>
