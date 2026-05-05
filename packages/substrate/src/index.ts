export * from "./rows.ts"
export * from "./state-schema.ts"
export * from "./projection.ts"
export * from "./stream.ts"
export * from "./state-machine.ts"
export * from "./producer.ts"
export * from "./ready-work.ts"
export * from "./operator.ts"
export * from "./retained-records.ts"
export * from "./waits.ts"
export * from "./subscribers.ts"
// ergonomic-facade — Phase 10 ergonomic Effect-native facade.
export * from "./facade/index.ts"
// client-event-plane-registration — Phase 11 client event planes / state producers.
export * from "./event-plane/index.ts"
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
  AwakeableToolInput,
  Choreography,
  ChoreographyLive,
  ChoreographyTimeout,
  ChoreographyTools,
  ChoreographyTrigger,
  CompletionId,
  CurrentWorkContext,
  MissingTriggerMatcherError,
  OwnerId,
  ProjectionMatchTrigger as ChoreographyProjectionMatchTrigger,
  ScheduleMeToolInput,
  SleepToolInput,
  TriggerMatchers,
  WaitForToolInput,
  WorkId,
  currentWorkContextLayer,
  dispatchTrigger,
  triggerMatchersLayer,
  type ChoreographyLiveConfig,
  type ChoreographyOperation,
  type ChoreographyService,
  type ChoreographySuspension,
  type ChoreographyToolBinding,
  type ChoreographyToolBindings,
  type ChoreographyToolsConfig,
  type CurrentWorkContextValue,
  type ScheduleAtResult,
  type TriggerMatchEvaluation,
  type TriggerMatcher,
  type TriggerMatchersService,
} from "./choreography/index.ts"
