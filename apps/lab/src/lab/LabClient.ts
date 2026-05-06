/* eslint-disable @effect/no-import-from-barrel-package -- firegrid-client-api.LAB_COMPATIBILITY.1: the lab seam intentionally consumes the production @firegrid/client root. */
import { FiregridClient, FiregridClientLive } from "@firegrid/client"
/* eslint-enable @effect/no-import-from-barrel-package */
import { Effect, Stream } from "effect"
import type { LabEvent } from "./lab-events.ts"
import { LabEvents } from "./lab-events.ts"

interface LabClientConfig {
  readonly streamUrl: string
}

interface LabClient {
  readonly typedEvents: {
    readonly emit: (event: LabEvent) => Effect.Effect<void, unknown>
    readonly events: () => Stream.Stream<LabEvent, unknown>
  }
}

const layerFor = (cfg: LabClientConfig) =>
  FiregridClientLive({
    streamUrl: cfg.streamUrl,
    clientId: "firegrid-lab",
  })

const emitLabEvent = (
  cfg: LabClientConfig,
  event: LabEvent,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const client = yield* FiregridClient
    yield* client.emit(LabEvents, event)
  }).pipe(Effect.provide(layerFor(cfg)))

const labEvents = (
  cfg: LabClientConfig,
): Stream.Stream<LabEvent, unknown> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* FiregridClient
      return client.events(LabEvents)
    }).pipe(Effect.provide(layerFor(cfg))),
  )

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
export const createLabClient = (cfg: LabClientConfig): LabClient => ({
  typedEvents: {
    emit: (event) => emitLabEvent(cfg, event),
    events: () => labEvents(cfg),
  },
})
