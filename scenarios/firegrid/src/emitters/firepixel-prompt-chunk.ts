import { createStateSchema } from "@durable-streams/state"
import {
  Operation,
  ProjectionMatchTrigger,
} from "@firegrid/substrate"
import { EventPlane } from "@firegrid/substrate/event-plane"
import { Schema } from "effect"
import { defineEmitScenario } from "../definition.ts"
import {
  defineScenarioRows,
  makeOperationStartedRunRow,
  scenarioRowsFromIterable,
} from "../scenario.ts"

export const FirepixelPromptChunk = Schema.Struct({
  chunkId: Schema.String,
  promptId: Schema.String,
  text: Schema.String,
  sequence: Schema.Number,
})
export type FirepixelPromptChunk = Schema.Schema.Type<
  typeof FirepixelPromptChunk
>

export const FirepixelPermissionRequest = Schema.Struct({
  permissionId: Schema.String,
  promptId: Schema.String,
  reason: Schema.String,
  state: Schema.Literal("requested"),
})
export type FirepixelPermissionRequest = Schema.Schema.Type<
  typeof FirepixelPermissionRequest
>

export const FirepixelPermissionDecision = Schema.Struct({
  permissionId: Schema.String,
  promptId: Schema.String,
  decision: Schema.Literal("allowed", "denied"),
  reviewer: Schema.String,
})
export type FirepixelPermissionDecision = Schema.Schema.Type<
  typeof FirepixelPermissionDecision
>

const FirepixelState = createStateSchema({
  promptChunks: {
    type: "firepixel.prompt.chunk",
    primaryKey: "chunkId",
    schema: Schema.standardSchemaV1(FirepixelPromptChunk),
  },
  permissionRequests: {
    type: "firepixel.permission.request",
    primaryKey: "permissionId",
    schema: Schema.standardSchemaV1(FirepixelPermissionRequest),
  },
  permissionDecisions: {
    type: "firepixel.permission.decision",
    primaryKey: "permissionId",
    schema: Schema.standardSchemaV1(FirepixelPermissionDecision),
  },
})

export const FirepixelPlane = EventPlane.define({
  name: "scenario.firepixel",
  state: FirepixelState,
})

export const FirepixelPromptOperation = Operation.define({
  name: "FirepixelPromptChunk",
  input: Schema.Struct({
    promptId: Schema.String,
    chunkId: Schema.String,
    permissionId: Schema.String,
    permissionTrigger: ProjectionMatchTrigger,
    text: Schema.String,
    sequence: Schema.Number,
  }),
  output: Schema.Struct({
    promptId: Schema.String,
    chunkId: Schema.String,
    permissionId: Schema.String,
    decision: Schema.Literal("allowed", "denied"),
    emitted: Schema.Boolean,
  }),
})

const DEFAULT_FIREPIXEL_PROMPT_RUN_ID =
  "run-firepixel-prompt-chunk-cli-1"
const DEFAULT_FIREPIXEL_PROMPT_ID = "prompt-firepixel-cli-1"
const DEFAULT_FIREPIXEL_CHUNK_ID = "chunk-firepixel-cli-1"
const DEFAULT_FIREPIXEL_PERMISSION_ID = "permission-firepixel-cli-1"
const DEFAULT_FIREPIXEL_PROMPT_TEXT = "hello from firepixel"
const DEFAULT_FIREPIXEL_PROMPT_SEQUENCE = 1
const DEFAULT_FIREPIXEL_REVIEWER = "scenario-reviewer"

const permissionProjectionKey = (permissionId: string) =>
  `${FirepixelPlane.name}:permission:${permissionId}`

const firepixelPermissionTrigger = (permissionId: string) =>
  Schema.encodeSync(ProjectionMatchTrigger)({
    _tag: "ProjectionMatch",
    label: `firepixel-permission:${permissionId}`,
    projectionKey: permissionProjectionKey(permissionId),
    matcherId: "scenario.firepixel.permission.allowed",
  })

export const makeFirepixelPromptChunkScenarioRows = (input: {
  readonly runId?: string
  readonly promptId?: string
  readonly chunkId?: string
  readonly permissionId?: string
  readonly text?: string
  readonly sequence?: number
} = {}) => {
  const runId = input.runId ?? DEFAULT_FIREPIXEL_PROMPT_RUN_ID
  const promptId = input.promptId ?? DEFAULT_FIREPIXEL_PROMPT_ID
  const chunkId = input.chunkId ?? DEFAULT_FIREPIXEL_CHUNK_ID
  const permissionId = input.permissionId ?? DEFAULT_FIREPIXEL_PERMISSION_ID
  const text = input.text ?? DEFAULT_FIREPIXEL_PROMPT_TEXT
  const sequence = input.sequence ?? DEFAULT_FIREPIXEL_PROMPT_SEQUENCE

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.10
  // firegrid-runtime-process.SCENARIOS.20
  // client-event-plane-registration.FIREPIXEL_PROFILE.1
  return [
    makeOperationStartedRunRow({
      runId,
      operation: FirepixelPromptOperation,
      input: {
        promptId,
        chunkId,
        permissionId,
        permissionTrigger: firepixelPermissionTrigger(permissionId),
        text,
        sequence,
      },
    }),
  ] as const
}

export const makeFirepixelPromptChunkDecisionRows = (input: {
  readonly permissionId?: string
  readonly promptId?: string
  readonly decision?: "allowed" | "denied"
  readonly reviewer?: string
} = {}) => {
  const permissionId = input.permissionId ?? DEFAULT_FIREPIXEL_PERMISSION_ID
  const promptId = input.promptId ?? DEFAULT_FIREPIXEL_PROMPT_ID
  const decision = input.decision ?? "allowed"
  const reviewer = input.reviewer ?? DEFAULT_FIREPIXEL_REVIEWER

  return [
    FirepixelPlane.state.permissionDecisions.insert({
      value: {
        permissionId,
        promptId,
        decision,
        reviewer,
      },
    }),
  ] as const
}

const firepixelPromptChunkRows = defineScenarioRows({
  name: "firepixel-prompt-chunk",
  rows: () =>
    scenarioRowsFromIterable(makeFirepixelPromptChunkScenarioRows()),
})

export const firepixelPromptChunkScenario = defineEmitScenario({
  kind: "emit",
  name: "firepixel-prompt-chunk",
  rows: firepixelPromptChunkRows,
})
