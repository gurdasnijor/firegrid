/**
 * tf-ogoj — DurableDeferred + per-key serialization WORKBENCH host (v2, isolated).
 *
 * Gathers trace evidence for the §2 "simplifying hypothesis" of
 * docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md.
 *
 * v2 ISOLATION (in response to a calibration challenge): the v1 H2 measured a race
 * in the SIM's own channel seq-assignment (`nextSeq = count(rows)` then
 * `insertOrGet`), which confounded the production question. v2 removes that
 * entirely — there is NO input-log and NO count-then-insert. The channel simply
 * `execute`s the workflow with the input carried in the payload. The ONLY shared
 * mutable state left is the per-`contextId` **cursor**, so the trace isolates the
 * production-relevant question: do concurrent same-`contextId` executions
 * serialize on the cursor (read 0,1,2,… distinct; final = N) or RACE (repeated
 * reads; final < N, lost updates)?
 *
 * Host composes the REAL `FiregridRuntime` factory + real engine + real ACP
 * example-agent spawn (no fakes, no Tag-swap of the spawn path). The adapter Tag
 * is consumed via the `@firegrid/runtime/unified` namespace (host.ts airgap blocks
 * a NAMED `RuntimeContextSessionAdapter` import; we consume the REAL Tag, provided
 * by the REAL `defaultProductionAdapterLayer()`).
 *
 *   H1 — `workbench.deferred-gate`: standard `DurableDeferred` await-once on the
 *        real engine (suspend via `engine.deferredResult`, resolve via
 *        `engine.deferredDone`). Trace shows the `deferred.result/.done` spans.
 *   H2 — `workbench.serialization`: per-event handler keyed `(contextId,inputKey)`,
 *        each body reading then advancing the durable cursor, driven by CONCURRENT
 *        same-`contextId` inputs. Cursor is the only shared state.
 *   H3 — crash-recovery: not reachable from the public client surface (finding).
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

const now = (): string => new Date().toISOString()

// ── H1: deferred-gate workflow ──────────────────────────────────────────────

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

// ── H2: per-event serialization workflow (cursor is the ONLY shared state) ───

const CursorRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  consumed: Schema.Number,
  updatedAt: Schema.String,
})

class CursorTable extends DurableTable(
  "tiny.firegrid.ddSerialization.cursor",
  { rows: CursorRowSchema },
) {}

const SerializationKind = Schema.Literal("prompt", "terminal")

const SerializationPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  inputKey: Schema.String,
  kind: SerializationKind,
  text: Schema.String,
})

const SerializationResultSchema = Schema.Struct({
  contextId: Schema.String,
  inputKey: Schema.String,
  kind: SerializationKind,
  cursorAtEntry: Schema.Number,
  cursorAfter: Schema.Number,
})

const SerializationWorkflow = Workflow.make({
  name: "workbench.serialization",
  payload: SerializationPayloadSchema,
  success: SerializationResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.inputKey}`,
})

const encodeAgentInputEvent = Schema.encodeSync(AgentInputEventSchema)

const promptInput = (text: string, correlationId: string): SessionInputPayload => {
  const event: AgentInputEvent = {
    _tag: "Prompt",
    prompt: Prompt.userMessage({ content: [Prompt.textPart({ text })] }),
    correlationId,
  }
  return {
    kind: "prompt",
    payloadJson: JSON.stringify(encodeAgentInputEvent(event)),
  }
}

const serializationBody = (
  payload: typeof SerializationPayloadSchema.Type,
) =>
  Effect.gen(function*() {
    const adapter = yield* Unified.RuntimeContextSessionAdapter
    const cursor = yield* CursorTable
    const key = `${payload.contextId}:${payload.attempt}`

    // Read the durable cursor, then advance it — this read-modify-write over a
    // single per-contextId row is the ONLY shared mutable state. Done FIRST
    // (before the slow spawn) so concurrent bodies hit the read→write window.
    const cursorRow = yield* cursor.rows.get(payload.contextId).pipe(Effect.orDie)
    const cursorAtEntry = Option.match(cursorRow, {
      onNone: () => 0,
      onSome: (row) => row.consumed,
    })
    const cursorAfter = cursorAtEntry + 1

    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": payload.contextId,
      "firegrid.workbench.h2.input_key": payload.inputKey,
      "firegrid.workbench.h2.kind": payload.kind,
      "firegrid.workbench.h2.cursor_at_entry": cursorAtEntry,
      "firegrid.workbench.h2.cursor_after": cursorAfter,
    })

    // Real spawn / no-op reattach (Activity-memoized). Done BETWEEN the cursor
    // read and the cursor advance so the read→advance critical section spans the
    // ~270ms spawn — forcing concurrent same-contextId bodies to OVERLAP on the
    // cursor (the v2-isolated run advanced before the spawn, which kept the
    // critical section sub-millisecond and let the single-threaded scheduler
    // stagger the accesses; that masked whether the blind read-modify-write
    // races, per the tf-o8zu/coordinator review).
    yield* Activity.make({
      name: `workbench.serialization.start_or_attach/${payload.contextId}`,
      success: Schema.Void,
      execute: adapter.startOrAttach(payload.contextId, payload.attempt).pipe(
        Effect.orDie,
      ),
    })

    if (payload.kind === "terminal") {
      yield* Activity.make({
        name: `workbench.serialization.deregister/${payload.contextId}`,
        success: Schema.Void,
        execute: adapter.deregister(payload.contextId).pipe(Effect.orDie),
      })
    } else {
      yield* Activity.make({
        name: `workbench.serialization.send/${key}/${payload.inputKey}`,
        success: Schema.Void,
        execute: adapter.send(
          payload.contextId,
          payload.attempt,
          promptInput(payload.text, payload.inputKey),
        ).pipe(Effect.orDie),
      })
    }

    // Advance the cursor LAST — a blind read-modify-write (upsert = last-write-
    // wins, not compare-and-swap). With the read now separated from this write by
    // the spawn, concurrent bodies' [read..advance] windows overlap, so if the
    // cursor does not serialize, this loses updates (repeated cursor_at_entry,
    // final consumed < N).
    yield* cursor.rows.upsert({
      contextId: payload.contextId,
      consumed: cursorAfter,
      updatedAt: now(),
    }).pipe(Effect.orDie)

    return {
      contextId: payload.contextId,
      inputKey: payload.inputKey,
      kind: payload.kind,
      cursorAtEntry,
      cursorAfter,
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

const promptText = (payload: unknown): string =>
  typeof payload === "object"
    && payload !== null
    && "text" in payload
    && typeof (payload as { readonly text: unknown }).text === "string"
    ? (payload as { readonly text: string }).text
    : JSON.stringify(payload)

const executeSerialization = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly contextId: string
  readonly inputKey: string
  readonly kind: "prompt" | "terminal"
  readonly text: string
  readonly target: string
}) =>
  Effect.gen(function*() {
    yield* SerializationWorkflow.execute({
      contextId: options.contextId,
      attempt: DEFAULT_ATTEMPT,
      inputKey: options.inputKey,
      kind: options.kind,
      text: options.text,
    }, { discard: true })
    return eventOffset(`${options.target}:${options.contextId}:${options.inputKey}`)
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
            return executeSerialization({
              engine,
              contextId: sessionId,
              inputKey: request.idempotencyKey,
              kind: "prompt",
              text: promptText(request.payload),
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
    return makeDurableEventChannel({
      target: SessionCloseChannelTarget,
      schema: SessionCloseToolInputSchema,
      append: (request) =>
        executeSerialization({
          engine,
          contextId: request.sessionId,
          inputKey: `terminal:${request.sessionId}`,
          kind: "terminal",
          text: request.reason ?? "",
          target: String(SessionCloseChannelTarget),
        }),
    })
  }),
)

// ── Host composition ────────────────────────────────────────────────────────

const cursorTableLayer = (env: TinyFiregridHostEnv) =>
  CursorTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        env.durableStreamsBaseUrl,
        `${env.namespace}.workbench.dd-serialization.cursor`,
      ),
      contentType: "application/json",
    },
  })

export const durableDeferredAndSerializationHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const tables = cursorTableLayer(env)
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
