import { Context } from "effect"
import type { Schema } from "effect"
import type { IngressChannel } from "./core.ts"

export type StateChangesChannel<S extends Schema.Schema.Any> = IngressChannel<S> & {
  readonly kind: "state.changes"
  readonly sourceClass: "static-source"
}

export class StateRowsChannel extends Context.Tag(
  "firegrid/protocol/channels/state.rows",
)<StateRowsChannel, StateChangesChannel<Schema.Schema.Any>>() {}
