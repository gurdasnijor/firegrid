import { EventStream } from "@firegrid/client/firegrid"
import { Schema } from "effect"

// firegrid-event-streams.CLIENT_API.4
// runtime-lab-inspector.NO_PRIVILEGED_LAB.2
//
// Lab-local caller-owned EventStream descriptor. The lab supplies this
// descriptor at the typed client call site; it is not a substrate row
// family, runtime handler, or global registry entry.
export const LabEvents = EventStream.define({
  name: "firegrid.lab.events",
  event: Schema.Struct({
    id: Schema.String,
    message: Schema.String,
    count: Schema.Number,
    createdAt: Schema.String,
  }),
})

export type LabEvent = EventStream.Event<typeof LabEvents>

export const makeLabEvent = (input: {
  readonly message: string
  readonly count: number
}): LabEvent => ({
  id: globalThis.crypto.randomUUID(),
  message: input.message,
  count: input.count,
  createdAt: new Date().toISOString(),
})
