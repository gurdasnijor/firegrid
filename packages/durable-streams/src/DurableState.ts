import { createStateSchema, createStreamDB } from "@durable-streams/state"
import {
  runtimeContextStateDescriptor,
} from "@firegrid/protocol/launch"
import {
  sessionStateDescriptor,
} from "@firegrid/protocol/session"
import { Schema } from "effect"

export const createDurableStateDb = createStreamDB
export const createDurableStateSchema = createStateSchema

export const runtimeContextStateSchema = createStateSchema({
  contexts: {
    type: runtimeContextStateDescriptor.contexts.type,
    primaryKey: runtimeContextStateDescriptor.contexts.primaryKey,
    schema: Schema.standardSchemaV1(runtimeContextStateDescriptor.contexts.schema),
  },
  runs: {
    type: runtimeContextStateDescriptor.runs.type,
    primaryKey: runtimeContextStateDescriptor.runs.primaryKey,
    schema: Schema.standardSchemaV1(runtimeContextStateDescriptor.runs.schema),
  },
})

export const sessionStateSchema = createStateSchema({
  sessions: {
    type: sessionStateDescriptor.sessions.type,
    primaryKey: sessionStateDescriptor.sessions.primaryKey,
    schema: Schema.standardSchemaV1(sessionStateDescriptor.sessions.schema),
  },
  messages: {
    type: sessionStateDescriptor.messages.type,
    primaryKey: sessionStateDescriptor.messages.primaryKey,
    schema: Schema.standardSchemaV1(sessionStateDescriptor.messages.schema),
  },
})
