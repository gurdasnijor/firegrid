import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import {
  RuntimeContextIntentSchema,
  type RuntimeContext,
  type RuntimeContextIntent,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressRequestSchema,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Cause, Context, Effect, Either, Exit, Layer, Match, Option, Schema } from "effect"
import type { Scope } from "effect"
import {
  RuntimeContextInsert,
  RuntimeContextRead,
  RuntimeRunAppendAndGet,
} from "../../authorities/index.ts"
import {
  appendRuntimeInputDeferred,
} from "../runtime-input-deferred.ts"
import {
  WorkflowEngineTable,
} from "../DurableStreamsWorkflowEngine.ts"
import {
  RuntimeContextWorkflowNative,
} from "./runtime-context.ts"
import {
  runtimeContextWorkflowExecutionId,
} from "./runtime-context-run.ts"

export const HostKernelWorkflowPayloadSchema = Schema.Struct({
  hostId: Schema.String.pipe(Schema.minLength(1)),
})
export type HostKernelWorkflowPayload = Schema.Schema.Type<
  typeof HostKernelWorkflowPayloadSchema
>

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

export type HostKernelWorkflowExecutionEnv =
  | RuntimeContextInsert
  | RuntimeContextRead
  | RuntimeRunAppendAndGet
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngineTable
  | Scope.Scope

const sanitizeIdSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]/g, "_")

export const hostKernelWorkflowExecutionId = (hostId: string): string =>
  `host-kernel:${sanitizeIdSegment(hostId)}`

export const hostKernelIntentDeferredName = (
  hostId: string,
  sequence: number,
): string => `host-kernel/${sanitizeIdSegment(hostId)}/intent/${sequence}`

export const hostKernelIntentDeferredFor = (
  hostId: string,
  sequence: number,
) =>
  DurableDeferred.make(hostKernelIntentDeferredName(hostId, sequence), {
    success: HostKernelIntentSchema,
  })

const hostKernelIntentPrefix = (hostId: string): string =>
  `host-kernel/${sanitizeIdSegment(hostId)}/intent/`

