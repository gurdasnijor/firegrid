import { Schema } from "effect"
import type { Effect, Stream } from "effect"

export const ChannelDirectionSchema = Schema.Literal(
  "ingress",
  "egress",
  "call",
  "bidirectional",
)
export type ChannelDirection = Schema.Schema.Type<typeof ChannelDirectionSchema>

export const ChannelSourceClassSchema = Schema.Literal(
  "static-source",
  "predicate-eligible",
)
export type ChannelSourceClass = Schema.Schema.Type<typeof ChannelSourceClassSchema>

export const ChannelTargetSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ChannelTarget"),
)
export type ChannelTarget = Schema.Schema.Type<typeof ChannelTargetSchema>

export const makeChannelTarget = (target: string): ChannelTarget =>
  Schema.decodeUnknownSync(ChannelTargetSchema)(target)

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

export interface IngressChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "ingress"
  readonly schema: S
  readonly sourceClass?: ChannelSourceClass
  readonly binding: TypedStreamBinding<S>
}

export interface EgressChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "egress"
  readonly schema: S
  readonly binding: AppendTargetBinding<S>
}

export interface BidirectionalChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "bidirectional"
  readonly directions: readonly ["ingress", "egress"]
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
  | IngressChannel
  | EgressChannel
  | BidirectionalChannel
  | CallableChannel

export const makeIngressChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly sourceClass?: ChannelSourceClass
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
  },
): IngressChannel<S> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "ingress",
  schema: options.schema,
  ...(options.sourceClass === undefined
    ? {}
    : { sourceClass: options.sourceClass }),
  binding: {
    _tag: "TypedStream",
    stream: options.stream,
  },
})

export const makeEgressChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly append: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  },
): EgressChannel<S> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "egress",
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
  directions: ["ingress", "egress"],
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
