import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"
import {
  RuntimeLaunchRequestSchema,
  RuntimeProcessEventSchema,
} from "./schema.ts"

export const runtimeLaunchStateSchema = createStateSchema({
  launchRequests: {
    type: "firegrid.launch.request",
    primaryKey: "launchId",
    schema: Schema.standardSchemaV1(RuntimeLaunchRequestSchema),
  },
  runtimeProcesses: {
    type: "firegrid.launch.runtime_process",
    primaryKey: "processEventId",
    schema: Schema.standardSchemaV1(RuntimeProcessEventSchema),
  },
})
