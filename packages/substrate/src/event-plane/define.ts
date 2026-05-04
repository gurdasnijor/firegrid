import type {
  CollectionDefinition,
  StateSchema,
  StreamStateDefinition,
} from "@durable-streams/state"
import { Context } from "effect"
import type { PlaneProducer } from "./producer.js"
import type { PlaneProjection } from "./projection.js"

// client-event-plane-registration.EVENT_PLANE_DEFINITION.1, .2, .3, .4
// A typed value containing a stable plane name plus the caller-supplied
// `createStateSchema(...)` result (Effect Schema rows + DSS-compatible
// Standard Schema). Substrate does NOT wrap or re-export
// createStateSchema (BOUNDARY.1) and does NOT introduce a global plane
// registry (EVENT_PLANE_DEFINITION.3) — the returned `Producer` and
// `Projection` Context.Tags are addressed by Layer/provide composition.
//
// Tag keys are derived from the plane name so two `define` calls for
// the same name produce equivalent (interchangeable) Tags — that is
// deterministic Tag identity, not a hidden mutable registry.
export interface EventPlaneDefinition<
  Name extends string,
  S extends StreamStateDefinition,
> {
  readonly name: Name
  readonly state: StateSchema<S>
  readonly Producer: Context.Tag<
    `event-plane/${Name}/Producer`,
    PlaneProducer
  >
  readonly Projection: Context.Tag<
    `event-plane/${Name}/Projection`,
    PlaneProjection<S>
  >
}

// Internal: type-narrow the collection type set so PlaneProducer / emit
// can route a typed event back to the schema for re-validation
// (PRODUCER_API.3, see §5.8 of phase-11 design).
export const collectionsByType = <S extends StreamStateDefinition>(
  state: StateSchema<S>,
): ReadonlyMap<string, CollectionDefinition> => {
  const byType = new Map<string, CollectionDefinition>()
  for (const key of Object.keys(state) as Array<keyof S>) {
    const def = state[key] as unknown as CollectionDefinition
    byType.set(def.type, def)
  }
  return byType
}

export const define = <
  Name extends string,
  S extends StreamStateDefinition,
>(spec: {
  readonly name: Name
  readonly state: StateSchema<S>
}): EventPlaneDefinition<Name, S> => {
  const Producer = Context.GenericTag<
    `event-plane/${Name}/Producer`,
    PlaneProducer
  >(`event-plane/${spec.name}/Producer`)
  const Projection = Context.GenericTag<
    `event-plane/${Name}/Projection`,
    PlaneProjection<S>
  >(`event-plane/${spec.name}/Projection`)
  return {
    name: spec.name,
    state: spec.state,
    Producer,
    Projection,
  }
}
