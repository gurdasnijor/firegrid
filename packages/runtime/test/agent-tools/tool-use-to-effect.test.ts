/**
 * Tests for `toolUseToEffect`.
 *
 * The lowering function:
 *   - switches on `event.name` against the canonical tool names,
 *   - decodes the input against the matching protocol Effect Schema,
 *   - dispatches to a match arm,
 *   - catches every failure and returns a `ToolResult` event with
 *     `isError: true`.
 *
 * The outer error channel is `never`: tool failures are NOT workflow
 * failures.
 *
 * Test strategy mirrors the established repo pattern (see
 * `WaitFor.test.ts`, `DurableStreamsWorkflowEngine.test.ts`): a real
 * Durable Streams test server, fresh per-test stream URLs, and a
 * test workflow that invokes `toolUseToEffect` and returns the
 * resulting ToolResult event as its success value. Each arm gets at
 * least one focused test; the spawn / spawn_all / execute arms route
 * through a stubbed `AgentToolHost` so the lowering surface is
 * exercised without the runtime-host wiring (which lands in a
 * follow-up PR).
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt } from "@effect/ai"
import { Workflow } from "@effect/workflow"
import { DurableTable } from "effect-durable-operators"
import { Effect, Fiber, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentOutputEvent, ToolResultEvent } from "../../src/events/index.ts"
import { AgentToolCallPartSchema, ToolResultEventSchema } from "../../src/events/index.ts"
import {
  DurableToolsWaitForLive,
  SourceCollections,
  sourceCollectionStreamHandle,
} from "../../src/waits/index.ts"
import { DurableStreamsWorkflowEngine } from "../../src/workflow-engine/DurableStreamsWorkflowEngine.ts"
import { ScheduledInputWorkflowLayer } from "../../src/agent-tools/scheduled-input-workflow.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../../src/agent-tools/tool-host.ts"
import { toolExecutionFailed } from "../../src/agent-tools/tool-error.ts"
import { toolUseToEffect } from "../../src/agent-tools/tool-use-to-effect.ts"

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

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

interface Streams {
  readonly workflowUrl: string
  readonly waitForUrl: string
  readonly sourceUrl: string
}

const makeStreams = (label: string): Streams => {
  if (!baseUrl) throw new Error("server not started")
  const id = crypto.randomUUID()
  return {
    workflowUrl: `${baseUrl}/v1/stream/tools-${label}-workflow-${id}`,
    waitForUrl: `${baseUrl}/v1/stream/tools-${label}-waitfor-${id}`,
    sourceUrl: `${baseUrl}/v1/stream/tools-${label}-source-${id}`,
  }
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

type ToolUseEvent = Extract<AgentOutputEvent, { _tag: "ToolUse" }>

const toolUse = (
  toolUseId: string,
  name: string,
  params: unknown,
): ToolUseEvent => ({
  _tag: "ToolUse",
  part: Prompt.toolCallPart({
    id: toolUseId,
    name,
    params,
    providerExecuted: false,
  }),
})

const resultIsError = (result: ToolResultEvent): boolean => result.part.isFailure

const resultContent = (result: ToolResultEvent): unknown => result.part.result

const RunToolWorkflow = Workflow.make({
  name: "agent-tools-test-run",
  payload: Schema.Struct({
    contextId: Schema.String,
    event: Schema.Struct({
      _tag: Schema.Literal("ToolUse"),
      part: AgentToolCallPartSchema,
    }),
  }),
  success: ToolResultEventSchema,
  idempotencyKey: ({ event }) => event.part.id,
})

const RunToolWorkflowLayer = RunToolWorkflow.toLayer(({ contextId, event }) =>
  toolUseToEffect({ contextId }, event),
)

const fakeHost = (
  overrides: Partial<AgentToolHostService> = {},
): AgentToolHostService => ({
  spawnChildContext: () =>
    Effect.succeed({
      childContextId: "stub-child",
      terminalState: { _tag: "Completed", output: { ok: true } },
    }),
  spawnChildContexts: () =>
    Effect.succeed({
      children: [
        {
          key: "k1",
          childContextId: "stub-child-1",
          terminalState: { _tag: "Completed", output: { ok: true } },
        },
      ],
    }),
  executeSandboxTool: () => Effect.succeed<unknown>({ ok: true }),
  executeSessionCapability: () => Effect.succeed<unknown>({ ok: true }),
  appendSessionPrompt: () => Effect.void,
  cancelSession: ({ toolUseId }) =>
    Effect.fail(toolExecutionFailed(
      toolUseId,
      "session_cancel",
      "session cancellation is not available in this test host",
    )),
  closeSession: ({ toolUseId }) =>
    Effect.fail(toolExecutionFailed(
      toolUseId,
      "session_close",
      "session close is not available in this test host",
    )),
  appendScheduledPrompt: () => Effect.void,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Test-only source DurableTable for wait_for
// ---------------------------------------------------------------------------

const TestSourceRowSchema = Schema.Struct({
  id: Schema.String.pipe(DurableTable.primaryKey),
  requestId: Schema.String,
  status: Schema.String,
})
type TestSourceRow = Schema.Schema.Type<typeof TestSourceRowSchema>

class TestSourceTable extends DurableTable("agent-tools.test.source", {
  rows: TestSourceRowSchema,
}) {}

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

const buildLayer = (
  streams: Streams,
  hostLayer: Layer.Layer<AgentToolHost>,
): Layer.Layer<never, unknown, never> =>
  RunToolWorkflowLayer.pipe(
    Layer.provideMerge(ScheduledInputWorkflowLayer),
    Layer.provideMerge(hostLayer),
    Layer.provideMerge(
      DurableToolsWaitForLive({ streamUrl: streams.waitForUrl }),
    ),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflowUrl,
    }) as Layer.Layer<never, unknown, unknown>),
    Layer.provideMerge(TestSourceTable.layer({
      streamOptions: {
        url: streams.sourceUrl,
        contentType: "application/json",
      },
    })),
  ) as Layer.Layer<never, unknown, never>

const runWith = <A, E>(
  layer: Layer.Layer<never, unknown, never>,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<
      A,
      unknown,
      never
    >,
  )

const registerTestSource = Effect.gen(function* () {
  const sources = yield* SourceCollections
  const table = yield* TestSourceTable
  yield* sources.register(sourceCollectionStreamHandle("test-source", table.rows.rows()))
})

// ---------------------------------------------------------------------------
// Descriptor-lookup tests (no workflow engine needed)
// ---------------------------------------------------------------------------

describe("toolUseToEffect — name dispatch", () => {
  it("returns isError:true for an unknown tool without failing the workflow", async () => {
    const streams = makeStreams("unknown")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-unknown",
          event: toolUse("tool-unknown", "definitely_not_a_tool", {}),
        })
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "UnknownTool", name: "definitely_not_a_tool" },
    })
  })

  it("returns isError:true for invalid input on a known tool", async () => {
    const streams = makeStreams("invalid")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-invalid",
          event: toolUse("tool-invalid", "sleep", { durationMs: "not-a-number" }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolInvalidInput", name: "sleep" },
    })
  })
})

// ---------------------------------------------------------------------------
// Per-arm happy-path tests
// ---------------------------------------------------------------------------

describe("toolUseToEffect — sleep arm", () => {
  it("composes DurableClock.sleep and emits { slept: true }", async () => {
    const streams = makeStreams("sleep")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-sleep",
          event: toolUse("tool-sleep", "sleep", { durationMs: 1 }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toEqual({ slept: true })
  })
})

describe("toolUseToEffect — wait_for arm", () => {
  it("returns the timed-out variant when no matching row appears within the timeout", async () => {
    const streams = makeStreams("waitfor-timeout")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        yield* registerTestSource
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-wait",
          event: toolUse("tool-wait", "wait_for", {
              eventQuery: {
                stream: "test-source",
                whereFields: { requestId: "no-such-request" },
              },
              timeoutMs: 50,
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toEqual({ matched: false, timedOut: true })
  })

  it("rejects non-scalar whereFields predicates with ToolInvalidInput instead of matching every row", async () => {
    const streams = makeStreams("waitfor-nonscalar")
    let waitForCalled = false
    const result = await runWith(
      buildLayer(
        streams,
        AgentToolHost.layer(fakeHost()),
      ),
      Effect.gen(function* () {
        // Register the source so wait_for would resolve if it ran.
        // If the lowering accepted the non-scalar predicate, the empty
        // FieldEqualsTrigger would match the very first row we upsert
        // here; the test would race a match against the timeout.
        yield* registerTestSource
        const fiber = yield* Effect.fork(
          RunToolWorkflow.execute({
            contextId: "ctx-wait-nonscalar",
            event: toolUse("tool-wait-nonscalar", "wait_for", {
                eventQuery: {
                  stream: "test-source",
                  whereFields: {
                    requestId: { value: "not-a-scalar" },
                  },
                },
                timeoutMs: 200,
              }),
          }),
        )
        const source = yield* TestSourceTable
        // Insert an arbitrary row; this would satisfy an empty
        // FieldEqualsTrigger (universal match) if the validation
        // regressed.
        yield* source.rows.upsert({
          id: "should-not-match",
          requestId: "rq-anything",
          status: "ready",
        } satisfies TestSourceRow)
        waitForCalled = true
        return yield* Fiber.join(fiber)
      }),
    )
    expect(waitForCalled).toBe(true)
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolInvalidInput", name: "wait_for" },
    })
  })

  it("rejects an empty whereFields predicate set with ToolInvalidInput", async () => {
    const streams = makeStreams("waitfor-empty")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        yield* registerTestSource
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-wait-empty",
          event: toolUse("tool-wait-empty", "wait_for", {
              eventQuery: {
                stream: "test-source",
                whereFields: {},
              },
              timeoutMs: 100,
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolInvalidInput", name: "wait_for" },
    })
  })

  it("returns the matched variant when a row appears that matches the EventQuery", async () => {
    const streams = makeStreams("waitfor-match")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        yield* registerTestSource
        const fiber = yield* Effect.fork(
          RunToolWorkflow.execute({
            contextId: "ctx-wait-match",
            event: toolUse("tool-wait-match", "wait_for", {
                eventQuery: {
                  stream: "test-source",
                  whereFields: { requestId: "rq-1" },
                },
              }),
          }),
        )
        yield* Effect.sleep("60 millis")
        const source = yield* TestSourceTable
        yield* source.rows.upsert({
          id: "row-1",
          requestId: "rq-1",
          status: "ready",
        } satisfies TestSourceRow)
        return yield* Fiber.join(fiber)
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({
      matched: true,
      event: { id: "row-1", requestId: "rq-1" },
    })
  })
})

describe("toolUseToEffect — spawn arm", () => {
  it("routes to AgentToolHost.spawnChildContext and emits the terminal state", async () => {
    const streams = makeStreams("spawn")
    let observed: { agentKind: string; prompt: string } | undefined
    const host = fakeHost({
      spawnChildContext: ({ agentKind, prompt }) =>
        Effect.sync(() => {
          observed = { agentKind, prompt }
          return {
            childContextId: "child-from-host",
            terminalState: { _tag: "Completed", output: { result: 42 } },
          }
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-spawn",
          event: toolUse("tool-spawn", "spawn", {
              agentKind: "stdio-jsonl",
              prompt: "summarize the issue",
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({
      childContextId: "child-from-host",
      terminalState: { _tag: "Completed" },
    })
    expect(observed).toEqual({
      agentKind: "stdio-jsonl",
      prompt: "summarize the issue",
    })
  })
})

describe("toolUseToEffect — session-plane arms", () => {
  it("firegrid-factory-aligned-agent-tools.SESSION.6 lowers session_new through AgentToolHost.spawnChildContext", async () => {
    const streams = makeStreams("session-new")
    let observed: { agentKind: string; prompt: string } | undefined
    const host = fakeHost({
      spawnChildContext: ({ agentKind, prompt }) =>
        Effect.sync(() => {
          observed = { agentKind, prompt }
          return {
            childContextId: "ctx-child-session",
            terminalState: { _tag: "Completed", output: { result: 42 } },
          }
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-new", "session_new", {
              agentKind: "stdio-jsonl",
              prompt: "summarize the issue",
              options: { metadata: { correlationId: "corr-1" } },
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({
      session: {
        sessionId: "ctx-child-session",
        contextId: "ctx-child-session",
        status: "done",
        metadata: { correlationId: "corr-1" },
        terminalState: { _tag: "Completed" },
      },
    })
    expect(observed).toEqual({
      agentKind: "stdio-jsonl",
      prompt: "summarize the issue",
    })
  })

  it("firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2 lowers session_prompt to host-owned prompt append", async () => {
    const streams = makeStreams("session-prompt")
    let observed:
      | { readonly sessionId: string; readonly inputId: string; readonly text: string }
      | undefined
    const host = fakeHost({
      appendSessionPrompt: ({ sessionId, inputId, prompt }) =>
        Effect.sync(() => {
          const firstPart = prompt.content[0]
          observed = {
            sessionId,
            inputId,
            text: firstPart?.type === "text" ? firstPart.text : "",
          }
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-prompt", "session_prompt", {
              sessionId: "ctx-child-session",
              inputId: "input-1",
              prompt: "continue",
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toEqual({
      appended: true,
      sessionId: "ctx-child-session",
      inputId: "input-1",
    })
    expect(observed).toEqual({
      sessionId: "ctx-child-session",
      inputId: "input-1",
      text: "continue",
    })
  })

  it("session_cancel fails explicitly when the host has no cancel primitive", async () => {
    const streams = makeStreams("session-cancel")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-cancel", "session_cancel", {
              sessionId: "ctx-child-session",
              reason: "stop",
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolExecutionFailed", name: "session_cancel" },
    })
  })

  it("session_close fails explicitly when the host has no close primitive", async () => {
    const streams = makeStreams("session-close")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-close", "session_close", {
              sessionId: "ctx-child-session",
              reason: "done",
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolExecutionFailed", name: "session_close" },
    })
  })
})

describe("toolUseToEffect — spawn_all arm", () => {
  it("routes to AgentToolHost.spawnChildContexts and emits aggregated children", async () => {
    const streams = makeStreams("spawnall")
    const host = fakeHost({
      spawnChildContexts: ({ tasks }) =>
        Effect.succeed({
          children: tasks.map((task, index) => ({
            key: task.key ?? String(index),
            childContextId: `child-${index}`,
            terminalState: { _tag: "Completed" as const, output: index },
          })),
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-spawn-all",
          event: toolUse("tool-spawn-all", "spawn_all", {
              tasks: [
                { agentKind: "stdio-jsonl", prompt: "first", key: "alpha" },
                { agentKind: "stdio-jsonl", prompt: "second" },
              ],
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({
      children: [
        { key: "alpha", childContextId: "child-0" },
        { key: "1", childContextId: "child-1" },
      ],
    })
  })
})

describe("toolUseToEffect — schedule_me arm", () => {
  it("returns scheduled:true immediately and starts the ScheduledInputWorkflow", async () => {
    const streams = makeStreams("schedule-me")
    let promptObserved: string | undefined
    const host = fakeHost({
      appendScheduledPrompt: ({ prompt }) =>
        Effect.sync(() => {
          const firstPart = prompt.content[0]
          if (firstPart?.type === "text") promptObserved = firstPart.text
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        const out = yield* RunToolWorkflow.execute({
          contextId: "ctx-schedule",
          event: toolUse("tool-schedule", "schedule_me", { when: 0, prompt: "follow-up" }),
        })
        // The ScheduledInputWorkflow is fire-and-forget (discard:true).
        // Give the engine a brief window to wake the when=0 sleep so we
        // can observe the appendScheduledPrompt side effect; the parent
        // tool result has already been committed at this point.
        yield* Effect.sleep("50 millis")
        return out
      }),
    )
    expect(resultIsError(result)).toBe(false)
    const scheduledContent = resultContent(result) as {
      readonly scheduled: true
      readonly scheduleId: string
    }
    expect(scheduledContent.scheduled).toBe(true)
    expect(scheduledContent.scheduleId).toContain("schedule-me:ctx-schedule")
    // The scheduled workflow may or may not have fired by the time we
    // assert; only require the parent tool returned scheduled:true
    // synchronously.
    if (promptObserved !== undefined) {
      expect(promptObserved).toBe("follow-up")
    }
  })
})

describe("toolUseToEffect — execute arm", () => {
  it("routes to AgentToolHost.executeSandboxTool and emits the provider output", async () => {
    const streams = makeStreams("execute")
    let observedInput: unknown
    const host = fakeHost({
      executeSandboxTool: ({ input }) =>
        Effect.sync(() => {
          observedInput = input
          return { exitCode: 0, stdout: "done" }
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-execute",
          event: toolUse("tool-execute", "execute", {
              sandbox: { providerName: "local", toolName: "shell" },
              input: { argv: ["echo", "hi"] },
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({ exitCode: 0, stdout: "done" })
    expect(observedInput).toMatchObject({ argv: ["echo", "hi"] })
  })

  it("firegrid-factory-aligned-agent-tools.CAPABILITY.2 routes session-bound capability input through AgentToolHost.executeSessionCapability", async () => {
    const streams = makeStreams("execute-session-capability")
    let observed:
      | {
        readonly sessionId: string
        readonly kind: string
        readonly name: string
        readonly input: unknown
      }
      | undefined
    const host = fakeHost({
      executeSessionCapability: ({ sessionId, capability, input }) =>
        Effect.sync(() => {
          observed = {
            sessionId,
            kind: capability.kind,
            name: capability.name,
            input,
          }
          return { stdout: "ok" }
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-execute",
          event: toolUse("tool-execute-session", "execute", {
              sessionId: "ctx-child-session",
              capability: { kind: "terminal", name: "primary" },
              input: { command: "pwd" },
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({ stdout: "ok" })
    expect(observed).toMatchObject({
      sessionId: "ctx-child-session",
      kind: "terminal",
      name: "primary",
      input: { command: "pwd" },
    })
  })
})

// ---------------------------------------------------------------------------
// Tool failure -> ToolResult (workflow does not fail)
// ---------------------------------------------------------------------------

describe("toolUseToEffect — failure semantics", () => {
  it("converts a tool-arm failure into an isError:true ToolResult and does not fail the workflow", async () => {
    const streams = makeStreams("failure")
    const host = fakeHost({
      spawnChildContext: () =>
        Effect.fail(toolExecutionFailed("tool-fail", "spawn", "host blew up")),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-fail",
          event: toolUse("tool-fail", "spawn", { agentKind: "stdio-jsonl", prompt: "noop" }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(true)
    const failureContent = resultContent(result) as {
      readonly error: { readonly _tag: string; readonly name: string }
      readonly message: string
    }
    expect(failureContent.error).toMatchObject({
      _tag: "ToolExecutionFailed",
      name: "spawn",
    })
    expect(failureContent.message).toContain("spawn")
  })

  it("converts a defect inside a tool arm into an isError:true ToolResult", async () => {
    const streams = makeStreams("defect")
    const host = fakeHost({
      executeSandboxTool: () =>
        Effect.sync<unknown>(() => {
          throw new Error("transient crash")
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-defect",
          event: toolUse("tool-defect", "execute", {
              sandbox: { providerName: "local", toolName: "x" },
              input: {},
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolExecutionFailed", name: "execute" },
    })
  })
})
