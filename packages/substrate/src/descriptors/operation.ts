import { Brand, Schema } from "effect"

// firegrid-operation-messaging.OPERATIONS.4
// firegrid-operation-messaging.RUNTIME_HANDLERS.1
//
// Wire envelope for operation messages. The substrate's `durable.run`
// row carries caller input on its substrate-generic `data` field; to
// dispatch by operation name in runtime handlers, `client.send`
// wraps the encoded input in this envelope. The constant is owned
// here so the client (encode side) and the runtime handler (decode
// side) cannot drift.
export const OPERATION_ENVELOPE_TAG = "firegrid/operation@1" as const

export interface OperationEnvelope {
  readonly _envelope: typeof OPERATION_ENVELOPE_TAG
  readonly operation: string
  readonly payload: unknown
}

export const isOperationEnvelope = (
  value: unknown,
): value is OperationEnvelope =>
  typeof value === "object" &&
  value !== null &&
  (value as OperationEnvelope)._envelope === OPERATION_ENVELOPE_TAG

// firegrid-operation-messaging.OPERATIONS.1
// firegrid-operation-messaging.OPERATIONS.2
// firegrid-operation-messaging.OPERATIONS.4
// firegrid-operation-messaging.RUNTIME_HANDLERS.1
//
// Operation is a browser-safe descriptor value: a name plus
// input / output / error Schemas. It carries no runtime handler,
// no Durable Streams URL, no substrate writer, no mutable
// registration state. Both clients and runtimes import the same
// descriptor module; runtime handler installation happens
// separately via runtime-only Layer constructors.
//
// This module depends only on Effect / Schema / Brand so a future
// extraction to @firegrid/core is mechanical. If a future change
// requires substrate internals here, stop and reconsider — pulling
// substrate internals into descriptors would break the descriptor-
// as-shared-kernel boundary.
//
// Schema bound: we use `Schema.Schema.All`, not `Schema.Schema.Any`.
// Effect's `Schema.Schema.Any = Schema<any, any, unknown>` is
// documented as "Any schema, except for `never`" — i.e. it
// intentionally excludes `Schema.Never`. `Schema.Schema.All` adds
// the `Schema<never, ..., ...>` branches and is the narrowest
// supertype that admits every concrete user schema *plus*
// `Schema.Never` as the "no typed error" default. Picking `All`
// also keeps the descriptor schema slots truly typed as Schemas
// (not weakened to `unknown`) so type-level extraction goes
// through the framework's own `Schema.Schema.Type` /
// `Schema.Schema.Encoded` helpers.

export type OperationHandleId = string & Brand.Brand<"OperationHandleId">
export const OperationHandleId =
  Brand.nominal<OperationHandleId>()
declare const OperationHandleDescriptor: unique symbol

export interface OperationDescriptor<
  Name extends string = string,
  InputSchema extends Schema.Schema.All = Schema.Schema.All,
  OutputSchema extends Schema.Schema.All = Schema.Schema.All,
  ErrorSchema extends Schema.Schema.All = Schema.Schema.All,
> {
  readonly _tag: "Operation"
  readonly name: Name
  readonly input: InputSchema
  readonly output: OutputSchema
  readonly error: ErrorSchema
}

export interface OperationDefinition<
  Name extends string,
  InputSchema extends Schema.Schema.All,
  OutputSchema extends Schema.Schema.All,
  ErrorSchema extends Schema.Schema.All,
> {
  readonly name: Name
  readonly input: InputSchema
  readonly output: OutputSchema
  readonly error?: ErrorSchema
}

const defineOperation = <
  Name extends string,
  InputSchema extends Schema.Schema.All,
  OutputSchema extends Schema.Schema.All,
  ErrorSchema extends Schema.Schema.All = typeof Schema.Never,
>(
  args: OperationDefinition<Name, InputSchema, OutputSchema, ErrorSchema>,
): OperationDescriptor<Name, InputSchema, OutputSchema, ErrorSchema> =>
  Object.freeze({
    _tag: "Operation",
    name: args.name,
    input: args.input,
    output: args.output,
    error: (args.error ?? Schema.Never) as ErrorSchema,
  })

export const Operation = {
  define: defineOperation,
} as const

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Operation {
  export type Any = OperationDescriptor<
    string,
    Schema.Schema.All,
    Schema.Schema.All,
    Schema.Schema.All
  >

  export type Input<Op extends Any> = Schema.Schema.Type<Op["input"]>
  export type Output<Op extends Any> = Schema.Schema.Type<Op["output"]>
  export type Error<Op extends Any> = Schema.Schema.Type<Op["error"]>
  export type EncodedInput<Op extends Any> = Schema.Schema.Encoded<Op["input"]>
  export type EncodedOutput<Op extends Any> = Schema.Schema.Encoded<Op["output"]>
  export type EncodedError<Op extends Any> = Schema.Schema.Encoded<Op["error"]>
}

// firegrid-operation-messaging.CLIENT_MESSAGING.1
// firegrid-operation-messaging.CLIENT_MESSAGING.3
// firegrid-operation-messaging.CLIENT_MESSAGING.4
//
// OperationHandle is a typed durable handle returned by send and
// consumed by result / observe. `_operation` keeps the operation name
// visible at runtime; the unique-symbol phantom preserves the full
// descriptor type at compile time, including same-name descriptors with
// divergent schemas.

export interface OperationHandle<Op extends Operation.Any> {
  readonly _tag: "OperationHandle"
  readonly id: OperationHandleId
  readonly _operation: Op["name"]
  readonly [OperationHandleDescriptor]?: (op: Op) => Op
}

export const OperationHandle = {
  make: <Op extends Operation.Any>(
    op: Op,
    id: string,
  ): OperationHandle<Op> =>
    Object.freeze({
      _tag: "OperationHandle" as const,
      id: OperationHandleId(id),
      _operation: op.name,
    }),
} as const
