import type {
  MessageProjection,
  SessionProjection,
} from "@firegrid/protocol/session"

export type SessionStateChange =
  | {
    readonly kind: "upsertSession"
    readonly value: SessionProjection
  }
  | {
    readonly kind: "upsertMessage"
    readonly value: MessageProjection
  }
