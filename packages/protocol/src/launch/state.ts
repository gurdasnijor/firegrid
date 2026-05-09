import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"
import {
  DiagnosticRowSchema,
  ProviderWireRowSchema,
  RuntimeLaunchRequestSchema,
  RuntimeProcessEventSchema,
} from "./schema.ts"

export const runtimeLaunchStateSchema = createStateSchema({
  launchRequests: {
    type: "firegrid.launch.request",
    primaryKey: "launchId",
    schema: Schema.standardSchemaV1(RuntimeLaunchRequestSchema),
  },
  processEvents: {
    type: "firegrid.launch.process_event",
    primaryKey: "processEventId",
    schema: Schema.standardSchemaV1(RuntimeProcessEventSchema),
  },
  providerWire: {
    type: "firegrid.launch.provider_wire",
    primaryKey: "providerWireRowId",
    schema: Schema.standardSchemaV1(ProviderWireRowSchema),
  },
  diagnostics: {
    type: "firegrid.launch.diagnostic",
    primaryKey: "diagnosticRowId",
    schema: Schema.standardSchemaV1(DiagnosticRowSchema),
  },
})
