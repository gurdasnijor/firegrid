// client-event-plane-registration — public re-export.
// EVENT_PLANE_DEFINITION.3 — no global registry; consumers compose
// `define` with `layer` per their plane.
import { define, type EventPlaneDefinition } from "./define.ts"
import { layer, type EventPlaneLayerConfig } from "./layer.ts"

export const EventPlane = {
  define,
  layer,
} as const

export type { EventPlaneDefinition, EventPlaneLayerConfig }

export {
  PlaneProducerError,
  PlaneProducerUnknownTypeError,
  PlaneProducerValidationError,
  type PlaneProducer,
  type PlaneProducerErrors,
  type ProducerMetadata,
} from "./producer.ts"

export {
  PlaneProjectionReadError,
  PlaneProjectionWaitTimeout,
  type PlaneProjection,
  type PlaneProjectionQuery,
  type PlaneSnapshot,
  type RowAuthority,
} from "./projection.ts"
