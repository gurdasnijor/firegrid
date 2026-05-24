// State-changes ingress channel composition helpers. Relocated from the
// deleted host-sdk path `host-sdk/src/host/state-changes-channel.ts`
// (Class D channel-Lives relocation; per dispatch:
// `state-changes-channel.ts -> runtime/channels/state-changes/live.ts`).
// Uses `effect-durable-operators` projection types so canonical home is
// runtime/channels (not protocol).

import type {
  DurableTableCollectionFacade,
  ProjectionStream,
} from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"
import type { Schema } from "effect"
import {
  makeIngressChannel,
  type ChannelTarget,
  type StateChangesChannel,
} from "@firegrid/protocol/channels"

export const stateChangesChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly rows: () => ProjectionStream<Schema.Schema.Type<S> & object, DurableTableError>
  },
): StateChangesChannel<S> => {
  const channel = makeIngressChannel({
    target: options.target,
    schema: options.schema,
    sourceClass: "static-source",
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
