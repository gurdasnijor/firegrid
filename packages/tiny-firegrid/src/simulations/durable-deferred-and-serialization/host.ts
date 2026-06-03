/**
 * tf-ogoj — DurableDeferred + per-key serialization WORKBENCH host.
 *
 * Gathers trace evidence for the §2 "simplifying hypothesis" of
 * docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md: that
 * `signal.ts` is a SECOND implementation of capabilities the real
 * `DurableStreamsWorkflowEngine` already provides behind the standard
 * `WorkflowEngine` Tag, and that per-`contextId` serialization is a real OPEN
 * gap NOT given by `Workflow.idempotencyKey + cursor`.
 *
 * This host composes the REAL `FiregridRuntime` factory and overrides ONLY the
 * inbound session-input channel bindings to route public prompts to two
 * workbench workflows on the real engine. NO fake codec/adapter/sandbox/recorder
 * and NO Tag-swap of the spawn path: the H2 workflow drives a real ACP
 * example-agent spawn through the production `ProductionCodecAdapterLive`. The
 * adapter Tag is consumed via the `@firegrid/runtime/unified` namespace (the
 * host.ts eslint airgap blocks a NAMED `RuntimeContextSessionAdapter` import —
 * intent: block STUB Lives; we consume the REAL Tag, provided by the REAL
 * `defaultProductionAdapterLayer()`). See docs/findings/tf-ogoj-*.md.
 *
 *   H1 — `workbench.deferred-gate`: makes a `DurableDeferred`, awaits it (the
 *        engine suspends the body), and a later public input resolves it via the
 *        standard `DurableDeferred.succeed` combinator on the real engine. The
 *        trace shows `firegrid.workflow_engine.deferred.result/.done` spans.
 *   H2 — `workbench.serialization`: a per-event handler keyed `(contextId,
 *        inputKey)` over a durable consume cursor (the c71h shape), DRIVEN BY
 *        CONCURRENT same-`contextId` inputs. The trace shows whether
 *        idempotencyKey+cursor serializes or RACES (lost cursor updates).
 *   H3 — crash-recovery: not reachable from the public client surface; the
 *        finding names the runtime-package engine test + the fix site.
 */

import { Prompt } from "@effect/ai"
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import {
  eventOffset,
  makeDurableEventChannel,
  SessionCloseChannel,
  SessionCloseChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
} from "@firegrid/protocol/channels"
import { SessionCloseToolInputSchema } from "@firegrid/protocol/agent-tools"
import { SessionHandlePromptInputSchema } from "@firegrid/protocol/session-facade"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import {
  defaultProductionAdapterLayer,
  FiregridRuntime,
  HostSessionsStartChannelLive,
  SessionCancelChannelLive,
  SessionInputPayloadSchema,
  type SessionInputPayload,
} from "@firegrid/runtime/unified"
// Namespace access to the REAL `RuntimeContextSessionAdapter` Tag — see docblock.
import * as Unified from "@firegrid/runtime/unified"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "@firegrid/runtime/events"
import { DurableTable } from "effect-durable-operators"
import { Effect, Layer, Option, Schema } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const DEFAULT_ATTEMPT = 1
const H1_OPEN_PREFIX = "h1-open"
const H1_RESOLVE_PREFIX = "h1-resolve"

// ── H1: deferred-gate workflow ──────────────────────────────────────────────
//
// Exercises the STANDARD `DurableDeferred` combinator on the REAL engine: the
// body awaits a deferred (suspends via engine.deferredResult), a later public
// input resolves it via engine.deferredDone.

const GATE_DEFERRED_NAME = "input-gate"
const gateDeferred = DurableDeferred.make(GATE_DEFERRED_NAME, {
  success: Schema.String,
})

const DeferredGatePayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
})

const DeferredGateResultSchema = Schema.Struct({
  contextId: Schema.String,
  resolvedValue: Schema.String,
})

const DeferredGateWorkflow = Workflow.make({
  name: "workbench.deferred-gate",
  payload: DeferredGatePayloadSchema,
  success: DeferredGateResultSchema,
  idempotencyKey: (p) => p.contextId,
})

