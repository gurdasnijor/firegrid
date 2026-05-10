import {
  RuntimeContextSchema,
  RuntimeRunEventSchema,
} from "./schema.ts"

export const runtimeContextStateDescriptor = {
  contexts: {
    type: "firegrid.runtime.context",
    primaryKey: "contextId",
    schema: RuntimeContextSchema,
  },
  runs: {
    type: "firegrid.runtime.run_event",
    primaryKey: "runEventId",
    schema: RuntimeRunEventSchema,
  },
} as const
