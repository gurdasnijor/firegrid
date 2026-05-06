import { createStateSchema } from "@durable-streams/state"
import { Operation } from "@firegrid/substrate/descriptors"
import { EventPlane } from "@firegrid/substrate/event-plane"
import { Schema } from "effect"
import { defineEmitScenario } from "../definition.ts"
import {
  defineScenarioRows,
  makeOperationStartedRunRow,
  scenarioRowsFromIterable,
} from "../scenario.ts"

const ToolInvocationArguments = Schema.Record({
  key: Schema.String,
  value: Schema.String,
})
type ToolInvocationArguments =
  Schema.Schema.Type<typeof ToolInvocationArguments>

export const ToolInvocationRequest = Schema.Struct({
  invocationId: Schema.String,
  promptId: Schema.String,
  toolName: Schema.String,
  arguments: ToolInvocationArguments,
  state: Schema.Literal("requested"),
})
export type ToolInvocationRequest =
  Schema.Schema.Type<typeof ToolInvocationRequest>

export const ToolInvocationResult = Schema.Struct({
  invocationId: Schema.String,
  promptId: Schema.String,
  toolName: Schema.String,
  status: Schema.Literal("succeeded"),
  output: Schema.String,
})
export type ToolInvocationResult =
  Schema.Schema.Type<typeof ToolInvocationResult>

const FirepixelToolInvocationState = createStateSchema({
  toolRequests: {
    type: "firepixel.tool_invocation.request",
    primaryKey: "invocationId",
    schema: Schema.standardSchemaV1(ToolInvocationRequest),
  },
  toolResults: {
    type: "firepixel.tool_invocation.result",
    primaryKey: "invocationId",
    schema: Schema.standardSchemaV1(ToolInvocationResult),
  },
})

// client-event-plane-registration.FIREPIXEL_PROFILE.4
// The plane name and row vocabulary are scenario/app-owned. Firegrid does
// not interpret tool names, transports, credentials, or adapter protocols.
export const FirepixelToolInvocationPlane = EventPlane.define({
  name: "scenario.firepixel.tool-invocation",
  state: FirepixelToolInvocationState,
})

export const FirepixelToolInvocationOperation = Operation.define({
  name: "FirepixelToolInvocation",
  input: Schema.Struct({
    invocationId: Schema.String,
    promptId: Schema.String,
    toolName: Schema.String,
    arguments: ToolInvocationArguments,
  }),
  output: ToolInvocationResult,
})

const DEFAULT_FIREPIXEL_TOOL_RUN_ID =
  "run-firepixel-tool-invocation-cli-1"
const DEFAULT_FIREPIXEL_TOOL_INVOCATION_ID =
  "tool-invocation-cli-1"
const DEFAULT_FIREPIXEL_TOOL_PROMPT_ID = "prompt-firepixel-cli-1"
const DEFAULT_FIREPIXEL_TOOL_NAME = "scenario.lookup"

export const makeFirepixelToolInvocationScenarioRows = (input: {
  readonly runId?: string
  readonly invocationId?: string
  readonly promptId?: string
  readonly toolName?: string
  readonly arguments?: ToolInvocationArguments
} = {}) => {
  const runId = input.runId ?? DEFAULT_FIREPIXEL_TOOL_RUN_ID
  const invocationId =
    input.invocationId ?? DEFAULT_FIREPIXEL_TOOL_INVOCATION_ID
  const promptId = input.promptId ?? DEFAULT_FIREPIXEL_TOOL_PROMPT_ID
  const toolName = input.toolName ?? DEFAULT_FIREPIXEL_TOOL_NAME
  const args = input.arguments ?? { query: "firepixel scenario" }

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.10
  // firegrid-runtime-process.SCENARIOS.21
  // client-event-plane-registration.FIREPIXEL_PROFILE.4
  return [
    makeOperationStartedRunRow({
      runId,
      operation: FirepixelToolInvocationOperation,
      input: {
        invocationId,
        promptId,
        toolName,
        arguments: args,
      },
    }),
  ] as const
}

const firepixelToolInvocationRows = defineScenarioRows({
  name: "firepixel-tool-invocation",
  rows: () =>
    scenarioRowsFromIterable(makeFirepixelToolInvocationScenarioRows()),
})

export const firepixelToolInvocationScenario = defineEmitScenario({
  kind: "emit",
  name: "firepixel-tool-invocation",
  rows: firepixelToolInvocationRows,
})
