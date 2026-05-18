import { Prompt, Response } from "@effect/ai"
import { DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import {
  makeRuntimeInputIntentRow,
  RuntimeInputIntentRowSchema,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { AgentCodecError, type AgentSessionService } from "@firegrid/runtime/codecs"
import type { AgentInputEvent, AgentOutputEvent } from "@firegrid/runtime/events"
import type { ProcessOutputChunk } from "@firegrid/runtime/sources/sandbox"
import { Chunk, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import { makeMemoryDurableCollectionFacade } from "../effect-durable-operators/DurableTable.ts"
import { MemoryRuntimeControlPlaneTableLive, TinyRuntimeControlPlaneTable } from "../host-sdk/host/runtime-control-plane.ts"
import { codecBoundaryFromSession } from "../runtime/agent-event-pipeline/codecs/contract.ts"
import { tinySandbox, tinySandboxProvider } from "../runtime/agent-event-pipeline/sources/sandbox/SandboxProvider.ts"
import {
  observationFromAgentOutput,
  outputObservationKey,
  persistAgentOutputObservation,
} from "../runtime/agent-event-pipeline/authorities/runtime-output.ts"

const runtimeInputDeferredFor = (contextId: string) =>
  DurableDeferred.make(`tiny-firegrid.multi.runtime-input.${contextId}.0`, {
    success: RuntimeInputIntentRowSchema,
  })

const TinyMultiContextRuntimeWorkflow = Workflow.make({
  name: "tiny-firegrid.multi.runtime-context",
  payload: {
    contextId: Schema.String,
  },
  success: Schema.Struct({
    sentInputs: Schema.Number,
    persistedOutputs: Schema.Number,
  }),
  error: Schema.String,
  idempotencyKey: ({ contextId }) => contextId,
})

const textFromIntentPayload = (payload: unknown): string => {
  if (typeof payload === "string") return payload
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") return record.text
  }
  return JSON.stringify(payload)
}

const agentInputEventFromIntent = (
  intent: RuntimeInputIntentRow,
): AgentInputEvent => ({
  _tag: "Prompt",
  correlationId: intent.intentId,
  prompt: Prompt.userMessage({
    content: [Prompt.textPart({ text: textFromIntentPayload(intent.payload) })],
  }),
})

const agentOutputEventFromChunk = (
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): AgentOutputEvent => ({
  _tag: "TextChunk",
  part: Response.textDeltaPart({
    id: "tiny-firegrid",
    delta: chunk.text,
  }),
})

const makeTinyAgentSession = (
  input: {
    readonly chunks: ReadonlyArray<ProcessOutputChunk>
    readonly sentInputs: Array<AgentInputEvent>
  },
): AgentSessionService => {
  const sandboxProvider = tinySandboxProvider(input.chunks)
  return {
    meta: {
      kind: "tiny-firegrid",
      capabilities: {
        streamingText: true,
        tools: false,
        permissions: false,
        images: false,
        structuredInput: false,
        cancellation: false,
        multiTurn: true,
        customStatus: [],
      },
    },
    toolUseMode: "observation_only",
    send: event =>
      Effect.sync(() => {
        input.sentInputs.push(event)
      }),
    outputs: sandboxProvider.stream(tinySandbox(), { argv: ["tiny-agent"] }).pipe(
      Stream.mapError(cause => new AgentCodecError({
        codec: "tiny-firegrid",
        op: "sandbox.stream",
        message: cause.message,
        cause,
      })),
      Stream.filter((chunk): chunk is Extract<ProcessOutputChunk, { readonly type: "output" }> =>
        chunk.type === "output" && chunk.channel === "stdout"),
      Stream.map(agentOutputEventFromChunk),
    ),
  }
}

const makeMultiContextRuntimeWorkflowLayer = (
  sessions: ReadonlyMap<string, AgentSessionService>,
  outputEvents: Parameters<typeof persistAgentOutputObservation>[0],
) =>
  TinyMultiContextRuntimeWorkflow.toLayer(({ contextId }) =>
    Effect.gen(function*() {
      const session = sessions.get(contextId)
      if (session === undefined) {
        return yield* Effect.fail(`missing tiny session for ${contextId}`)
      }
      const intent = yield* DurableDeferred.await(runtimeInputDeferredFor(contextId))
      const codec = codecBoundaryFromSession(session)
      yield* codec.send(agentInputEventFromIntent(intent))

      const persisted = yield* codec.outputs.pipe(
        Stream.mapAccum(0, (sequence, event) => [sequence + 1, { event, sequence }] as const),
        Stream.mapEffect(({ event, sequence }) =>
          persistAgentOutputObservation(outputEvents, observationFromAgentOutput({
            contextId,
            activityAttempt: 0,
            sequence,
            event,
          })).pipe(Effect.as(event))),
        Stream.runCollect,
      )

      return {
        sentInputs: 1,
        persistedOutputs: Chunk.size(persisted),
      }
    }).pipe(Effect.mapError(cause => String(cause))))

const makeActiveEngineRegistry = Effect.gen(function*() {
  const engines = yield* Ref.make(new Map<string, {
    readonly contextId: string
    readonly deferred: ReturnType<typeof runtimeInputDeferredFor>
    readonly executionId: string
  }>())

  return {
    claimActive: (contextId: string) =>
      Effect.gen(function*() {
        const executionId = yield* TinyMultiContextRuntimeWorkflow.executionId({ contextId })
        const handle = {
          contextId,
          deferred: runtimeInputDeferredFor(contextId),
          executionId,
        }
        yield* Ref.update(engines, current => new Map([...current, [contextId, handle]]))
        return handle
      }),
    get: (contextId: string) =>
      Ref.get(engines).pipe(
        Effect.map(current => Option.fromNullable(current.get(contextId))),
      ),
  }
})

export const tinyMultiContextPipeline = Effect.gen(function*() {
  const sentInputsByContext = new Map<string, Array<AgentInputEvent>>([
    ["ctx-a", []],
    ["ctx-b", []],
  ])
  const sessions = new Map<string, AgentSessionService>([
    ["ctx-a", makeTinyAgentSession({
      chunks: [
        { type: "output", channel: "stdout", text: "from-a" },
        { type: "exit", exitCode: 0 },
      ],
      sentInputs: sentInputsByContext.get("ctx-a") ?? [],
    })],
    ["ctx-b", makeTinyAgentSession({
      chunks: [
        { type: "output", channel: "stdout", text: "from-b" },
        { type: "exit", exitCode: 0 },
      ],
      sentInputs: sentInputsByContext.get("ctx-b") ?? [],
    })],
  ])
  const outputEvents = yield* makeMemoryDurableCollectionFacade(outputObservationKey)

  const program = Effect.gen(function*() {
    const control = yield* TinyRuntimeControlPlaneTable
    const engine = yield* WorkflowEngine.WorkflowEngine
    const registry = yield* makeActiveEngineRegistry
    const intentA = makeRuntimeInputIntentRow({
      inputId: "intent-a",
      contextId: "ctx-a",
      kind: "message",
      authoredBy: "client",
      payload: { type: "text", text: "hello-a" },
    }, { createdAt: "1970-01-01T00:00:00.000Z" })
    const intentB = makeRuntimeInputIntentRow({
      inputId: "intent-b",
      contextId: "ctx-b",
      kind: "message",
      authoredBy: "client",
      payload: { type: "text", text: "hello-b" },
    }, { createdAt: "1970-01-01T00:00:01.000Z" })

    yield* registry.claimActive("ctx-a")
    yield* registry.claimActive("ctx-b")
    yield* control.inputIntents.insertOrGet(makeRuntimeInputIntentRow({
      inputId: "intent-inactive",
      contextId: "ctx-inactive",
      kind: "message",
      authoredBy: "client",
      payload: { type: "text", text: "not-yet-active" },
    }, { createdAt: "1970-01-01T00:00:02.000Z" }))

    const dispatcher = control.inputIntents.rows().pipe(
      Stream.runForEach(observedIntent =>
        registry.get(observedIntent.contextId).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.void,
            onSome: handle =>
              engine.deferredDone(handle.deferred, {
                workflowName: TinyMultiContextRuntimeWorkflow.name,
                executionId: handle.executionId,
                deferredName: handle.deferred.name,
                exit: Exit.succeed(observedIntent),
              }),
          })),
        )),
      Effect.forkScoped,
    )

    yield* dispatcher
    yield* control.inputIntents.insertOrGet(intentB)
    yield* control.inputIntents.insertOrGet(intentA)

    const [workflowOutputA, workflowOutputB] = yield* Effect.all([
      TinyMultiContextRuntimeWorkflow.execute({ contextId: "ctx-a" }),
      TinyMultiContextRuntimeWorkflow.execute({ contextId: "ctx-b" }),
    ], { concurrency: "unbounded" })
    const observations = yield* outputEvents.query(coll => coll.toArray)

    return {
      observations,
      sentInputsByContext: {
        "ctx-a": [...(sentInputsByContext.get("ctx-a") ?? [])],
        "ctx-b": [...(sentInputsByContext.get("ctx-b") ?? [])],
      },
      workflowOutputs: {
        "ctx-a": workflowOutputA,
        "ctx-b": workflowOutputB,
      },
    }
  })

  return yield* Effect.scoped(
    Effect.provide(
      program,
      Layer.mergeAll(
        MemoryRuntimeControlPlaneTableLive,
        makeMultiContextRuntimeWorkflowLayer(sessions, outputEvents),
      ).pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory),
      ),
    ),
  )
})
