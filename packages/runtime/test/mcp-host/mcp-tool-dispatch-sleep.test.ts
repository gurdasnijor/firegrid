// tf-r06u.28 slice 2 — green sleep end-to-end through the relay-free
// MCP-entry Shape D dispatch.
//
// Proves:
//   A. `ToolDispatch.call({ toolName: "sleep" })` returns the typed output
//      `{ slept: true }` through `McpToolDispatchWorkflow` on a real
//      `DurableStreamsWorkflowEngine` — the sleep milestone.
//   B. at-most-once: a repeated `toolUseId` runs the shared arm exactly once
//      (`Workflow.idempotencyKey: toolUseId` memoization — the Shape D C3
//      mechanism; no separate result table), and the second call returns the
//      memoized result.
//   C. honest surface: a tool not yet ported fails on the typed `ToolError`
//      channel (which `@effect/ai`'s McpServer lowers to `isError:true`),
//      not a thrown defect.

import { WorkflowEngine } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Exit, Layer, Ref } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamsWorkflowEngine } from "../../src/engine/durable-streams-workflow-engine.ts"
import {
  buildMcpToolDispatchLayer,
  makeFiregridAgentToolExecutor,
  McpToolDispatchWorkflow,
  ToolDispatch,
  ToolDispatchLive,
} from "../../src/unified/mcp-host/tool-dispatch.ts"

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

const streamUrlFor = (tag: string): string =>
  `${baseUrl}/v1/stream/mcp-tool-dispatch-${tag}-${crypto.randomUUID()}`

const runWith = <A, E>(
  streamUrl: string,
  workflowLayer: Layer.Layer<never, unknown, WorkflowEngine.WorkflowEngine>,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          workflowLayer.pipe(
            Layer.provideMerge(DurableStreamsWorkflowEngine.layer({ streamUrl })),
          ),
        ),
      ),
    ) as Effect.Effect<A, unknown, never>,
  )

describe("mcp-host: relay-free MCP-entry sleep dispatch", () => {
  it("A. sleep returns the typed output { slept: true } through ToolDispatch.call", async () => {
    const result = await runWith(
      streamUrlFor("sleep"),
      ToolDispatchLive,
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        return yield* dispatch.call({
          contextId: "ctx-sleep",
          toolUseId: "tu-sleep-1",
          toolName: "sleep",
          input: { durationMs: 5 },
        })
      }),
    )
    expect(result).toEqual({ slept: true })
  })

  it("B. same toolUseId runs the arm exactly once (idempotencyKey memo)", async () => {
    // Hold the executor instance so we can read its invocation counter
    // after driving the workflow twice with the same toolUseId.
    const executor = await Effect.runPromise(makeFiregridAgentToolExecutor())
    const observed = await runWith(
      streamUrlFor("idem"),
      buildMcpToolDispatchLayer(executor),
      Effect.gen(function*() {
        const engine = yield* WorkflowEngine.WorkflowEngine
        const exec = (durationMs: number) =>
          McpToolDispatchWorkflow.execute({
            contextId: "ctx-idem",
            attempt: 1,
            toolUseId: "tu-idem-same",
            toolName: "sleep",
            inputJson: JSON.stringify({ durationMs }),
          }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
        const first = yield* exec(3)
        // Different input, same toolUseId → memoized first result.
        const second = yield* exec(99)
        const invocations = yield* Ref.get(executor.state.invocationCount)
        return { first, second, invocations }
      }),
    )
    expect(observed.invocations).toBe(1)
    expect(observed.second).toEqual(observed.first)
    expect(JSON.parse(observed.first.resultJson)).toEqual({ slept: true })
  })

  it("C. a not-yet-ported tool fails on the typed ToolError channel", async () => {
    const exit = await runWith(
      streamUrlFor("unported"),
      ToolDispatchLive,
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        return yield* dispatch.call({
          contextId: "ctx-unported",
          toolUseId: "tu-send-1",
          toolName: "send",
          input: { channel: "egress.x", payload: {} },
        })
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("not yet ported")
    }
  })
})
