export * from "./rows.js"
export * from "./state-schema.js"
export * from "./projection.js"
export * from "./stream.js"
export * from "./state-machine.js"
export * from "./producer.js"
export * from "./ready-work.js"
export * from "./operator.js"
export * from "./retained-records.js"
export * from "./waits.js"
export * from "./subscribers.js"
// ergonomic-facade — Phase 10 ergonomic Effect-native facade.
export * from "./facade/index.js"
// client-event-plane-registration — Phase 11 client event planes / state producers.
export * from "./event-plane/index.js"
// choreography-facade — Phase 12 choreography facade (foundation slice).
//
// `ProjectionMatchTrigger` collides with the Phase-7 placeholder interface
// in `./waits.js`. The two have different shapes (the placeholder is the
// loose data field stored on `durable.completion` rows; the choreography
// schema is the typed Effect Schema for runtime/tool input). Keep the
// placeholder as the root `ProjectionMatchTrigger` to avoid silently
// changing root meaning, and re-export the choreography schema under the
// distinct root name `ChoreographyProjectionMatchTrigger`. Subpath consumers
// can still import `ProjectionMatchTrigger` directly from
// `./choreography/index.js`.
export {
  Choreography,
  ChoreographyLive,
  ChoreographyTimeout,
  ChoreographyTrigger,
  CompletionId,
  CurrentWorkContext,
  MissingTriggerMatcherError,
  OwnerId,
  ProjectionMatchTrigger as ChoreographyProjectionMatchTrigger,
  TriggerMatchers,
  WorkId,
  currentWorkContextLayer,
  dispatchTrigger,
  triggerMatchersLayer,
  type ChoreographyLiveConfig,
  type ChoreographyOperation,
  type ChoreographyService,
  type ChoreographySuspension,
  type CurrentWorkContextValue,
  type ScheduleAtResult,
  type TriggerMatchEvaluation,
  type TriggerMatcher,
  type TriggerMatchersService,
} from "./choreography/index.js"
