// Focused tests for the Shape C RuntimeContext per-event handler.
// See `packages/runtime/src/agent-event-pipeline/subscribers/runtime-context/handler.ts`.
//
// Three slices, one invariant each:
//   1. state transition + action dispatch through the session-command seam;
//   2. reload-after-restart idempotency (second handler call is a no-op);
//   3. tool-result roundtrip through RuntimeToolUseExecutor + the session-
//      command seam.
//
// The handler's R names `RuntimeContextWorkflowSession` (not `AgentSession`):
// the test double here records the `(activityAttempt, command)` pairs the
// handler hands off to the session-command sink.

import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Layer, Ref, type Scope } from "effect"
import { Prompt } from "@effect/ai"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  makeHostStreamPrefix,
  type HostId,
  type HostStreamPrefix,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import {
  makePerContextRuntimeContextStateStore,
  RuntimeContextStateStore,
} from "../../../../src/workflow-engine/runtime-context-state.ts"
import {
  RuntimeToolUseExecutor,
} from "../../../../src/workflow-engine/tool-execution/runtime-tool-use-executor.ts"
import {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
} from "../../../../src/subscribers/runtime-context-session/index.ts"
import {
  handleRuntimeContextEvent,
  type RuntimeContextTargetEvent,
} from "../../../../src/agent-event-pipeline/subscribers/runtime-context/handler.ts"
import type {
  AgentOutputEvent,
  RuntimeAgentOutputObservation,
} from "../../../../src/agent-event-pipeline/events/index.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const ATTEMPT = 0

// The handler reads only `contextId` and `runtime.config.agentProtocol`.
// Other RuntimeContext fields are untouched, so we narrow rather than build a
// full row (matching the convention in runtime-context-state.test.ts).
const contextFor = (
  contextId: string,
  agentProtocol: "stdio-jsonl" | "acp" = "stdio-jsonl",
): RuntimeContext =>
  ({
    contextId,
    runtime: { config: { agentProtocol } },
  }) as unknown as RuntimeContext

// Session-command sink test double: records every (activityAttempt, command)
// the handler emits. `startOrAttach` is not exercised by the per-event
// handler (composition owns lifecycle), so its impl is a no-op default that
// fails loudly if a test accidentally drives it.
interface RecordingSession {
  readonly sent: Ref.Ref<ReadonlyArray<{
    readonly activityAttempt: number
    readonly command: RuntimeContextSessionCommand
  }>>
  readonly layer: Layer.Layer<RuntimeContextWorkflowSession>
}

const makeRecordingSession = (): Effect.Effect<RecordingSession> =>
  Effect.gen(function*() {
    const sent = yield* Ref.make<ReadonlyArray<{
      readonly activityAttempt: number
      readonly command: RuntimeContextSessionCommand
    }>>([])
    // `startOrAttach` is owned by composition/lifecycle; the per-event handler
    // never invokes it. Return synthetic evidence so the service is total —
    // any future test that accidentally drives it surfaces through the `sent`
    // ref's assertions rather than a thrown defect.
    const layer = RuntimeContextWorkflowSession.layer({
      startOrAttach: (context, activityAttempt) =>
        Effect.succeed({
          contextId: context.contextId,
          activityAttempt,
          ownerKind: "raw" as const,
          ownerSessionId: "test-session",
          startCommandId: `test-start-${context.contextId}-${activityAttempt}`,
        }),
      send: (context, activityAttempt, command) =>
        Ref.update(sent, current => [...current, { activityAttempt, command }])
          .pipe(Effect.as({
            contextId: context.contextId,
            activityAttempt,
            commandId: command.commandId,
            ownerSessionId: "test-session",
          })),
    })
    return { sent, layer }
  })

// Executor test double: records calls + returns a fixed ToolResult.
interface RecordingExecutor {
  readonly calls: Ref.Ref<number>
  readonly layer: Layer.Layer<RuntimeToolUseExecutor>
}

const makeRecordingExecutor = (): Effect.Effect<RecordingExecutor> =>
  Effect.gen(function*() {
    const calls = yield* Ref.make(0)
    const layer = Layer.effect(
      RuntimeToolUseExecutor,
      Ref.get(calls).pipe(
        Effect.as(
          RuntimeToolUseExecutor.of({
            execute: (_context, event) =>
              Ref.update(calls, n => n + 1).pipe(
                Effect.as({
                  _tag: "ToolResult" as const,
                  part: Prompt.toolResultPart({
                    id: event.part.id,
                    name: event.part.name,
                    result: { ok: true },
                    isFailure: false,
                    providerExecuted: false,
                  }),
                }),
              ),
          }),
        ),
      ),
    )
    return { calls, layer }
  })