const deferredGateBody = (payload: typeof DeferredGatePayloadSchema.Type) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": payload.contextId,
      "firegrid.workbench.h1.phase": "awaiting",
    })
    // Suspends here: engine.deferredResult returns undefined → Workflow.suspend.
    const resolvedValue = yield* DurableDeferred.await(gateDeferred)
    yield* Effect.annotateCurrentSpan({
      "firegrid.workbench.h1.phase": "resumed",
      "firegrid.workbench.h1.resolved_value": resolvedValue,
    })
    return { contextId: payload.contextId, resolvedValue }
  }).pipe(
    Effect.withSpan("workbench.deferred_gate.body", {
      kind: "consumer",
      attributes: { "firegrid.context.id": payload.contextId },
    }),
  )

// ── H2: per-event serialization workflow + durable tables ───────────────────

const InputLogRowSchema = Schema.Struct({
  inputLogKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  seq: Schema.Number,
  inputKey: Schema.String,
  kind: SessionInputPayloadSchema.fields.kind,
  payloadJson: Schema.String,
  recordedAt: Schema.String,
})

class InputLogTable extends DurableTable(
  "tiny.firegrid.ddSerialization.inputLog",
  { rows: InputLogRowSchema },
) {}

const CursorRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  consumed: Schema.Number,
  updatedAt: Schema.String,
})

class CursorTable extends DurableTable(
  "tiny.firegrid.ddSerialization.cursor",
  { rows: CursorRowSchema },
) {}

const SerializationPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  inputKey: Schema.String,
  seq: Schema.Number,
})

const SerializationResultSchema = Schema.Struct({
  contextId: Schema.String,
  inputKey: Schema.String,
  seq: Schema.Number,
  kind: SessionInputPayloadSchema.fields.kind,
  consumedBefore: Schema.Number,
  advancedTo: Schema.Number,
  seqMatchedCursor: Schema.Boolean,
  reachedTerminal: Schema.Boolean,
})

