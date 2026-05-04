import type { StreamStateDefinition } from "@durable-streams/state"
import { Context, Effect, Layer } from "effect"
import { collectionsByType, type EventPlaneDefinition } from "./define.js"
import { makePlaneProducer } from "./producer.js"
import {
  acquirePlaneDb,
  buildPlaneProjectionFromDb,
  PlaneProjectionReadError,
} from "./projection.js"

// client-event-plane-registration.EVENT_PLANE_DEFINITION.3
// Wires the plane's Producer + Projection through one scoped Layer.
// One DurableStream per plane layer; one preloaded StreamDB per plane
// layer (closed on layer finalization). No polling: PlaneProjection
// uses subscribeChanges with includeInitialState on the first
// collection.
export interface EventPlaneLayerConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

export const layer = <Name extends string, S extends StreamStateDefinition>(
  plane: EventPlaneDefinition<Name, S>,
  cfg: EventPlaneLayerConfig,
): Layer.Layer<
  Context.Tag.Identifier<typeof plane.Producer> | Context.Tag.Identifier<typeof plane.Projection>,
  PlaneProjectionReadError
> => {
  const producerLayer = Layer.succeed(
    plane.Producer,
    makePlaneProducer({
      planeName: plane.name,
      streamUrl: cfg.streamUrl,
      ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
      collectionsByType: collectionsByType(plane.state),
    }),
  )
  const projectionLayer = Layer.scoped(
    plane.Projection,
    Effect.map(
      acquirePlaneDb({
        planeName: plane.name,
        streamUrl: cfg.streamUrl,
        ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
        state: plane.state,
      }),
      (db) =>
        buildPlaneProjectionFromDb(
          {
            planeName: plane.name,
            streamUrl: cfg.streamUrl,
            ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
            state: plane.state,
          },
          db,
        ),
    ),
  )
  return Layer.merge(producerLayer, projectionLayer) as Layer.Layer<
    Context.Tag.Identifier<typeof plane.Producer> | Context.Tag.Identifier<typeof plane.Projection>,
    PlaneProjectionReadError
  >
}