const stateStoreLayer = (): Layer.Layer<RuntimeContextStateStore, never, Scope.Scope> => {
  if (baseUrl === undefined) throw new Error("server not started")
  const prefix: HostStreamPrefix = makeHostStreamPrefix({
    namespace: "shape-c-handler-test",
    hostId: "shape-c-handler-test_host" as HostId,
  })
  return Layer.scoped(
    RuntimeContextStateStore,
    makePerContextRuntimeContextStateStore(
      { durableStreamsBaseUrl: baseUrl },
      prefix,
    ),
  )
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

const promptRowForInput = (
  contextId: string,
  text: string,
  sequence: number,
) =>
  ({
    ...makeRuntimeIngressInputRow({
      contextId,
      kind: "message",
      authoredBy: "client" as const,
      payload: text,
    }),
    sequence,
  })

const toolUseOutputObservation = (
  contextId: string,
  sequence: number,
  toolUseId: string,
  toolName: string,
): RuntimeAgentOutputObservation => {
  const event: Extract<AgentOutputEvent, { readonly _tag: "ToolUse" }> = {
    _tag: "ToolUse",
    part: Prompt.toolCallPart({
      id: toolUseId,
      name: toolName,
      params: {},
      providerExecuted: false,
    }),
  }
  return {
    contextId,
    activityAttempt: ATTEMPT,
    sequence,
    event,
  } as unknown as RuntimeAgentOutputObservation
}

describe("Shape C handleRuntimeContextEvent", () => {
  it("dispatches a prompt input through the session-command seam and advances the durable cursor", async () => {
    await run(Effect.gen(function*() {
      const context = contextFor("ctx-input")
      const session = yield* makeRecordingSession()
      const executor = yield* makeRecordingExecutor()
      const baseLayer = Layer.mergeAll(
        stateStoreLayer(),
        session.layer,
        executor.layer,
      )

      const row = promptRowForInput("ctx-input", "hello", 0)
      const event: RuntimeContextTargetEvent = { _tag: "Input", event: row }

      yield* handleRuntimeContextEvent(context, ATTEMPT, event).pipe(
        Effect.provide(baseLayer),
      )

      const sent = yield* Ref.get(session.sent)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.command.event._tag).toBe("Prompt")
      expect(sent[0]?.command.commandId).toBe(`runtime-input-ctx-input-${row.inputId}`)
      expect(sent[0]?.activityAttempt).toBe(ATTEMPT)

      // The cursor on the durable row must have advanced to the input's seq.
      const store = yield* Effect.provide(
        Effect.flatMap(RuntimeContextStateStore, s => s.load(context, ATTEMPT)),
        baseLayer,
      )
      expect(store.lastProcessedInputSequence).toBe(0)
      expect(yield* Ref.get(executor.calls)).toBe(0)
    }))
  })

  it("is idempotent across a reload: a second invocation is a no-op", async () => {
    await run(Effect.gen(function*() {
      const context = contextFor("ctx-idem")
      const session = yield* makeRecordingSession()
      const executor = yield* makeRecordingExecutor()
      const baseLayer = Layer.mergeAll(
        stateStoreLayer(),
        session.layer,
        executor.layer,
      )

      const row = promptRowForInput("ctx-idem", "once", 0)
      const event: RuntimeContextTargetEvent = { _tag: "Input", event: row }

      // First invocation: state advances, send dispatched.
      yield* handleRuntimeContextEvent(context, ATTEMPT, event).pipe(
        Effect.provide(baseLayer),
      )
      // Second invocation: handler reloads from the durable row, sees the
      // event has already been processed (seq <= lastProcessedInputSequence),
      // and returns without dispatching or mutating.
      yield* handleRuntimeContextEvent(context, ATTEMPT, event).pipe(
        Effect.provide(baseLayer),
      )

      const sent = yield* Ref.get(session.sent)
      expect(sent).toHaveLength(1)
      const store = yield* Effect.provide(
        Effect.flatMap(RuntimeContextStateStore, s => s.load(context, ATTEMPT)),
        baseLayer,
      )
      expect(store.lastProcessedInputSequence).toBe(0)
    }))
  })

  it("runs a tool and forwards the result through the session-command seam on a ToolUse output", async () => {
    await run(Effect.gen(function*() {
      const context = contextFor("ctx-tool", "stdio-jsonl")
      const session = yield* makeRecordingSession()
      const executor = yield* makeRecordingExecutor()
      const baseLayer = Layer.mergeAll(
        stateStoreLayer(),
        session.layer,
        executor.layer,
      )

      const observation = toolUseOutputObservation("ctx-tool", 1, "tu-1", "echo")
      const event: RuntimeContextTargetEvent = { _tag: "Output", event: observation }

      yield* handleRuntimeContextEvent(context, ATTEMPT, event).pipe(
        Effect.provide(baseLayer),
      )

      expect(yield* Ref.get(executor.calls)).toBe(1)
      const sent = yield* Ref.get(session.sent)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.command.event._tag).toBe("ToolResult")
      expect(sent[0]?.command.commandId).toBe(`tool-ctx-tool-${ATTEMPT}-tu-1`)

      // Output cursor advanced to the observation's sequence.
      const store = yield* Effect.provide(
        Effect.flatMap(RuntimeContextStateStore, s => s.load(context, ATTEMPT)),
        baseLayer,
      )
      expect(store.lastProcessedOutputSequence).toBe(1)
    }))
  })
})
