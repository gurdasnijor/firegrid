import type {
  DurableTableCollectionFacade,
  ProjectionStream,
} from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"
import type { Schema } from "effect"
import {
  makeAfferentChannel,
  type AfferentChannel,
  type ChannelTarget,
} from "./channel-registry.ts"

export type StateChangesChannel<S extends Schema.Schema.Any> = AfferentChannel<S> & {
  readonly kind: "state.changes"
  readonly sourceClass: "static-source"
}

export const stateChangesChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly rows: () => ProjectionStream<Schema.Schema.Type<S> & object, DurableTableError>
  },
): StateChangesChannel<S> => {
  const channel = makeAfferentChannel({
    target: options.target,
    schema: options.schema,
    // firegrid-agent-body-plan.STATE_CHANGES.4
    stream: options.rows(),
  })
  return {
    ...channel,
    kind: "state.changes",
    sourceClass: "static-source",
  }
}

export const stateChangesChannelFromCollection = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly collection: Pick<
      DurableTableCollectionFacade<Schema.Schema.Type<S> & object, unknown>,
      "rows"
    >
  },
): StateChangesChannel<S> =>
  stateChangesChannel({
    target: options.target,
    schema: options.schema,
    rows: options.collection.rows,
  })
