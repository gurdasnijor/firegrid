// Event-channel composition helpers (bidirectional row-stream channels
// over a durable collection). Relocated from the deleted host-sdk path
// `host-sdk/src/host/event-channel.ts` (Class D channel-Lives
// relocation; per dispatch: `event-channel.ts -> runtime/channels/`
// since it uses `effect-durable-operators` projection types).

import type { ProjectionStream } from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"
import { Stream, type Effect, type Schema } from "effect"
import {
  makeBidirectionalChannel,
  type ChannelTarget,
  EventChannelSourceClasses,
  eventChannelTarget,
  type EventChannel,
  type ChannelSourceClass,
} from "@firegrid/protocol/channels"

interface EventChannelBaseOptions<S extends Schema.Schema.Any> {
  readonly name: string
  readonly target?: ChannelTarget | string
  readonly schema: S
  readonly callerFactStream: string
  readonly sourceClasses?: ReadonlyArray<ChannelSourceClass>
}

interface EventChannelOptions<S extends Schema.Schema.Any>
  extends EventChannelBaseOptions<S> {
  readonly rows: () => ProjectionStream<Schema.Schema.Type<S> & object, DurableTableError>
  readonly append: (
    payload: Schema.Schema.Type<S>,
  ) => Effect.Effect<void, unknown, never>
}

const rowMatchesEventName = (row: object, name: string): boolean =>
  Object.hasOwn(row, "name")
  && (row as { readonly name?: unknown }).name === name

export const eventChannel = <S extends Schema.Schema.Any>(
  options: EventChannelOptions<S>,
): EventChannel<S> => {
  const channel = makeBidirectionalChannel({
    target: options.target ?? eventChannelTarget(options.name),
    schema: options.schema,
    sourceClasses: options.sourceClasses ?? EventChannelSourceClasses,
    // firegrid-agent-body-plan.EVENT_CHANNEL.5
    stream: options.rows().pipe(
      Stream.filter(row => rowMatchesEventName(row, options.name)),
    ),
    append: options.append,
  })
  return {
    ...channel,
    kind: "event",
    eventName: options.name,
    callerFactStream: options.callerFactStream,
  }
}
