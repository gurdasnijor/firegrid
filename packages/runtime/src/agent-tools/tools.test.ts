/**
 * Tests for `tools.ts` — the canonical Effect AI `Tool` values, the
 * `FiregridAgentToolkit` allowlist, and the toolkit handler that
 * routes through `toolUseToEffect`.
 *
 * Spec: docs/proposals/SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"V0 Validation"
 *
 * Covers:
 *   1. `FiregridAgentToolkit.tools` exposes the canonical public tools.
 *   2. Each Tool's parameter schema decodes identically to the
 *      `@firegrid/protocol/agent-tools` Effect Schema — no parallel
 *      parameter shape lives in this module.
 *   3. Direct toolkit execution of `sleep` runs through
 *      `toolUseToEffect` and returns the typed success.
 *   4. Malformed `sleep` input is rejected at the toolkit / Schema
 *      boundary before the common handler requests its first
 *      dependency (`IdGenerator.generateId`).
 *   5. A known tool-arm failure becomes a `FiregridMcpToolFailure`,
 *      not a workflow failure.
 *   6. `@effect/ai/McpServer.registerToolkit(FiregridAgentToolkit)`
 *      composes as an Effect (no custom JSON-RPC stack, no
 *      hand-written request handlers, no Firegrid toolkit wrapper).
 */

import { IdGenerator, McpServer } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  SessionNewToolInputSchema,
  SleepToolInputSchema,
} from "@firegrid/protocol/agent-tools"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { DurableToolsWaitForLive } from "../durable-tools/index.ts"
import { DurableStreamsWorkflowEngine } from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import { ScheduledInputWorkflowLayer } from "./scheduled-input-workflow.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "./tool-host.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
  SleepTool,
  ToolCallWorkflowLayer,
} from "./tools.ts"

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
}

const makeStreams = (label: string): Streams => {
  if (!baseUrl) throw new Error("server not started")
  const id = crypto.randomUUID()
  return {
    workflowUrl: `${baseUrl}/v1/stream/tools-${label}-workflow-${id}`,
    waitForUrl: `${baseUrl}/v1/stream/tools-${label}-waitfor-${id}`,
  }
}

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
  cancelSession: () => Effect.fail({
    _tag: "ToolExecutionFailed",
    toolUseId: "stub",
    name: "session_cancel",
    message: "session_cancel is not available in this test host",
  }),
  closeSession: () => Effect.fail({
    _tag: "ToolExecutionFailed",
    toolUseId: "stub",
    name: "session_close",
    message: "session_close is not available in this test host",
  }),
  appendScheduledPrompt: () => Effect.void,
  ...overrides,
})

const buildBridgeLayer = (
  streams: Streams,
  options: {
    readonly contextId: string
    readonly host?: AgentToolHostService
    readonly idGenerator?: IdGenerator.Service
  },
): Layer.Layer<never, unknown, never> => {
  const composed = FiregridAgentToolkitLayer.pipe(
    Layer.provideMerge(ToolCallWorkflowLayer),
    Layer.provideMerge(ScheduledInputWorkflowLayer),
    Layer.provideMerge(
      FiregridAgentToolContext.layer({ contextId: options.contextId }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        IdGenerator.IdGenerator,
        options.idGenerator ?? IdGenerator.defaultIdGenerator,
      ),
    ),
    Layer.provideMerge(
      AgentToolHost.layer(options.host ?? fakeHost()),
    ),
    Layer.provideMerge(
      DurableToolsWaitForLive({ streamUrl: streams.waitForUrl }),
    ),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflowUrl,
    }) as Layer.Layer<never, unknown, unknown>),
  )
  return composed as unknown as Layer.Layer<never, unknown, never>
}

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


// ---------------------------------------------------------------------------
// 1. Toolkit shape
// ---------------------------------------------------------------------------

describe("FiregridAgentToolkit", () => {
  it("firegrid-factory-aligned-agent-tools.SESSION.6 exposes the session-plane tool catalog", () => {
    expect(Object.keys(FiregridAgentToolkit.tools).sort()).toEqual(
      [
        "execute",
        "schedule_me",
        "session_cancel",
        "session_close",
        "session_new",
        "session_prompt",
        "sleep",
        "wait_for",
      ],
    )
  })

  it("Tool.parametersSchema decodes identically to the @firegrid/protocol input schema (no parallel parameter shape)", async () => {
    const sleepInput = { durationMs: 100 }
    const decodedViaTool = await Effect.runPromise(
      Schema.decodeUnknown(SleepTool.parametersSchema)(sleepInput),
    )
    const decodedViaProtocol = await Effect.runPromise(
      Schema.decodeUnknown(SleepToolInputSchema)(sleepInput),
    )
    expect(decodedViaTool).toEqual(decodedViaProtocol)
  })

  it("Tool.parametersSchema for session_new round-trips the protocol shape including optional fields", async () => {
    const sessionInput = {
      agentKind: "stdio-jsonl",
      prompt: "summarize",
      options: { cwd: "/tmp", metadata: { trace: "1" } },
    }
    const decodedViaTool = await Effect.runPromise(
      Schema.decodeUnknown(
        FiregridAgentToolkit.tools.session_new.parametersSchema,
      )(sessionInput),
    )
    const decodedViaProtocol = await Effect.runPromise(
      Schema.decodeUnknown(SessionNewToolInputSchema)(sessionInput),
    )
    expect(decodedViaTool).toEqual(decodedViaProtocol)
  })
})

// JSON Schema projection is exercised end-to-end in the V1 MCP HTTP
// smoke; the V0 binding test above (`parametersSchema decodes
// identically to the @firegrid/protocol schema`) already proves the
// schema is bound from the canonical source, and asserting that
// `effect/JSONSchema` produces a JSON Schema would be testing Effect
// rather than this module.

