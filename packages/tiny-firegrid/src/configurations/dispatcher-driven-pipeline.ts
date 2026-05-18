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

const TinyCurrentRuntimeInputDeferred = DurableDeferred.make(
  "tiny-firegrid.current.runtime-input.0",
  { success: RuntimeInputIntentRowSchema },
)

const TinyCurrentRuntimeWorkflow = Workflow.make({
  name: "tiny-firegrid.current.runtime-context",
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

const makeCurrentRuntimeWorkflowLayer = (
  session: AgentSessionService,
  outputEvents: Parameters<typeof persistAgentOutputObservation>[0],
) =>
  TinyCurrentRuntimeWorkflow.toLayer(({ contextId }) =>
    Effect.gen(function*() {
      const intent = yield* DurableDeferred.await(TinyCurrentRuntimeInputDeferred)
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
    readonly deferred: typeof TinyCurrentRuntimeInputDeferred
    readonly executionId: string
  }>())

  return {
    claimActive: (contextId: string) =>
      Effect.gen(function*() {
        const executionId = yield* TinyCurrentRuntimeWorkflow.executionId({ contextId })
        const handle = {
          contextId,
          deferred: TinyCurrentRuntimeInputDeferred,
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

export const tinyDispatcherDrivenPipeline = (
  chunks: ReadonlyArray<ProcessOutputChunk>,
) =>
  Effect.gen(function*() {
    const sentInputs: Array<AgentInputEvent> = []
    const session = makeTinyAgentSession({ chunks, sentInputs })
    const outputEvents = yield* makeMemoryDurableCollectionFacade(outputObservationKey)

    const program = Effect.gen(function*() {
      const control = yield* TinyRuntimeControlPlaneTable
      const engine = yield* WorkflowEngine.WorkflowEngine
      const registry = yield* makeActiveEngineRegistry
      const intent = makeRuntimeInputIntentRow({
        inputId: "intent-a",
        contextId: "ctx-a",
        kind: "message",
        authoredBy: "client",
        payload: { type: "text", text: "hello" },
      }, { createdAt: "1970-01-01T00:00:00.000Z" })
      const active = yield* registry.claimActive(intent.contextId)

      const dispatcher = control.inputIntents.rows().pipe(
        Stream.runForEach(observedIntent =>
          registry.get(observedIntent.contextId).pipe(
            Effect.flatMap(Option.match({
              onNone: () => Effect.void,
              onSome: handle =>
                engine.deferredDone(handle.deferred, {
                  workflowName: TinyCurrentRuntimeWorkflow.name,
                  executionId: handle.executionId,
                  deferredName: handle.deferred.name,
                  exit: Exit.succeed(observedIntent),
                }),
            })),
          )),
        Effect.forkScoped,
      )

      yield* dispatcher
      yield* control.inputIntents.insertOrGet(intent)

      const workflowOutput = yield* TinyCurrentRuntimeWorkflow.execute({
        contextId: intent.contextId,
      })
      const observations = yield* outputEvents.query(coll => coll.toArray)

      return {
        executionId: active.executionId,
        intent,
        observations,
        outputEvents,
        sentInputs: [...sentInputs],
        workflowOutput,
      }
    })

    return yield* Effect.scoped(
      Effect.provide(
        program,
        Layer.mergeAll(
          MemoryRuntimeControlPlaneTableLive,
          makeCurrentRuntimeWorkflowLayer(session, outputEvents),
        ).pipe(
          Layer.provideMerge(WorkflowEngine.layerMemory),
        ),
      ),
    )
  })
