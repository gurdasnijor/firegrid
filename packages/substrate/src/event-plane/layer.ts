import type { StreamStateDefinition } from "@durable-streams/state"
import { type Context, Effect, Layer } from "effect"
import { collectionsByType, type EventPlaneDefinition } from "./define.ts"
import { makePlaneProducer } from "./producer.ts"
import {
  acquirePlaneDb,
  buildPlaneProjectionFromDb,
  type PlaneProjectionReadError,
} from "./projection.ts"

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
  const baseConfig = {
    planeName: plane.name,
    streamUrl: cfg.streamUrl,
    ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
  }
  const producerLayer = Layer.succeed(
    plane.Producer,
    makePlaneProducer({
      ...baseConfig,
      collectionsByType: collectionsByType(plane.state),
    }),
  )
  const projectionLayer = Layer.scoped(
    plane.Projection,
    Effect.map(
      acquirePlaneDb({
        ...baseConfig,
        state: plane.state,
      }),
      (db) =>
        buildPlaneProjectionFromDb(
          {
            ...baseConfig,
            state: plane.state,
          },
          db,
        ),
    ),
  )
  return Layer.merge(producerLayer, projectionLayer)
}
