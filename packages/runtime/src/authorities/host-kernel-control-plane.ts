import {
  RuntimeContextIntentSchema,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressRequestSchema,
} from "@firegrid/protocol/runtime-ingress"
import { Context, Schema } from "effect"
import type { Effect } from "effect"

export const HostKernelCreateLoadIntentSchema = Schema.TaggedStruct("CreateLoad", {
  requestId: Schema.String.pipe(Schema.minLength(1)),
  contextId: Schema.String.pipe(Schema.minLength(1)),
  runtime: RuntimeContextIntentSchema,
  createdBy: Schema.optional(Schema.String),
})

export const HostKernelStartIntentSchema = Schema.TaggedStruct("Start", {
  requestId: Schema.String.pipe(Schema.minLength(1)),
  contextId: Schema.String.pipe(Schema.minLength(1)),
})

export const HostKernelPromptIntentSchema = Schema.TaggedStruct("Prompt", {
  requestId: Schema.String.pipe(Schema.minLength(1)),
  contextId: Schema.String.pipe(Schema.minLength(1)),
  request: RuntimeIngressRequestSchema,
})

export const HostKernelCancelIntentSchema = Schema.TaggedStruct("Cancel", {
  requestId: Schema.String.pipe(Schema.minLength(1)),
  contextId: Schema.String.pipe(Schema.minLength(1)),
})

export const HostKernelIntentSchema = Schema.Union(
  HostKernelCreateLoadIntentSchema,
  HostKernelStartIntentSchema,
  HostKernelPromptIntentSchema,
  HostKernelCancelIntentSchema,
)
export type HostKernelIntent = Schema.Schema.Type<typeof HostKernelIntentSchema>

export const HostKernelIntentAckSchema = Schema.Struct({
  hostId: Schema.String,
  sequence: Schema.Number,
  requestId: Schema.String,
  accepted: Schema.Boolean,
})
export type HostKernelIntentAck = Schema.Schema.Type<typeof HostKernelIntentAckSchema>

export const HostKernelIntentDecisionSchema = Schema.Struct({
  hostId: Schema.String,
  sequence: Schema.Number,
  requestId: Schema.String,
  contextId: Schema.String,
  intent: Schema.Literal("CreateLoad", "Start", "Prompt", "Cancel"),
  status: Schema.Literal(
    "created_or_loaded",
    "started",
    "prompted",
    "cancelled",
    "failed",
  ),
  message: Schema.optional(Schema.String),
})
export type HostKernelIntentDecision = Schema.Schema.Type<
  typeof HostKernelIntentDecisionSchema
>

export interface HostKernelControlPlaneService {
  readonly signal: (
    hostId: string,
    intent: HostKernelIntent,
  ) => Effect.Effect<HostKernelIntentAck, unknown>
}

export class HostKernelControlPlane extends Context.Tag(
  "@firegrid/runtime/HostKernelControlPlane",
)<HostKernelControlPlane, HostKernelControlPlaneService>() {}
