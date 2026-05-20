import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Stream } from "effect"

export const ChannelDirectionSchema = Schema.Literal(
  "afferent",
  "efferent",
  "call",
  "bidirectional",
)
export type ChannelDirection = Schema.Schema.Type<typeof ChannelDirectionSchema>

export const ChannelSourceClassSchema = Schema.Literal(
  "static-source",
  "predicate-eligible",
)
export type ChannelSourceClass = Schema.Schema.Type<typeof ChannelSourceClassSchema>

// firegrid-agent-body-plan.CHANNEL_REGISTRY.1
export const ChannelTargetSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ChannelTarget"),
)
export type ChannelTarget = Schema.Schema.Type<typeof ChannelTargetSchema>

export const makeChannelTarget = (target: string): ChannelTarget =>
  Schema.decodeUnknownSync(ChannelTargetSchema)(target)

export const FactoryEventsChannelTarget = makeChannelTarget("factory.events")

export const FactoryEventSchema = Schema.Struct({
  eventType: Schema.String,
  payload: Schema.Unknown,
})
export type FactoryEvent = Schema.Schema.Type<typeof FactoryEventSchema>

export class UnknownChannelTarget extends Schema.TaggedError<UnknownChannelTarget>()(
  "UnknownChannelTarget",
  {
    target: Schema.String,
  },
) {}

export interface TypedStreamBinding<S extends Schema.Schema.Any = Schema.Schema.Any> {
  readonly _tag: "TypedStream"
  readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
}

export interface AppendTargetBinding<S extends Schema.Schema.Any = Schema.Schema.Any> {
  readonly _tag: "AppendTarget"
  readonly append: (
    payload: Schema.Schema.Type<S>,
  ) => Effect.Effect<void, unknown, never>
}

export interface CallTargetBinding<
  Request extends Schema.Schema.Any = Schema.Schema.Any,
  Response extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly _tag: "CallTarget"
  readonly call: (
    request: Schema.Schema.Type<Request>,
  ) => Effect.Effect<Schema.Schema.Type<Response>, unknown, never>
}

export interface AfferentChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "afferent"
  readonly schema: S
  readonly sourceClass?: ChannelSourceClass
  readonly binding: TypedStreamBinding<S>
}

export interface EfferentChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "efferent"
  readonly schema: S
  readonly binding: AppendTargetBinding<S>
}

export interface BidirectionalChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "bidirectional"
  readonly directions: readonly ["afferent", "efferent"]
  readonly schema: S
  readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
  readonly binding: {
    readonly _tag: "Bidirectional"
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
    readonly append: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  }
}

export interface CallableChannel<
  Request extends Schema.Schema.Any = Schema.Schema.Any,
  Response extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "call"
  readonly requestSchema: Request
  readonly responseSchema: Response
  readonly binding: CallTargetBinding<Request, Response>
}

export type ChannelRegistration =
  | AfferentChannel
  | EfferentChannel
  | BidirectionalChannel
  | CallableChannel

export type ChannelMetadata =
  | {
    readonly target: ChannelTarget
    readonly direction: "afferent"
    readonly schema: Schema.Schema.Any
    readonly sourceClass?: ChannelSourceClass
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "efferent"
    readonly schema: Schema.Schema.Any
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "bidirectional"
    readonly directions: readonly ["afferent", "efferent"]
    readonly schema: Schema.Schema.Any
    readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "call"
    readonly requestSchema: Schema.Schema.Any
    readonly responseSchema: Schema.Schema.Any
  }

export interface ChannelRegistryService {
  readonly list: () => ReadonlyArray<ChannelRegistration>
  readonly metadata: () => ReadonlyArray<ChannelMetadata>
  readonly get: (target: ChannelTarget | string) => Option.Option<ChannelRegistration>
  readonly getMetadata: (target: ChannelTarget | string) => Option.Option<ChannelMetadata>
  readonly require: (
    target: ChannelTarget | string,
  ) => Effect.Effect<ChannelRegistration, UnknownChannelTarget>
}

export class ChannelRegistry extends Context.Tag(
  "firegrid/host-sdk/ChannelRegistry",
)<ChannelRegistry, ChannelRegistryService>() {}

