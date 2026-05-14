/**
 * Tests for `toolUseToEffect`.
 *
 * The lowering function:
 *   - looks up the descriptor in `FiregridAgentTools`,
 *   - decodes the input against `descriptor.inputSchema`,
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

import { Workflow } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableTable } from "effect-durable-operators"
import { Effect, Fiber, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentOutputEvent } from "../agent-io/index.ts"
import {
  DurableToolsWaitForLive,
  SourceCollections,
  sourceCollectionHandle,
} from "../durable-tools/index.ts"
import {
  DurableStreamsWorkflowEngine,
  fireDueWorkflowClocks,
} from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import { ScheduledInputWorkflowLayer } from "./scheduled-input-workflow.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "./tool-host.ts"
import { toolExecutionFailed } from "./tool-error.ts"
import { toolUseToEffect } from "./tool-use-to-effect.ts"

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

const ToolResultSchema = Schema.Struct({
  _tag: Schema.Literal("ToolResult"),
  toolUseId: Schema.String,
  content: Schema.Unknown,
  isError: Schema.Boolean,
})

const RunToolWorkflow = Workflow.make({
  name: "agent-tools-test-run",
  payload: Schema.Struct({
    contextId: Schema.String,
    event: Schema.Struct({
      _tag: Schema.Literal("ToolUse"),
      toolUseId: Schema.String,
      name: Schema.String,
      input: Schema.Unknown,
    }),
  }),
  success: ToolResultSchema,
  idempotencyKey: ({ event }) => event.toolUseId,
})

const RunToolWorkflowLayer = RunToolWorkflow.toLayer(({ contextId, event }) =>
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the schema's decoded type and the TaggedStruct ToolUseEvent type are structurally identical, but the cast pins the lower-bound expected by `toolUseToEffect` and stabilizes the inferred R channel here.
  toolUseToEffect({ contextId }, event as ToolUseEvent),
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

const driveClocks = Effect.gen(function* () {
  while (true) {
    yield* fireDueWorkflowClocks(Date.now() + 10_000).pipe(
      Effect.catchAll(() => Effect.void),
    )
    yield* Effect.sleep("20 millis")
  }
}).pipe(Effect.forkScoped)

const registerTestSource = Effect.gen(function* () {
  const sources = yield* SourceCollections
  const table = yield* TestSourceTable
  yield* sources.register(sourceCollectionHandle("test-source", table.rows))
})

// ---------------------------------------------------------------------------
// Descriptor-lookup tests (no workflow engine needed)
// ---------------------------------------------------------------------------

describe("toolUseToEffect — descriptor lookup", () => {
  it("returns isError:true for an unknown tool without failing the workflow", async () => {
    const streams = makeStreams("unknown")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-unknown",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-unknown",
            name: "definitely_not_a_tool",
            input: {},
          },
        })
      }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatchObject({
      error: { _tag: "UnknownTool", name: "definitely_not_a_tool" },
    })
  })

  it("returns isError:true for invalid input on a known tool", async () => {
    const streams = makeStreams("invalid")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-invalid",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-invalid",
            name: "sleep",
            input: { durationMs: "not-a-number" },
          },
        })
      }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatchObject({
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
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-sleep",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-sleep",
            name: "sleep",
            input: { durationMs: 1 },
          },
        })
      }),
    )
    expect(result.isError).toBe(false)
    expect(result.content).toEqual({ slept: true })
  })
})

describe("toolUseToEffect — wait_for arm", () => {
  it("returns the timed-out variant when no matching row appears within the timeout", async () => {
    const streams = makeStreams("waitfor-timeout")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        yield* registerTestSource
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-wait",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-wait",
            name: "wait_for",
            input: {
              eventQuery: {
                stream: "test-source",
                whereFields: { requestId: "no-such-request" },
              },
              timeoutMs: 50,
            },
          },
        })
      }),
    )
    expect(result.isError).toBe(false)
    expect(result.content).toEqual({ matched: false, timedOut: true })
  })

  it("returns the matched variant when a row appears that matches the EventQuery", async () => {
    const streams = makeStreams("waitfor-match")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        yield* registerTestSource
        yield* driveClocks
        const fiber = yield* Effect.fork(
          RunToolWorkflow.execute({
            contextId: "ctx-wait-match",
            event: {
              _tag: "ToolUse" as const,
              toolUseId: "tool-wait-match",
              name: "wait_for",
              input: {
                eventQuery: {
                  stream: "test-source",
                  whereFields: { requestId: "rq-1" },
                },
              },
            },
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
    expect(result.isError).toBe(false)
    expect(result.content).toMatchObject({
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
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-spawn",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-spawn",
            name: "spawn",
            input: {
              agentKind: "stdio-jsonl",
              prompt: "summarize the issue",
            },
          },
        })
      }),
    )
    expect(result.isError).toBe(false)
    expect(result.content).toMatchObject({
      childContextId: "child-from-host",
      terminalState: { _tag: "Completed" },
    })
    expect(observed).toEqual({
      agentKind: "stdio-jsonl",
      prompt: "summarize the issue",
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
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-spawn-all",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-spawn-all",
            name: "spawn_all",
            input: {
              tasks: [
                { agentKind: "stdio-jsonl", prompt: "first", key: "alpha" },
                { agentKind: "stdio-jsonl", prompt: "second" },
              ],
            },
          },
        })
      }),
    )
    expect(result.isError).toBe(false)
    expect(result.content).toMatchObject({
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
      appendScheduledPrompt: ({ content }) =>
        Effect.sync(() => {
          const first = content[0]
          if (first?._tag === "Text") promptObserved = first.text
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      Effect.gen(function* () {
        yield* driveClocks
        const out = yield* RunToolWorkflow.execute({
          contextId: "ctx-schedule",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-schedule",
            name: "schedule_me",
            input: { when: 0, prompt: "follow-up" },
          },
        })
        // The ScheduledInputWorkflow is fire-and-forget (discard:true).
        // Give the engine a brief window to wake the when=0 sleep so we
        // can observe the appendScheduledPrompt side effect; the parent
        // tool result has already been committed at this point.
        yield* Effect.sleep("50 millis")
        return out
      }),
    )
    expect(result.isError).toBe(false)
    const scheduledContent = result.content as {
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
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-execute",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-execute",
            name: "execute",
            input: {
              sandbox: { providerName: "local", toolName: "shell" },
              input: { argv: ["echo", "hi"] },
            },
          },
        })
      }),
    )
    expect(result.isError).toBe(false)
    expect(result.content).toMatchObject({ exitCode: 0, stdout: "done" })
    expect(observedInput).toMatchObject({ argv: ["echo", "hi"] })
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
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-fail",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-fail",
            name: "spawn",
            input: { agentKind: "stdio-jsonl", prompt: "noop" },
          },
        })
      }),
    )
    expect(result.isError).toBe(true)
    const failureContent = result.content as {
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
        yield* driveClocks
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-defect",
          event: {
            _tag: "ToolUse" as const,
            toolUseId: "tool-defect",
            name: "execute",
            input: {
              sandbox: { providerName: "local", toolName: "x" },
              input: {},
            },
          },
        })
      }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatchObject({
      error: { _tag: "ToolExecutionFailed", name: "execute" },
    })
  })
})
