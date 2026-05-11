import { Schema } from "effect"

/**
 * Wire-format schemas for the Durable Streams State Protocol.
 * Direct translation of https://github.com/durable-streams/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md
 */

export const Operation = Schema.Literal("insert", "update", "delete", "upsert")
export type Operation = typeof Operation.Type

export const ChangeHeaders = Schema.Struct({
  operation: Operation,
  txid: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
})

/**
 * A change message parameterized by the value schema for its entity type.
 * Per §4.1: `value` is required for insert/update; for delete it MAY be
 * present (typically `null` or omitted). `old_value` is optional and
 * typically present for update/delete.
 */
export const ChangeMessage = <V, VI>(valueSchema: Schema.Schema<V, VI>) =>
  Schema.Struct({
    type: Schema.NonEmptyString,
    key: Schema.NonEmptyString,
    value: Schema.optional(Schema.NullOr(valueSchema)),
    old_value: Schema.optional(Schema.NullOr(valueSchema)),
    headers: ChangeHeaders,
  })

export const ControlOperation = Schema.Literal(
  "snapshot-start",
  "snapshot-end",
  "reset",
)
export type ControlOperation = typeof ControlOperation.Type

export const ControlHeaders = Schema.Struct({
  control: ControlOperation,
  offset: Schema.optional(Schema.String),
})

/**
 * Control messages carry stream-management signals (snapshot boundaries
 * and reset). They are distinguished from change messages by the presence
 * of `headers.control` (instead of `headers.operation`).
 */
export const ControlMessage = Schema.Struct({
  headers: ControlHeaders,
})

export const Message = <V, VI>(valueSchema: Schema.Schema<V, VI>) =>
  Schema.Union(ChangeMessage(valueSchema), ControlMessage)

export type ChangeMessage<V> = {
  readonly type: string
  readonly key: string
  readonly value?: V | null
  readonly old_value?: V | null
  readonly headers: {
    readonly operation: Operation
    readonly txid?: string
    readonly timestamp?: string
  }
}

export type ControlMessage = {
  readonly headers: {
    readonly control: ControlOperation
    readonly offset?: string
  }
}

export type Message<V> = ChangeMessage<V> | ControlMessage

export const isControlMessage = <V>(msg: Message<V>): msg is ControlMessage =>
  "control" in (msg.headers as object)

export const isChangeMessage = <V>(msg: Message<V>): msg is ChangeMessage<V> =>
  "operation" in (msg.headers as object)