const normalizeTarget = (target: ChannelTarget | string): string => target

const channelMetadata = (registration: ChannelRegistration): ChannelMetadata => {
  switch (registration.direction) {
    case "afferent":
      return {
        target: registration.target,
        direction: registration.direction,
        schema: registration.schema,
        ...(registration.sourceClass === undefined
          ? {}
          : { sourceClass: registration.sourceClass }),
      }
    case "efferent":
      return {
        target: registration.target,
        direction: registration.direction,
        schema: registration.schema,
      }
    case "bidirectional":
      return {
        target: registration.target,
        direction: registration.direction,
        directions: registration.directions,
        schema: registration.schema,
        sourceClasses: registration.sourceClasses,
      }
    case "call":
      return {
        target: registration.target,
        direction: registration.direction,
        requestSchema: registration.requestSchema,
        responseSchema: registration.responseSchema,
      }
  }
}

export const makeAfferentChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly sourceClass?: ChannelSourceClass
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
  },
): AfferentChannel<S> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "afferent",
  schema: options.schema,
  ...(options.sourceClass === undefined
    ? {}
    : { sourceClass: options.sourceClass }),
  binding: {
    _tag: "TypedStream",
    stream: options.stream,
  },
})

export const makeEfferentChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly append: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  },
): EfferentChannel<S> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "efferent",
  schema: options.schema,
  binding: {
    _tag: "AppendTarget",
    append: options.append,
  },
})

export const makeBidirectionalChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
    readonly append: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  },
): BidirectionalChannel<S> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "bidirectional",
  directions: ["afferent", "efferent"],
  schema: options.schema,
  sourceClasses: options.sourceClasses,
  binding: {
    _tag: "Bidirectional",
    stream: options.stream,
    append: options.append,
  },
})

export const makeCallableChannel = <
  Request extends Schema.Schema.Any,
  Response extends Schema.Schema.Any,
>(
  options: {
    readonly target: ChannelTarget | string
    readonly requestSchema: Request
    readonly responseSchema: Response
    readonly call: (
      request: Schema.Schema.Type<Request>,
    ) => Effect.Effect<Schema.Schema.Type<Response>, unknown, never>
  },
): CallableChannel<Request, Response> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "call",
  requestSchema: options.requestSchema,
  responseSchema: options.responseSchema,
  binding: {
    _tag: "CallTarget",
    call: options.call,
  },
})

// firegrid-agent-body-plan.CHANNEL_REGISTRY.5
export const makeFactoryEventsChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly schema: S
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
  },
): AfferentChannel<S> =>
  makeAfferentChannel({
    target: FactoryEventsChannelTarget,
    schema: options.schema,
    stream: options.stream,
  })

export const makeChannelRegistry = (
  registrations: Iterable<ChannelRegistration>,
): ChannelRegistryService => {
  const ordered = Array.from(registrations)
  const byTarget = new Map<string, ChannelRegistration>()
  const metadataByTarget = new Map<string, ChannelMetadata>()
  ordered.forEach((registration) => {
    const key = normalizeTarget(registration.target)
    if (!byTarget.has(key)) {
      byTarget.set(key, registration)
      metadataByTarget.set(key, channelMetadata(registration))
    }
  })
  return {
    list: () => ordered,
    metadata: () => ordered.map(channelMetadata),
    get: target => Option.fromNullable(byTarget.get(normalizeTarget(target))),
    getMetadata: target =>
      Option.fromNullable(metadataByTarget.get(normalizeTarget(target))),
    require: target => {
      const key = normalizeTarget(target)
      return Option.match(Option.fromNullable(byTarget.get(key)), {
        onNone: () => Effect.fail(new UnknownChannelTarget({ target: key })),
        onSome: registration => Effect.succeed(registration),
      })
    },
  }
}

// firegrid-agent-body-plan.CHANNEL_REGISTRY.2
export const ChannelRegistryLive = (
  registrations: Iterable<ChannelRegistration> = [],
): Layer.Layer<ChannelRegistry> =>
  Layer.sync(ChannelRegistry, () => makeChannelRegistry(registrations))