const SerializationWorkflow = Workflow.make({
  name: "workbench.serialization",
  payload: SerializationPayloadSchema,
  success: SerializationResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.inputKey}`,
})

const now = (): string => new Date().toISOString()

const serializationBody = (
  payload: typeof SerializationPayloadSchema.Type,
) =>
  Effect.gen(function*() {
    const adapter = yield* Unified.RuntimeContextSessionAdapter
    const inputLog = yield* InputLogTable
    const cursor = yield* CursorTable
    const key = `${payload.contextId}:${payload.attempt}`

    // Real spawn / no-op reattach (Activity-memoized).
    yield* Activity.make({
      name: `workbench.serialization.start_or_attach/${payload.contextId}`,
      success: Schema.Void,
      execute: adapter.startOrAttach(payload.contextId, payload.attempt).pipe(
        Effect.orDie,
      ),
    })

    // Read durable cursor (the racy read under concurrency — H2).
    const cursorRow = yield* cursor.rows.get(payload.contextId).pipe(Effect.orDie)
    const consumedBefore = Option.match(cursorRow, {
      onNone: () => 0,
      onSome: (row) => row.consumed,
    })

    const rowKey = `${payload.contextId}:${payload.seq}`
    const rowOption = yield* inputLog.rows.get(rowKey).pipe(Effect.orDie)
    const row = yield* Option.match(rowOption, {
      onNone: () => Effect.dieMessage(`missing input-log row ${rowKey}`),
      onSome: (value) => Effect.succeed(value),
    })

    const seqMatchedCursor = payload.seq === consumedBefore
    const input: SessionInputPayload = {
      kind: row.kind,
      payloadJson: row.payloadJson,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": payload.contextId,
      "firegrid.workbench.h2.input_key": payload.inputKey,
      "firegrid.workbench.h2.seq": payload.seq,
      "firegrid.workbench.h2.cursor_consumed": consumedBefore,
      "firegrid.workbench.h2.seq_matched_cursor": seqMatchedCursor,
      "firegrid.workbench.h2.kind": row.kind,
    })

    if (row.kind === "terminal") {
      yield* Activity.make({
        name: `workbench.serialization.deregister/${payload.contextId}`,
        success: Schema.Void,
        execute: adapter.deregister(payload.contextId).pipe(Effect.orDie),
      })
      return {
        contextId: payload.contextId,
        inputKey: payload.inputKey,
        seq: payload.seq,
        kind: row.kind,
        consumedBefore,
        advancedTo: consumedBefore,
        seqMatchedCursor,
        reachedTerminal: true,
      }
    }

    yield* Activity.make({
      name: `workbench.serialization.send/${key}/${payload.seq}`,
      success: Schema.Void,
      execute: adapter.send(payload.contextId, payload.attempt, input).pipe(
        Effect.orDie,
      ),
    })

    // Advance the cursor (blind read-modify-write upsert — last-write-wins; the
    // H2 race shows here if concurrent executions all read the same consumed).
    const advancedTo = consumedBefore + 1
    yield* Activity.make({
      name: `workbench.serialization.advance_cursor/${payload.contextId}/${payload.seq}`,
      success: Schema.Void,
      execute: cursor.rows.upsert({
        contextId: payload.contextId,
        consumed: advancedTo,
        updatedAt: now(),
      }).pipe(Effect.orDie),
    })

    return {
      contextId: payload.contextId,
      inputKey: payload.inputKey,
      seq: payload.seq,
      kind: row.kind,
      consumedBefore,
      advancedTo,
      seqMatchedCursor,
      reachedTerminal: false,
    }
  }).pipe(
    Effect.withSpan("workbench.serialization.body", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": payload.contextId,
        "firegrid.workbench.h2.attempt": payload.attempt,
      },
    }),
  )

// ── Channel overrides ───────────────────────────────────────────────────────

const encodeAgentInputEvent = Schema.encodeSync(AgentInputEventSchema)

const promptPayloadJson = (text: string, correlationId: string): string => {
  const event: AgentInputEvent = {
    _tag: "Prompt",
    prompt: Prompt.userMessage({ content: [Prompt.textPart({ text })] }),
    correlationId,
  }
  return JSON.stringify(encodeAgentInputEvent(event))
}

const promptText = (payload: unknown): string =>
  typeof payload === "object"
    && payload !== null
    && "text" in payload
    && typeof (payload as { readonly text: unknown }).text === "string"
    ? (payload as { readonly text: string }).text
    : JSON.stringify(payload)

const nextSeq = (
  inputLog: InputLogTable["Type"],
  contextId: string,
): Effect.Effect<number> =>
  inputLog.rows.query((coll) =>
    coll.toArray.filter((row) => row.contextId === contextId).length,
  ).pipe(Effect.orDie)

const writeAndExecuteSerialization = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly inputLog: InputLogTable["Type"]
  readonly contextId: string
  readonly inputKey: string
  readonly kind: SessionInputPayload["kind"]
  readonly payloadJson: string
  readonly target: string
}) =>
  Effect.gen(function*() {
    const seq = yield* nextSeq(options.inputLog, options.contextId)
    yield* options.inputLog.rows.insertOrGet({
      inputLogKey: `${options.contextId}:${seq}`,
      contextId: options.contextId,
      seq,
      inputKey: options.inputKey,
      kind: options.kind,
      payloadJson: options.payloadJson,
      recordedAt: now(),
    }).pipe(Effect.orDie)
    yield* SerializationWorkflow.execute({
      contextId: options.contextId,
      attempt: DEFAULT_ATTEMPT,
      inputKey: options.inputKey,
      seq,
    }, { discard: true })
    return eventOffset(`${options.target}:${options.contextId}:${seq}`)
  }).pipe(
    Effect.provideService(WorkflowEngine.WorkflowEngine, options.engine),
  )

const openGate = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly contextId: string
  readonly target: string
}) =>
  Effect.gen(function*() {
    yield* DeferredGateWorkflow.execute({
      contextId: options.contextId,
      attempt: DEFAULT_ATTEMPT,
    }, { discard: true })
    return eventOffset(`${options.target}:${options.contextId}:h1-open`)
  }).pipe(
    Effect.provideService(WorkflowEngine.WorkflowEngine, options.engine),
  )

const resolveGate = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly contextId: string
  readonly value: string
  readonly target: string
}) =>
  Effect.gen(function*() {
    const executionId = yield* DeferredGateWorkflow.executionId({
      contextId: options.contextId,
      attempt: DEFAULT_ATTEMPT,
    })
    const token = DurableDeferred.tokenFromExecutionId(gateDeferred, {
      workflow: DeferredGateWorkflow,
      executionId,
    })
    yield* DurableDeferred.succeed(gateDeferred, {
      token,
      value: options.value,
    }).pipe(Effect.orDie)
    return eventOffset(`${options.target}:${options.contextId}:h1-resolve`)
  }).pipe(
    Effect.provideService(WorkflowEngine.WorkflowEngine, options.engine),
  )

const SessionPromptChannelWorkbenchLive = Layer.effect(
  SessionPromptChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const inputLog = yield* InputLogTable
    return SessionPromptChannel.of({
      forSession: (sessionId) =>
        makeDurableEventChannel({
          target: SessionPromptChannelTarget,
          schema: SessionHandlePromptInputSchema,
          append: (request) => {
            const target = String(SessionPromptChannelTarget)
            if (request.idempotencyKey.startsWith(H1_OPEN_PREFIX)) {
              return openGate({ engine, contextId: sessionId, target })
            }
            if (request.idempotencyKey.startsWith(H1_RESOLVE_PREFIX)) {
              return resolveGate({
                engine,
                contextId: sessionId,
                value: promptText(request.payload),
                target,
              })
            }
            return writeAndExecuteSerialization({
              engine,
              inputLog,
              contextId: sessionId,
              inputKey: request.idempotencyKey,
              kind: "prompt",
              payloadJson: promptPayloadJson(
                promptText(request.payload),
                request.idempotencyKey,
              ),
              target,
            })
          },
        }),
    })
  }),
)

const SessionCloseChannelWorkbenchLive = Layer.effect(
  SessionCloseChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const inputLog = yield* InputLogTable
    return makeDurableEventChannel({
      target: SessionCloseChannelTarget,
      schema: SessionCloseToolInputSchema,
      append: (request) =>
        writeAndExecuteSerialization({
          engine,
          inputLog,
          contextId: request.sessionId,
          inputKey: `terminal:${request.sessionId}`,
          kind: "terminal",
          payloadJson: JSON.stringify({
            operation: "close",
            ...(request.reason === undefined ? {} : { reason: request.reason }),
          }),
          target: String(SessionCloseChannelTarget),
        }),
    })
  }),
)

// ── Host composition ────────────────────────────────────────────────────────

const workbenchTablesLayer = (env: TinyFiregridHostEnv) =>
  Layer.merge(
    InputLogTable.layer({
      streamOptions: {
        url: durableStreamUrl(
          env.durableStreamsBaseUrl,
          `${env.namespace}.workbench.dd-serialization.input-log`,
        ),
        contentType: "application/json",
      },
    }),
    CursorTable.layer({
      streamOptions: {
        url: durableStreamUrl(
          env.durableStreamsBaseUrl,
          `${env.namespace}.workbench.dd-serialization.cursor`,
        ),
        contentType: "application/json",
      },
    }),
  )

export const durableDeferredAndSerializationHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const tables = workbenchTablesLayer(env)
  const adapter = defaultProductionAdapterLayer()

  const workflowLayer = Layer.merge(
    SerializationWorkflow.toLayer(serializationBody),
    DeferredGateWorkflow.toLayer(deferredGateBody),
  )

  const channelOverrides = Layer.mergeAll(
    SessionPromptChannelWorkbenchLive,
    SessionCloseChannelWorkbenchLive,
    HostSessionsStartChannelLive,
    SessionCancelChannelLive,
  )

  const overrides = Layer.mergeAll(workflowLayer, channelOverrides).pipe(
    Layer.provideMerge(adapter),
    Layer.provideMerge(tables),
  )

  const factory = FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  )

  // OUTER (override) layer wins for duplicate output Tags.
  return overrides.pipe(Layer.provideMerge(factory))
}
