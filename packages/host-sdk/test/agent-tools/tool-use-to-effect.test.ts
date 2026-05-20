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
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentOutputEvent, ToolResultEvent } from "@firegrid/runtime/events"
import { AgentToolCallPartSchema, ToolResultEventSchema } from "@firegrid/runtime/events"
import { RuntimeObservationStreams } from "@firegrid/runtime/streams"
import { WaitForWorkflowLayer } from "@firegrid/runtime/workflows"
import {
  ChannelInventory,
  makeChannelInventory,
  makeBidirectionalChannel,
  makeIngressChannel,
  makeCallableChannel,
  makeEgressChannel,
  RuntimeAgentToolExecutionLive,
  type ChannelRegistration,
} from "../../src/host/index.ts"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../../src/agent-tools/execution/tool-host.ts"
import { toolExecutionFailed } from "../../src/agent-tools/bindings/tool-error.ts"
import { toolUseToEffect } from "../../src/agent-tools/execution/tool-use-to-effect.ts"

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
  readonly sourceUrl: string
}

const makeStreams = (label: string): Streams => {
  if (!baseUrl) throw new Error("server not started")
  const id = crypto.randomUUID()
  return {
    workflowUrl: `${baseUrl}/v1/stream/tools-${label}-workflow-${id}`,
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

const crashEffect = <A = never>(message: string): Effect.Effect<A, never> =>
  Effect.try(() => {
    throw new Error(message)
  }).pipe(Effect.orDie)

const RunToolWorkflow = Workflow.make({
  name: "agent-tools-test-run",
  payload: Schema.Struct({
    contextId: Schema.String,
    event: Schema.TaggedStruct("ToolUse", {
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
  callApprovalChannel: () =>
    Effect.succeed({
      matched: false,
      timedOut: true,
    }),
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

const TEST_EVENTS_CHANNEL = "factory.events"

const TestChannelInventoryLive = (
  channels: Iterable<ChannelRegistration> = [],
) => Layer.effect(
  ChannelInventory,
  Effect.gen(function* () {
    const table = yield* TestSourceTable
    const factoryEvents = makeIngressChannel({
      target: TEST_EVENTS_CHANNEL,
      schema: TestSourceRowSchema,
      stream: table.rows.rows(),
    })
    return makeChannelInventory([factoryEvents, ...channels])
  }),
)

const TestRuntimeObservationStreamsLive = Layer.effect(
  RuntimeObservationStreams,
  Effect.gen(function*() {
    const table = yield* TestSourceTable
    return {
      agentOutput: Stream.empty,
      agentOutputAfter: () => Stream.empty,
      initialAgentOutputAfter: () => Effect.succeed(Option.none()),
      agentOutputForContext: () => Stream.empty,
      runtimeRun: Stream.empty,
      callerFact: (stream: string) =>
        stream === TEST_EVENTS_CHANNEL ? table.rows.rows() : Stream.empty,
    }
  }),
)

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

// TFIND-031: the prior `as Layer<never, unknown, never>` mask collapsed
// this fully-closed test layer's real type while `DurableTable.layer`
// leaked `any`. With precise typing the composition genuinely satisfies
// every requirement (RIn = never); it just also re-exposes the durable
// substrate tags it materialises (ROut ≠ never). Let the real type flow
// instead of forcing it.
const buildLayer = (
  streams: Streams,
  hostLayer: Layer.Layer<AgentToolHost>,
  channels: Iterable<ChannelRegistration> = [],
) => {
  return RunToolWorkflowLayer.pipe(
    Layer.provideMerge(RuntimeAgentToolExecutionLive),
    Layer.provideMerge(WaitForWorkflowLayer),
    Layer.provideMerge(TestRuntimeObservationStreamsLive),
    Layer.provideMerge(hostLayer),
    Layer.provideMerge(TestChannelInventoryLive(channels)),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflowUrl,
    })),
    Layer.provideMerge(TestSourceTable.layer({
      streamOptions: {
        url: streams.sourceUrl,
        contentType: "application/json",
      },
    })),
  )
}

const runWith = <A, E, ROut>(
  layer: Layer.Layer<ROut, unknown, never>,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<
      A,
      unknown,
      never
    >,
  )

// ---------------------------------------------------------------------------
// Descriptor-lookup tests (no workflow engine needed)
// ---------------------------------------------------------------------------

describe("toolUseToEffect — name dispatch", () => {
  it("returns isError:true for an unknown tool without failing the workflow", async () => {
    const streams = makeStreams("unknown")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      RunToolWorkflow.execute({
          contextId: "ctx-unknown",
          event: toolUse("tool-unknown", "definitely_not_a_tool", {}),
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
      RunToolWorkflow.execute({
          contextId: "ctx-invalid",
          event: toolUse("tool-invalid", "sleep", { durationMs: "not-a-number" }),
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
  it("firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.9 composes DurableClock.sleep and emits { slept: true }", async () => {
    const streams = makeStreams("sleep")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      RunToolWorkflow.execute({
          contextId: "ctx-sleep",
          event: toolUse("tool-sleep", "sleep", { durationMs: 1 }),
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
      RunToolWorkflow.execute({
          contextId: "ctx-wait",
          event: toolUse("tool-wait", "wait_for", {
              channel: TEST_EVENTS_CHANNEL,
              match: { requestId: "no-such-request" },
              timeoutMs: 50,
            }),
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toEqual({ matched: false, timedOut: true })
  })

  it("rejects non-scalar match predicates with ToolInvalidInput instead of matching every row", async () => {
    const streams = makeStreams("waitfor-nonscalar")
    let waitForCalled = false
    const result = await runWith(
      buildLayer(
        streams,
        AgentToolHost.layer(fakeHost()),
      ),
      Effect.gen(function* () {
        // If the lowering accepted the non-scalar predicate, the empty
        // FieldEqualsTrigger would match the very first row we upsert
        // here; the test would race a match against the timeout.
        const fiber = yield* Effect.fork(
          RunToolWorkflow.execute({
            contextId: "ctx-wait-nonscalar",
            event: toolUse("tool-wait-nonscalar", "wait_for", {
                channel: TEST_EVENTS_CHANNEL,
                match: {
                  requestId: { value: "not-a-scalar" },
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

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.4 returns the first available row for channel discovery with timeoutMs:0", async () => {
    const streams = makeStreams("waitfor-discovery")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        const source = yield* TestSourceTable
        yield* source.rows.upsert({
          id: "row-discovery",
          requestId: "rq-discovery",
          status: "seeded",
        } satisfies TestSourceRow)
        return yield* RunToolWorkflow.execute({
          contextId: "ctx-wait-discovery",
          event: toolUse("tool-wait-discovery", "wait_for", {
              channel: TEST_EVENTS_CHANNEL,
              timeoutMs: 0,
            }),
        })
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({
      matched: true,
      event: { id: "row-discovery", requestId: "rq-discovery" },
    })
  })

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.3 firegrid-agent-body-plan.WAIT_FOR_CHANNEL.5 returns the matched variant when a channel row appears", async () => {
    const streams = makeStreams("waitfor-match")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          RunToolWorkflow.execute({
            contextId: "ctx-wait-match",
            event: toolUse("tool-wait-match", "wait_for", {
                channel: TEST_EVENTS_CHANNEL,
                match: { requestId: "rq-1" },
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

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.3 rejects unknown channels with ToolInvalidInput", async () => {
    const streams = makeStreams("waitfor-unknown-channel")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      RunToolWorkflow.execute({
          contextId: "ctx-wait-unknown-channel",
          event: toolUse("tool-wait-unknown-channel", "wait_for", {
              channel: "missing.channel",
              timeoutMs: 0,
            }),
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolInvalidInput", name: "wait_for" },
    })
  })
})

const SendPayloadSchema = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
})
type SendPayload = Schema.Schema.Type<typeof SendPayloadSchema>

const CallRequestSchema = Schema.Struct({
  prompt: Schema.String,
})
type CallRequest = Schema.Schema.Type<typeof CallRequestSchema>

const CallResponseSchema = Schema.Struct({
  approved: Schema.Boolean,
})

const WaitForAnyRowSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
})

describe("toolUseToEffect — Slice D channel verb arms", () => {
  it("firegrid-agent-body-plan.SLICE_D_VERBS.2 appends decoded payloads only through egress channels", async () => {
    const streams = makeStreams("send")
    const appended: Array<SendPayload> = []
    const channel = makeEgressChannel({
      target: "notification.operator",
      schema: SendPayloadSchema,
      append: payload =>
        Effect.sync(() => {
          appended.push(payload)
        }),
    })
    const result = await runWith(
      buildLayer(
        streams,
        AgentToolHost.layer(fakeHost()),
        [channel],
      ),
      RunToolWorkflow.execute({
          contextId: "ctx-send",
          event: toolUse("tool-send", "send", {
            channel: "notification.operator",
            payload: { id: "event-1", message: "ready" },
          }),
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toEqual({
      sent: true,
      channel: "notification.operator",
    })
    expect(appended).toEqual([{ id: "event-1", message: "ready" }])
  })

  it("firegrid-agent-body-plan.SLICE_BOUNDARY.4 rejects send on an ingress channel", async () => {
    const streams = makeStreams("send-wrong-direction")
    const channel = makeIngressChannel({
      target: "state.rows",
      schema: WaitForAnyRowSchema,
      stream: Stream.empty,
    })
    const result = await runWith(
      buildLayer(
        streams,
        AgentToolHost.layer(fakeHost()),
        [channel],
      ),
      RunToolWorkflow.execute({
          contextId: "ctx-send-wrong-direction",
          event: toolUse("tool-send-wrong-direction", "send", {
            channel: "state.rows",
            payload: { id: "event-1", message: "ready" },
          }),
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolInvalidInput", name: "send" },
    })
  })

  it("firegrid-agent-body-plan.SLICE_D_VERBS.3 dispatches decoded requests through registered call channels", async () => {
    const streams = makeStreams("call")
    let observed: CallRequest | undefined
    const channel = makeCallableChannel({
      target: "operator.call",
      requestSchema: CallRequestSchema,
      responseSchema: CallResponseSchema,
      call: request =>
        Effect.sync(() => {
          observed = request
          return { approved: request.prompt === "approve" }
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost()), [channel]),
      RunToolWorkflow.execute({
          contextId: "ctx-call",
          event: toolUse("tool-call", "call", {
            channel: "operator.call",
            request: { prompt: "approve" },
          }),
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toEqual({ approved: true })
    expect(observed).toEqual({ prompt: "approve" })
  })

  it("firegrid-agent-body-plan.SLICE_D_VERBS.4 races ingress descriptors and returns the first winner", async () => {
    const streams = makeStreams("wait-for-any")
    const slow = makeIngressChannel({
      target: "state.rows",
      schema: WaitForAnyRowSchema,
      stream: Stream.never,
    })
    const fast = {
      ...makeBidirectionalChannel({
        target: "event.plan.ready",
        schema: WaitForAnyRowSchema,
        sourceClasses: ["static-source", "predicate-eligible"],
        stream: Stream.make({ id: "row-fast", status: "ready" }),
        append: () => Effect.void,
      }),
      kind: "event" as const,
      eventName: "plan.ready",
      callerFactStream: "test.events",
    }
    const result = await runWith(
      buildLayer(
        streams,
        AgentToolHost.layer(fakeHost()),
        [slow, fast],
      ),
      RunToolWorkflow.execute({
          contextId: "ctx-wait-for-any",
          event: toolUse("tool-wait-for-any", "wait_for_any", {
            channels: [
              { channel: "state.rows", match: { status: "ready" } },
              { channel: "event.plan.ready", match: { status: "ready" } },
            ],
          }),
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toEqual({
      winnerIndex: 1,
      channel: "event.plan.ready",
      result: { id: "row-fast", status: "ready" },
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
      RunToolWorkflow.execute({
          contextId: "ctx-spawn",
          event: toolUse("tool-spawn", "spawn", {
              agentKind: "stdio-jsonl",
              prompt: "summarize the issue",
            }),
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
      RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-new", "session_new", {
              agentKind: "stdio-jsonl",
              prompt: "summarize the issue",
              options: { metadata: { correlationId: "corr-1" } },
            }),
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
      RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-prompt", "session_prompt", {
              sessionId: "ctx-child-session",
              inputId: "input-1",
              prompt: "continue",
            }),
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
      RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-cancel", "session_cancel", {
              sessionId: "ctx-child-session",
              reason: "stop",
            }),
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
      RunToolWorkflow.execute({
          contextId: "ctx-parent",
          event: toolUse("tool-session-close", "session_close", {
              sessionId: "ctx-child-session",
              reason: "done",
            }),
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
      RunToolWorkflow.execute({
          contextId: "ctx-spawn-all",
          event: toolUse("tool-spawn-all", "spawn_all", {
              tasks: [
                { agentKind: "stdio-jsonl", prompt: "first", key: "alpha" },
                { agentKind: "stdio-jsonl", prompt: "second" },
              ],
            }),
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
  it("returns scheduled:true and appends through the canonical host prompt seam", async () => {
    const streams = makeStreams("schedule-me")
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
        const out = yield* RunToolWorkflow.execute({
          contextId: "ctx-schedule",
          event: toolUse("tool-schedule", "schedule_me", { when: 0, prompt: "follow-up" }),
        })
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
    expect(observed).toEqual({
      sessionId: "ctx-schedule",
      inputId: scheduledContent.scheduleId,
      text: "follow-up",
    })
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
      RunToolWorkflow.execute({
          contextId: "ctx-execute",
          event: toolUse("tool-execute", "execute", {
              sandbox: { providerName: "local", toolName: "shell" },
              input: { argv: ["echo", "hi"] },
            }),
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
      RunToolWorkflow.execute({
          contextId: "ctx-execute",
          event: toolUse("tool-execute-session", "execute", {
              sessionId: "ctx-child-session",
              capability: { kind: "terminal", name: "primary" },
              input: { command: "pwd" },
            }),
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

describe("toolUseToEffect — call approval arm", () => {
  it("firegrid-agent-body-plan.APPROVAL_CALL.1 routes approval.* calls through AgentToolHost.callApprovalChannel", async () => {
    const streams = makeStreams("call-approval")
    const host = fakeHost({
      callApprovalChannel: ({ contextId, channel, request }) =>
        Effect.succeed({
          matched: true,
          request: {
            contextId,
            activityAttempt: 1,
            sequence: 4,
            permissionRequestId: "permission-1",
            toolUseId: "tool-needing-permission",
            options: [
              {
                optionId: "allow_once",
                kind: "allow_once",
                name: "Allow once",
              },
            ],
          },
          response: {
            responded: true,
            contextId,
            permissionRequestId: "permission-1",
            inputId: `${channel}:${request.decision._tag}`,
          },
        }),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      RunToolWorkflow.execute({
          contextId: "ctx-call",
          event: toolUse("tool-call", "call", {
            channel: "approval.operator",
            request: {
              decision: { _tag: "Allow", optionId: "allow_once" },
            },
          }),
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({
      matched: true,
      response: {
        responded: true,
        contextId: "ctx-call",
        permissionRequestId: "permission-1",
        inputId: "approval.operator:Allow",
      },
    })
  })

  it("firegrid-agent-body-plan.APPROVAL_CALL.4 rejects unknown non-approval channel targets", async () => {
    const streams = makeStreams("call-non-approval")
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(fakeHost())),
      RunToolWorkflow.execute({
          contextId: "ctx-call-invalid",
          event: toolUse("tool-call-invalid", "call", {
            channel: "factory.events",
            request: {
              decision: { _tag: "Allow" },
            },
          }),
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolInvalidInput", name: "call" },
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
      RunToolWorkflow.execute({
          contextId: "ctx-fail",
          event: toolUse("tool-fail", "spawn", { agentKind: "stdio-jsonl", prompt: "noop" }),
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
        crashEffect("transient crash"),
    })
    const result = await runWith(
      buildLayer(streams, AgentToolHost.layer(host)),
      RunToolWorkflow.execute({
          contextId: "ctx-defect",
          event: toolUse("tool-defect", "execute", {
              sandbox: { providerName: "local", toolName: "x" },
              input: {},
            }),
      }),
    )
    expect(resultIsError(result)).toBe(true)
    expect(resultContent(result)).toMatchObject({
      error: { _tag: "ToolExecutionFailed", name: "execute" },
    })
  })
})

describe("toolUseToEffect — tf-e1g8 approval registration precedence", () => {
  it("firegrid-agent-body-plan.APPROVAL_CALL.4 keeps approval.* on AgentToolHost even when the channel is registered", async () => {
    const streams = makeStreams("call-approval-registered")
    let registeredCalled = false
    let hostCalled = false
    const registeredApproval = makeCallableChannel({
      target: "approval.operator",
      requestSchema: CallRequestSchema,
      responseSchema: CallResponseSchema,
      call: () =>
        Effect.sync(() => {
          registeredCalled = true
          return { approved: false }
        }),
    })
    const host = fakeHost({
      callApprovalChannel: ({ contextId, channel, request }) =>
        Effect.sync(() => {
          hostCalled = true
          return {
            matched: true,
            request: {
              contextId,
              activityAttempt: 1,
              sequence: 4,
              permissionRequestId: "permission-registered",
              toolUseId: "tool-needing-permission",
              options: [],
            },
            response: {
              responded: true,
              contextId,
              permissionRequestId: "permission-registered",
              inputId: `${channel}:${request.decision._tag}`,
            },
          } as const
        }),
    })
    const result = await runWith(
      buildLayer(
        streams,
        AgentToolHost.layer(host),
        [registeredApproval],
      ),
      RunToolWorkflow.execute({
        contextId: "ctx-call-registered",
        event: toolUse("tool-call-registered", "call", {
          channel: "approval.operator",
          request: {
            decision: { _tag: "Allow", optionId: "allow_once" },
          },
        }),
      }),
    )
    expect(resultIsError(result)).toBe(false)
    expect(resultContent(result)).toMatchObject({
      matched: true,
      response: {
        contextId: "ctx-call-registered",
        permissionRequestId: "permission-registered",
        inputId: "approval.operator:Allow",
      },
    })
    expect(hostCalled).toBe(true)
    expect(registeredCalled).toBe(false)
  })
})