const sequenceFromDeferredName = (
  hostId: string,
  deferredName: string,
): number | undefined => {
  const prefix = hostKernelIntentPrefix(hostId)
  if (!deferredName.startsWith(prefix)) return undefined
  const parsed = Number.parseInt(deferredName.slice(prefix.length), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const reviveExit = (value: unknown): Exit.Exit<unknown, unknown> => {
  const record = value as {
    readonly _tag?: string
    readonly value?: unknown
    readonly cause?: unknown
  }
  if (record?._tag === "Success") return Exit.succeed(record.value)
  if (record?._tag === "Failure") return Exit.failCause(record.cause as Cause.Cause<unknown>)
  return value as Exit.Exit<unknown, unknown>
}

const decodeStoredIntent = (value: unknown): Option.Option<HostKernelIntent> =>
  Exit.match(reviveExit(value), {
    onFailure: () => Option.none(),
    onSuccess: success =>
      Match.value(Schema.decodeUnknownEither(HostKernelIntentSchema)(success)).pipe(
        Match.when(Either.isRight, decoded => Option.some(decoded.right)),
        Match.orElse(() => Option.none()),
      ),
  })

const readContext = (
  contextId: string,
): Effect.Effect<RuntimeContext, unknown, RuntimeContextRead> =>
  Effect.gen(function*() {
    const reader = yield* RuntimeContextRead
    const context = yield* reader.readContext(contextId)
    if (Option.isSome(context)) return context.value
    return yield* Effect.fail(new Error(`runtime context not found: ${contextId}`))
  })

const createOrLoadContext = (
  intent: Extract<HostKernelIntent, { readonly _tag: "CreateLoad" }>,
) =>
  Effect.gen(function*() {
    const insert = yield* RuntimeContextInsert
    yield* insert.insertLocalContextIfAbsent(
      intent.runtime,
      {
        contextId: intent.contextId,
        ...(intent.createdBy === undefined ? {} : { createdBy: intent.createdBy }),
      },
    )
  })

const startRuntimeContextChild = (contextId: string) =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* engine.execute(RuntimeContextWorkflowNative, {
      executionId: runtimeContextWorkflowExecutionId(contextId),
      payload: { contextId },
      discard: true,
    })
  }).pipe(
    Effect.withSpan("firegrid.host_kernel.child.start", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
  )

const promptRuntimeContextChild = (
  intent: Extract<HostKernelIntent, { readonly _tag: "Prompt" }>,
) =>
  Effect.gen(function*() {
    const context = yield* readContext(intent.contextId)
    yield* appendRuntimeInputDeferred(intent.request, context)
  })

const cancelRuntimeContextChild = (contextId: string) =>
  Effect.gen(function*() {
    const context = yield* readContext(contextId)
    const runs = yield* RuntimeRunAppendAndGet
    const activityAttempt = yield* runs.allocateActivityAttempt(context)
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* engine.interrupt(
      RuntimeContextWorkflowNative,
      runtimeContextWorkflowExecutionId(contextId),
    )
    yield* runs.recordExited(context, activityAttempt, {
      exitCode: 130,
      signal: "SIGTERM",
    })
  }).pipe(
    Effect.withSpan("firegrid.host_kernel.child.cancel", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
  )

const applyHostKernelIntent = (
  hostId: string,
  sequence: number,
  intent: HostKernelIntent,
): Effect.Effect<HostKernelIntentDecision, unknown, HostKernelWorkflowExecutionEnv> =>
  Effect.gen(function*() {
    switch (intent._tag) {
      case "CreateLoad":
        yield* createOrLoadContext(intent)
        return {
          hostId,
          sequence,
          requestId: intent.requestId,
          contextId: intent.contextId,
          intent: intent._tag,
          status: "created_or_loaded",
        } satisfies HostKernelIntentDecision
      case "Start":
        yield* startRuntimeContextChild(intent.contextId)
        return {
          hostId,
          sequence,
          requestId: intent.requestId,
          contextId: intent.contextId,
          intent: intent._tag,
          status: "started",
        } satisfies HostKernelIntentDecision
      case "Prompt":
        yield* promptRuntimeContextChild(intent)
        return {
          hostId,
          sequence,
          requestId: intent.requestId,
          contextId: intent.contextId,
          intent: intent._tag,
          status: "prompted",
        } satisfies HostKernelIntentDecision
      case "Cancel":
        yield* cancelRuntimeContextChild(intent.contextId)
        return {
          hostId,
          sequence,
          requestId: intent.requestId,
          contextId: intent.contextId,
          intent: intent._tag,
          status: "cancelled",
        } satisfies HostKernelIntentDecision
    }
  }).pipe(
    Effect.withSpan("firegrid.host_kernel.workflow.intent.apply", {
      kind: "internal",
      attributes: {
        "firegrid.host.id": hostId,
        "firegrid.context.id": intent.contextId,
        "firegrid.host_kernel.intent": intent._tag,
        "firegrid.host_kernel.sequence": sequence,
      },
    }),
  )

const applyHostKernelIntentActivity = (
  hostId: string,
  sequence: number,
  intent: HostKernelIntent,
  captured: Context.Context<HostKernelWorkflowExecutionEnv>,
) =>
  Activity.make({
    name: `host-kernel/${sanitizeIdSegment(hostId)}/intent/${sequence}`,
    success: HostKernelIntentDecisionSchema,
    execute: applyHostKernelIntent(hostId, sequence, intent).pipe(
      Effect.catchAllCause(cause =>
        Effect.succeed({
          hostId,
          sequence,
          requestId: intent.requestId,
          contextId: intent.contextId,
          intent: intent._tag,
          status: "failed" as const,
          message: Cause.pretty(cause),
        })),
      Effect.provide(captured),
    ),
  })

const runHostKernelWorkflow = (
  hostId: string,
  captured: Context.Context<HostKernelWorkflowExecutionEnv>,
): Effect.Effect<never, never, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance> =>
  Effect.gen(function*() {
    let sequence = 0
    while (true) {
      const intent = yield* DurableDeferred.await(
        hostKernelIntentDeferredFor(hostId, sequence),
      )
      yield* applyHostKernelIntentActivity(hostId, sequence, intent, captured)
      sequence += 1
    }
    return yield* Effect.never
  }).pipe(
    Effect.withSpan("firegrid.host_kernel.workflow.run", {
      kind: "internal",
      attributes: {
        "firegrid.host.id": hostId,
      },
    }),
    Effect.annotateSpans("firegrid.host.id", hostId),
  )

export const HostKernelWorkflow = Workflow.make({
  name: "firegrid.host-kernel",
  payload: HostKernelWorkflowPayloadSchema,
  success: Schema.Void,
  error: Schema.Never,
  idempotencyKey: ({ hostId }) => hostKernelWorkflowExecutionId(hostId),
})

export const HostKernelWorkflowLayer = Layer.scopedDiscard(
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const captured = yield* Effect.context<HostKernelWorkflowExecutionEnv>()
    yield* engine.register(HostKernelWorkflow, ({ hostId }) =>
      runHostKernelWorkflow(hostId, captured))
  }).pipe(
    Effect.withSpan("firegrid.host_kernel.workflow.register", {
      kind: "internal",
    }),
  ),
)

