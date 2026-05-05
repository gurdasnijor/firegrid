import { Schema } from "effect"

// ready-work-projection.READY_WORK_PROJECTION.7
// Public projection-output contract; defined with Effect Schema per
// effect-native-api.SCHEMA_FIRST.1.
export const ReadyWorkItem = Schema.Struct({
  runId: Schema.String,
  completionId: Schema.String,
  result: Schema.Unknown,
})
export type ReadyWorkItem = Schema.Schema.Type<typeof ReadyWorkItem>

// ready-work-projection.READY_WORK_PROJECTION.1, .8, .10
export interface ReadyWorkProjection {
  readonly foldVersion: number
  readonly readyWork: ReadonlyMap<string, ReadyWorkItem>
}
