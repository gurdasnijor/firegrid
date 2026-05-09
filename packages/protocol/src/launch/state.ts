import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"
import {
  RuntimeContextSchema,
  RuntimeRunEventSchema,
} from "./schema.ts"

export const runtimeContextStateSchema = createStateSchema({
  contexts: {
    type: "firegrid.runtime.context",
    primaryKey: "contextId",
    schema: Schema.standardSchemaV1(RuntimeContextSchema),
  },
  runs: {
    type: "firegrid.runtime.run_event",
    primaryKey: "runEventId",
    schema: Schema.standardSchemaV1(RuntimeRunEventSchema),
  },
})
