import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  ProjectionMatchTriggerSchema,
  type ProjectionMatchTriggerValue,
} from "../../protocol/schema/rows.ts"

// choreography-facade.TRIGGERS.1
// choreography-facade.TRIGGERS.2
// choreography-facade.TRIGGERS.3
// choreography-facade.TRIGGERS.4
// v1 supports projection-match triggers only. The trigger payload is
// described with Effect Schema so runtime APIs and tool bindings share a
// single decoder; the value carries serializable fields (label,
// projectionKey, matcherId) and explicitly does NOT embed JavaScript
// predicate functions or raw projection objects.
export const ProjectionMatchTrigger = ProjectionMatchTriggerSchema
export type ProjectionMatchTrigger = ProjectionMatchTriggerValue

// choreography-facade.TRIGGERS.7
// RunWaitTrigger is the union of supported trigger variants. v1 has a
// single variant; adding a future variant widens this type and forces
// explicit handling in `dispatchTrigger` (TS will require the new case).
export const RunWaitTrigger = Schema.Union(ProjectionMatchTrigger)
export type RunWaitTrigger = Schema.Schema.Type<typeof RunWaitTrigger>

// choreography-facade.TRIGGERS.5
// Matchers are arbitrary Effect programs supplied by the host runtime.
// Their R-channel dependencies (plane projections, etc.) must be erased by
// the host before registration so the lookup result has no remaining
// requirements at the facade boundary.
export type TriggerMatchEvaluation =
  | { readonly kind: "match"; readonly value: unknown }
  | { readonly kind: "no-match" }

export type TriggerMatcher = (
  trigger: ProjectionMatchTrigger,
) => Effect.Effect<TriggerMatchEvaluation, unknown>

// choreography-facade.TRIGGERS.8
// Looking up an unknown matcherId is an explicit runtime configuration
// error, never a silent no-op.
export class MissingTriggerMatcherError extends Data.TaggedError(
  "substrate/MissingTriggerMatcherError",
)<{
  readonly matcherId: string
}> {}

export interface TriggerMatchersService {
  readonly lookup: (
    matcherId: string,
  ) => Effect.Effect<TriggerMatcher, MissingTriggerMatcherError>
}

// choreography-facade.TRIGGERS.5
// choreography-facade.TRIGGERS.6
// Matchers are addressed by Layer/provide composition; the substrate does
// not maintain a global mutable matcher registry.
export class TriggerMatchers extends Context.Tag(
  "substrate/TriggerMatchers",
)<TriggerMatchers, TriggerMatchersService>() {}

export const triggerMatchersLayer = (
  matchers: Readonly<Record<string, TriggerMatcher>>,
): Layer.Layer<TriggerMatchers> =>
  Layer.succeed(TriggerMatchers, {
    lookup: (matcherId) => {
      const m = matchers[matcherId]
      if (m === undefined) {
        return Effect.fail(new MissingTriggerMatcherError({ matcherId }))
      }
      return Effect.succeed(m)
    },
  })

// choreography-facade.TRIGGERS.7
// Exhaustive dispatch helper over the trigger union. Adding a new variant
// expands `RunWaitTrigger`'s `_tag` and forces a new case here at
// compile time.
export const dispatchTrigger = <A>(
  trigger: RunWaitTrigger,
  cases: { readonly ProjectionMatch: (t: ProjectionMatchTrigger) => A },
): A => {
  switch (trigger._tag) {
    case "ProjectionMatch":
      return cases.ProjectionMatch(trigger)
  }
}
