import { Effect, Schema, type ParseResult } from "effect"

const boundarySchema = <S extends Schema.Schema.All>(
  schema: S,
): Schema.Schema.AnyNoContext =>
  schema as Schema.Schema.AnyNoContext

// firegrid-remediation-hardening.CODE_REUSE.6
// Descriptor schema slots intentionally admit every concrete user schema.
// Runtime/client boundaries in this repo only support context-free schemas,
// so the AnyNoContext cast is centralized here instead of repeated at each
// Operation/EventStream encode/decode call.
export const decodeAtBoundary =
  <S extends Schema.Schema.All, E>(
    schema: S,
    mapError: (cause: ParseResult.ParseError) => E,
  ) =>
  (value: unknown): Effect.Effect<Schema.Schema.Type<S>, E> =>
    Schema.decodeUnknown(boundarySchema(schema))(value).pipe(
      Effect.mapError(mapError),
    ) as Effect.Effect<Schema.Schema.Type<S>, E>

export const encodeAtBoundary =
  <S extends Schema.Schema.All, E>(
    schema: S,
    mapError: (cause: ParseResult.ParseError) => E,
  ) =>
  (value: Schema.Schema.Type<S>): Effect.Effect<Schema.Schema.Encoded<S>, E> =>
    Schema.encodeUnknown(boundarySchema(schema))(value).pipe(
      Effect.mapError(mapError),
    ) as Effect.Effect<Schema.Schema.Encoded<S>, E>
