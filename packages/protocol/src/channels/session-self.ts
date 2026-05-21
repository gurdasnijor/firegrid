import { Context, Schema } from "effect"
import { RuntimeRunEventSchema } from "../launch/schema.ts"
import {
  makeChannelTarget,
  type ChannelTarget,
  type IngressChannel,
} from "./core.ts"

export const SessionSelfLifecycleChannelTarget: ChannelTarget =
  makeChannelTarget("session.self.lifecycle")
export const SessionSelfCheckpointChannelTarget: ChannelTarget =
  makeChannelTarget("session.self.checkpoint")

export const SessionSelfLifecycleEventSchema = Schema.Struct({
  channel: Schema.Literal("session.self.lifecycle"),
  event: RuntimeRunEventSchema,
})
export type SessionSelfLifecycleEvent = Schema.Schema.Type<
  typeof SessionSelfLifecycleEventSchema
>

const SessionSelfCheckpointBaseSchema = {
  channel: Schema.Literal("session.self.checkpoint"),
  contextId: Schema.String,
  workflowName: Schema.String,
  executionId: Schema.String,
} as const

export const SessionSelfCheckpointEventSchema = Schema.Union(
  Schema.TaggedStruct("Execution", {
    ...SessionSelfCheckpointBaseSchema,
    suspended: Schema.Boolean,
    interrupted: Schema.Boolean,
    hasFinalResult: Schema.Boolean,
    hasCause: Schema.Boolean,
  }),
  Schema.TaggedStruct("Activity", {
    ...SessionSelfCheckpointBaseSchema,
    activityName: Schema.String,
    attempt: Schema.Number,
    hasResult: Schema.Boolean,
  }),
  Schema.TaggedStruct("Deferred", {
    ...SessionSelfCheckpointBaseSchema,
    deferredName: Schema.String,
    hasExit: Schema.Boolean,
  }),
  Schema.TaggedStruct("ClockWakeup", {
    ...SessionSelfCheckpointBaseSchema,
    clockName: Schema.String,
    deferredName: Schema.String,
    deadlineMs: Schema.Number,
    status: Schema.Literal("pending", "fired"),
  }),
)
export type SessionSelfCheckpointEvent = Schema.Schema.Type<
  typeof SessionSelfCheckpointEventSchema
>

export class SessionSelfLifecycleChannel extends Context.Tag(
  "firegrid/protocol/channels/session.self.lifecycle",
)<
  SessionSelfLifecycleChannel,
  IngressChannel<typeof SessionSelfLifecycleEventSchema>
>() {}

export class SessionSelfCheckpointChannel extends Context.Tag(
  "firegrid/protocol/channels/session.self.checkpoint",
)<
  SessionSelfCheckpointChannel,
  IngressChannel<typeof SessionSelfCheckpointEventSchema>
>() {}
