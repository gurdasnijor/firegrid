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
 *   3. Direct toolkit execution requires a resolved runtime context; route-less
 *      calls fail before a fallback workflow engine is used.
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
import * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import { getFiregridProjectionMetadata } from "@firegrid/protocol/projection"
import { Effect, Layer, Option, Schema, SchemaAST } from "effect"
import { describe, expect, it } from "vitest"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../../src/agent-tools/execution/tool-host.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridPrimitiveProfileToolkit,
  SleepTool,
} from "../../src/agent-tools/bindings/tools.ts"
import {
  FiregridAgentToolkitLayer,
} from "../../src/agent-tools/execution/toolkit-layer.ts"

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
  ...overrides,
})

const buildBridgeLayer = (
  options: {
    readonly contextId: string
    readonly host?: AgentToolHostService
    readonly idGenerator?: IdGenerator.Service
  },
): Layer.Layer<never, unknown, never> => {
  const composed = FiregridAgentToolkitLayer.pipe(
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
        "call",
        "execute",
        "schedule_me",
        "send",
        "session_cancel",
        "session_close",
        "session_new",
        "session_prompt",
        "sleep",
        "wait_for",
        "wait_for_any",
      ],
    )
  })

  it("agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.1 agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.3 exposes the locked primitive profile catalog", () => {
    expect(Object.keys(FiregridPrimitiveProfileToolkit.tools).sort()).toEqual([
      "call",
      "send",
      "wait_for",
      "wait_for_any",
    ])
  })

  it("Tool.parametersSchema decodes identically to the @firegrid/protocol input schema (no parallel parameter shape)", async () => {
    const sleepInput = { durationMs: 100 }
    const decodedViaTool = await Effect.runPromise(
      Schema.decodeUnknown(SleepTool.parametersSchema)(sleepInput),
    )
    const decodedViaProtocol = await Effect.runPromise(
      Schema.decodeUnknown(AgentToolSchemas.SleepToolInputSchema)(sleepInput),
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
      Schema.decodeUnknown(AgentToolSchemas.SessionNewToolInputSchema)(sessionInput),
    )
    expect(decodedViaTool).toEqual(decodedViaProtocol)
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.5 firegrid-schema-projection-contract.TOOL_PROJECTION.3 projects every tool from schema annotations without FiregridOperationEntry", () => {
    const projections = [
      ["sleep", FiregridAgentToolkit.tools.sleep, AgentToolSchemas.SleepToolInputSchema, AgentToolSchemas.SleepToolOutputSchema],
      ["wait_for", FiregridAgentToolkit.tools.wait_for, AgentToolSchemas.WaitForToolInputSchema, AgentToolSchemas.WaitForToolOutputSchema],
      ["send", FiregridAgentToolkit.tools.send, AgentToolSchemas.SendToolInputSchema, AgentToolSchemas.SendToolOutputSchema],
      ["session_new", FiregridAgentToolkit.tools.session_new, AgentToolSchemas.SessionNewToolInputSchema, AgentToolSchemas.SessionNewToolOutputSchema],
      ["session_prompt", FiregridAgentToolkit.tools.session_prompt, AgentToolSchemas.SessionPromptToolInputSchema, AgentToolSchemas.SessionPromptToolOutputSchema],
      ["session_cancel", FiregridAgentToolkit.tools.session_cancel, AgentToolSchemas.SessionCancelToolInputSchema, AgentToolSchemas.SessionCancelToolOutputSchema],
      ["session_close", FiregridAgentToolkit.tools.session_close, AgentToolSchemas.SessionCloseToolInputSchema, AgentToolSchemas.SessionCloseToolOutputSchema],
      ["schedule_me", FiregridAgentToolkit.tools.schedule_me, AgentToolSchemas.ScheduleMeToolInputSchema, AgentToolSchemas.ScheduleMeToolOutputSchema],
      ["execute", FiregridAgentToolkit.tools.execute, AgentToolSchemas.ExecuteToolInputSchema, AgentToolSchemas.ExecuteToolOutputSchema],
      ["call", FiregridAgentToolkit.tools.call, AgentToolSchemas.CallToolInputSchema, AgentToolSchemas.CallToolOutputSchema],
      ["wait_for_any", FiregridAgentToolkit.tools.wait_for_any, AgentToolSchemas.WaitForAnyToolInputSchema, AgentToolSchemas.WaitForAnyToolOutputSchema],
    ] as const

    for (const [name, tool, inputSchema, outputSchema] of projections) {
      const metadata = Option.getOrThrow(
        getFiregridProjectionMetadata(inputSchema),
      )
      const description =
        inputSchema.ast.annotations[SchemaAST.DescriptionAnnotationId]
      expect(tool.name).toBe(name)
      expect(tool.name).toBe(metadata.toolName)
      expect(tool.parametersSchema).toBe(inputSchema)
      expect(tool.successSchema).toBe(outputSchema)
      expect(tool.description).toBe(description)
    }
  })
})

// JSON Schema projection is exercised end-to-end in the V1 MCP HTTP
// smoke; the V0 binding test above (`parametersSchema decodes
// identically to the @firegrid/protocol schema`) already proves the
// schema is bound from the canonical source, and asserting that
// `effect/JSONSchema` produces a JSON Schema would be testing Effect
// rather than this module.

// ---------------------------------------------------------------------------
// Direct toolkit execution requires runtime-context route resolution
// ---------------------------------------------------------------------------

describe("FiregridAgentToolkit direct handler execution", () => {
  it("rejects route-less sleep instead of falling back to a host-wide workflow engine", async () => {
    const failure = await runWith(
      buildBridgeLayer({ contextId: "ctx-toolkit-sleep" }),
      Effect.gen(function* () {
        const built = yield* FiregridAgentToolkit
        return yield* built.handle("sleep", { durationMs: 1 })
      }).pipe(Effect.flip),
    )
    expect(failure).toMatchObject({
      _tag: "ToolExecutionFailed",
      name: "sleep",
    })
    expect(String((failure as { readonly message?: unknown }).message)).toContain(
      "resolved runtime context",
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Malformed input rejected at the toolkit schema boundary
// ---------------------------------------------------------------------------

describe("FiregridAgentToolkit schema validation", () => {
  it("rejects malformed sleep params at the Toolkit decode boundary, before the handler requests IdGenerator", async () => {
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
      buildBridgeLayer({
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
      buildBridgeLayer({
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
      buildBridgeLayer({
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