const hostKernelMailboxRows = (
  table: WorkflowEngineTable["Type"],
  hostId: string,
) =>
  table.deferreds.query((coll) =>
    coll.toArray
      .filter(row =>
        row.workflowName === HostKernelWorkflow.name &&
        row.executionId === hostKernelWorkflowExecutionId(hostId) &&
        row.deferredName.startsWith(hostKernelIntentPrefix(hostId)))
      .map(row => ({
        row,
        sequence: sequenceFromDeferredName(hostId, row.deferredName),
        intent: decodeStoredIntent(row.exit),
      }))).pipe(
    Effect.withSpan("firegrid.host_kernel.mailbox.query", {
      kind: "internal",
      attributes: {
        "firegrid.host.id": hostId,
      },
    }),
  )

const nextIntentSequence = (
  table: WorkflowEngineTable["Type"],
  hostId: string,
  intent: HostKernelIntent,
): Effect.Effect<number, unknown> =>
  Effect.gen(function*() {
    const rows = yield* hostKernelMailboxRows(table, hostId)
    const duplicate = rows.find(row =>
      Option.isSome(row.intent) && row.intent.value.requestId === intent.requestId)
    if (duplicate?.sequence !== undefined) return duplicate.sequence
    return rows.reduce(
      (max, row) => row.sequence === undefined ? max : Math.max(max, row.sequence + 1),
      0,
    )
  })

export const HostKernelControlPlaneLive = Layer.effect(
  HostKernelControlPlane,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const table = yield* WorkflowEngineTable
    return HostKernelControlPlane.of({
      signal: (hostId, intent) =>
        Effect.gen(function*() {
          yield* engine.execute(HostKernelWorkflow, {
            executionId: hostKernelWorkflowExecutionId(hostId),
            payload: { hostId },
            discard: true,
          }).pipe(Effect.ignore)
          const sequence = yield* nextIntentSequence(table, hostId, intent)
          yield* engine.deferredDone(
            hostKernelIntentDeferredFor(hostId, sequence),
            {
              workflowName: HostKernelWorkflow.name,
              executionId: hostKernelWorkflowExecutionId(hostId),
              deferredName: hostKernelIntentDeferredName(hostId, sequence),
              exit: Exit.succeed(intent),
            },
          )
          return {
            hostId,
            sequence,
            requestId: intent.requestId,
            accepted: true,
          }
        }).pipe(
          Effect.withSpan("firegrid.host_kernel.intent.signal", {
            kind: "producer",
            attributes: {
              "firegrid.host.id": hostId,
              "firegrid.context.id": intent.contextId,
              "firegrid.host_kernel.intent": intent._tag,
              "firegrid.host_kernel.request_id": intent.requestId,
            },
          }),
        ),
    })
  }),
)
