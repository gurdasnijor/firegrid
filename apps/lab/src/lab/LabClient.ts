import type { Effect, Stream } from "effect"
import {
  createLabEventStreamClient,
  type LabEventStreamClient,
} from "./LabEventStreamClient.ts"
import type { LabEvent } from "./lab-events.ts"

interface LabClientConfig {
  readonly streamUrl: string
}

interface LabClient {
  readonly typedEvents: {
    readonly emit: (event: LabEvent) => Effect.Effect<void, unknown>
    readonly events: () => Stream.Stream<LabEvent, unknown>
  }
}

const fromEventStreamClient = (
  eventStream: LabEventStreamClient,
): LabClient => ({
  typedEvents: {
    emit: eventStream.emit,
    events: eventStream.events,
  },
})

// firegrid-client-api.LAB_COMPATIBILITY.1
// firegrid-client-api.LAB_COMPATIBILITY.3
// firegrid-client-api.LAB_COMPATIBILITY.4
// runtime-lab-inspector.WRITE_BOUNDARY.1
// runtime-lab-inspector.NO_PRIVILEGED_LAB.2
//
// App-local seam between React UI code and the current production
// Firegrid client adapter. C2 can swap the implementation behind
// this boundary without exposing raw writers, runtime registration,
// substrate kernel authority, claims, or terminalization to lab UI
// components.
export const createLabClient = (cfg: LabClientConfig): LabClient =>
  fromEventStreamClient(createLabEventStreamClient(cfg))
