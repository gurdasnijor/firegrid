import {
  EventStreamClient,
  EventStreamClientLive,
  type EventsError,
  type EmitError,
} from "@firegrid/client/firegrid"
import { Effect, Stream } from "effect"
import { LabEvents, type LabEvent } from "./lab-events.ts"

// runtime-lab-inspector.WRITE_BOUNDARY.1
// runtime-lab-inspector.NO_PRIVILEGED_LAB.2
// launchable-substrate-host.LAB_INSPECTOR.1
// firegrid-event-streams.CLIENT_API.1
// firegrid-event-streams.CLIENT_API.2
// firegrid-event-streams.CLIENT_API.3
//
// Typed EventStream workbench helpers. The browser UI imports these
// helpers rather than raw DurableStream writers, so lab convenience
// controls exercise the same app-facing Firegrid client APIs an
// application would use.

interface LabEventStreamClientConfig {
  readonly streamUrl: string
}

const layerFor = (cfg: LabEventStreamClientConfig) =>
  EventStreamClientLive({
    streamUrl: cfg.streamUrl,
    clientId: "firegrid-lab",
  })

export const emitLabEvent = (
  cfg: LabEventStreamClientConfig,
  event: LabEvent,
): Effect.Effect<void, EmitError> =>
  Effect.gen(function* () {
    const client = yield* EventStreamClient
    yield* client.emit(LabEvents, event)
  }).pipe(Effect.provide(layerFor(cfg)))

export const labEvents = (
  cfg: LabEventStreamClientConfig,
): Stream.Stream<LabEvent, EventsError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* EventStreamClient
      return client.events(LabEvents)
    }).pipe(Effect.provide(layerFor(cfg))),
  )