// ---------------------------------------------------------------------------
// Direct toolkit execution of sleep
// ---------------------------------------------------------------------------

describe("FiregridAgentToolkit direct handler execution", () => {
  it("runs sleep through toolUseToEffect and returns { slept: true }", async () => {
    const streams = makeStreams("sleep")
    const result = await runWith(
      buildBridgeLayer(streams, { contextId: "ctx-toolkit-sleep" }),
      Effect.gen(function* () {
        const built = yield* FiregridAgentToolkit
        return yield* built.handle("sleep", { durationMs: 1 })
      }),
    )
    expect(result.isFailure).toBe(false)
    expect(result.result).toEqual({ slept: true })
    expect(result.encodedResult).toEqual({ slept: true })
  })
})

// ---------------------------------------------------------------------------
// 4. Malformed input rejected at the toolkit schema boundary
// ---------------------------------------------------------------------------

describe("FiregridAgentToolkit schema validation", () => {
  it("rejects malformed sleep params at the Toolkit decode boundary, before the handler requests IdGenerator", async () => {
    const streams = makeStreams("invalid")
    // The common handler (`handleTool` in tools.ts) does
    // `yield* IdGenerator.IdGenerator` as its first observable side
    // effect. If the toolkit boundary correctly rejects malformed
    // input via `Schema.decodeUnknown(parametersSchema)` *before* the
    // handler runs, `generateId` is never called. Spying on the
    // dependency the handler actually touches is the load-bearing
    // assertion — instrumenting `AgentToolHost.executeSandboxTool`
    // here would be vacuous (the `sleep` handler never reaches
    // AgentToolHost).
    let generateIdCalls = 0
    const instrumentedIdGenerator: IdGenerator.Service = {
      generateId: () =>
        Effect.sync(() => {
          generateIdCalls += 1
          return "test-id"
        }),
    }
    const failure = await runWith(
      buildBridgeLayer(streams, {
        contextId: "ctx-toolkit-invalid",
        idGenerator: instrumentedIdGenerator,
      }),
      Effect.gen(function* () {
        const built = yield* FiregridAgentToolkit
        return yield* built.handle("sleep", {
          durationMs: "not-a-number",
        } as never)
      }).pipe(Effect.flip),
    )
    expect(generateIdCalls).toBe(0)
    // Effect AI's toolkit boundary returns a MalformedOutput-style
    // umbrella error for parameter/result validation failures.
    expect(failure).toBeDefined()
    const failureText =
      (failure as { readonly message?: unknown }).message !== undefined
        ? String((failure as { readonly message: unknown }).message)
        : JSON.stringify(failure)
    expect(failureText).toMatch(/Toolkit|tool call parameters|sleep/)
  })
})

// ---------------------------------------------------------------------------
// 5. Tool-arm failure → MCP tool error (not workflow failure)
// ---------------------------------------------------------------------------

describe("FiregridAgentToolkit failure mapping", () => {
  it("maps a tool-arm failure to FiregridMcpToolFailure via the handler error channel", async () => {
    const streams = makeStreams("arm-failure")
    const host = fakeHost({
      spawnChildContext: () =>
        Effect.fail({
          _tag: "ToolExecutionFailed",
          toolUseId: "stub",
          name: "session_new",
          message: "child workflow exploded",
        }),
    })
    const failure = await runWith(
      buildBridgeLayer(streams, {
        contextId: "ctx-toolkit-arm-failure",
        host,
      }),
      Effect.gen(function* () {
        const built = yield* FiregridAgentToolkit
        return yield* built.handle("session_new", {
          agentKind: "stdio-jsonl",
          prompt: "noop",
        })
      }).pipe(Effect.flip),
    )
    expect(failure).toMatchObject({
      _tag: "ToolExecutionFailed",
      name: "session_new",
    })
  })

  it("the toolkit handler does not fail the surrounding workflow on tool failure", async () => {
    const streams = makeStreams("isolated-failure")
    const host = fakeHost({
      spawnChildContext: () =>
        Effect.fail({
          _tag: "ToolExecutionFailed",
          toolUseId: "stub",
          name: "session_new",
          message: "boom",
        }),
    })
    const outcome = await runWith(
      buildBridgeLayer(streams, {
        contextId: "ctx-toolkit-isolated-failure",
        host,
      }),
      Effect.gen(function* () {
        const built = yield* FiregridAgentToolkit
        return yield* built
          .handle("session_new", { agentKind: "stdio-jsonl", prompt: "noop" })
          .pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed("caught" as const),
              onSuccess: () => Effect.succeed("succeeded" as const),
            }),
          )
      }),
    )
    expect(outcome).toBe("caught")
  })
})

// ---------------------------------------------------------------------------
// 6. MCP registration uses McpServer.registerToolkit directly
// ---------------------------------------------------------------------------

describe("FiregridAgentToolkit MCP registration", () => {
  it("composes with McpServer.registerToolkit without a custom JSON-RPC stack", () => {
    // The registerToolkit Effect is the canonical entrypoint. We only
    // need to typecheck and shape-check that it accepts the toolkit
    // as-is — no parallel registry, no hand-written tools/list or
    // tools/call handlers. Building the Effect proves the toolkit is
    // shape-compatible with `@effect/ai/McpServer` without standing up
    // a full HTTP server in unit tests.
    const registrationEffect = McpServer.registerToolkit(FiregridAgentToolkit)
    expect(Effect.isEffect(registrationEffect)).toBe(true)
  })

})
