import type { Schema } from "effect"
import type {
  BidirectionalChannel,
  ChannelSourceClass,
  ChannelTarget,
} from "./core.ts"
import { makeChannelTarget } from "./core.ts"

export const EventChannelSourceClasses = [
  "static-source",
  "predicate-eligible",
] as const satisfies ReadonlyArray<ChannelSourceClass>

export type EventChannel<S extends Schema.Schema.Any> = BidirectionalChannel<S> & {
  readonly kind: "event"
  readonly eventName: string
  readonly callerFactStream: string
}

export const eventChannelTarget = (name: string): ChannelTarget =>
  makeChannelTarget(`event.${name}`)
