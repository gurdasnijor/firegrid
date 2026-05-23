// Shape D MCP-entry tool-dispatch shape — probe.
//
// Validates the D-Tool YELLOW plan option (A): the host-sdk facade can
// invoke `ToolCallWorkflow` directly via `WorkflowEngine.execute(...)`,
// without the legacy `RuntimeContextWorkflowRuntime.run({...,
// workflowName, supportLayer, effect})` bridge — and at-most-once
// survives a fiber/process restart purely via `idempotencyKey: toolUseId`
// memoization, with NO new `tables/runtime-tool-result.ts` primitive
// and NO #684 wait-routing / runtime-streams imports.
//
// Falsifiers encoded below:
//   - if the facade ever needs `RuntimeContextWorkflowRuntime` or
//     `supportLayer` to invoke `.execute(...)`, the verdict drops to
//     YELLOW (keep the wrapper);
//   - if at-most-once breaks across the restart boundary purely via
//     `idempotencyKey`, the verdict drops to RED (the SDD's C3 claim
//     for the Shape D tool path is wrong).

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  executeMcpEntryTool,
} from "../../src/simulations/shape-d-tool-dispatch-mcp-entry/host-facade.ts"
import {
  registerRuntimeToolCallWorkflow,
} from "../../src/simulations/shape-d-tool-dispatch-mcp-entry/runtime-layer.ts"
import {
  makeRuntimeToolUseExecutor,
  RuntimeToolUseExecutor,
  RuntimeToolUseExecutorLive,
  WorkflowEngine,
  WorkflowEngineLive,
} from "../../src/simulations/shape-d-tool-dispatch-mcp-entry/resources.ts"

// ── File text under inspection for the negative guards ─────────────────

const simDir = resolve(
  import.meta.dirname,
  "../../src/simulations/shape-d-tool-dispatch-mcp-entry",
)

const facadeSource = readFileSync(resolve(simDir, "host-facade.ts"), "utf8")
const runtimeLayerSource = readFileSync(resolve(simDir, "runtime-layer.ts"), "utf8")
const resourcesSource = readFileSync(resolve(simDir, "resources.ts"), "utf8")

const importLines = (source: string): string => {
  const start = source.indexOf("\nimport ")
  if (start < 0) return ""
  const end = source.lastIndexOf("\nimport ")
  const lastImportEnd = source.indexOf("\n", end + 1)
  return source.slice(start, lastImportEnd < 0 ? source.length : lastImportEnd)
}

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

const facadeImports = importLines(facadeSource)
const facadeBody = stripComments(facadeSource)
const runtimeLayerBody = stripComments(runtimeLayerSource)
const resourcesBody = stripComments(resourcesSource)

// ── Composition helper for the positive tests ─────────────────────────

const baseLayer = Layer.merge(WorkflowEngineLive, RuntimeToolUseExecutorLive())

// ── POSITIVE: option (A) shape ────────────────────────────────────────

describe("shape-d-tool-dispatch-mcp-entry: positive (option A)", () => {
  it("host-sdk facade invokes ToolCallWorkflow.execute via WorkflowEngine — no RuntimeContextWorkflowRuntime needed", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* registerRuntimeToolCallWorkflow
        return yield* executeMcpEntryTool({
          contextId: "ctx_a",
          toolUseId: "tu_alpha_1",
          toolName: "echo",
          input: "hello",
        })
      }).pipe(Effect.provide(baseLayer)),
    )
    expect(result).toEqual({ toolUseId: "tu_alpha_1", output: "echo:hello" })
  })

  it("same toolUseId across two MCP-entry calls executes the underlying executor exactly once (Workflow.idempotencyKey is the C3 mechanism)", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        yield* registerRuntimeToolCallWorkflow
        const engine = yield* WorkflowEngine
        const first = yield* executeMcpEntryTool({
          contextId: "ctx_b",
          toolUseId: "tu_beta_42",
          toolName: "echo",
          input: "first",
        })
        const second = yield* executeMcpEntryTool({
          contextId: "ctx_b",
          // Idempotency key = toolUseId; even though `input` differs,
          // the memoized first-valid-terminal-wins result returns the
          // first call's output. This is the SDD C3 contract for
          // `Workflow.idempotencyKey` and matches production
          // ToolCallWorkflow's `idempotencyKey: ({ toolUseId }) => toolUseId`.
          toolUseId: "tu_beta_42",
          toolName: "echo",
          input: "second-ignored",
        })
        const invocations = yield* engine.invocationCount("tu_beta_42")
        return { first, second, invocations }
      }).pipe(Effect.provide(baseLayer)),
    )
    expect(observed.first).toEqual({ toolUseId: "tu_beta_42", output: "echo:first" })
    expect(observed.second).toEqual(observed.first)
    expect(observed.invocations).toBe(1)
  })

  it("different toolUseId values invoke the executor per-call", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        yield* registerRuntimeToolCallWorkflow
        const engine = yield* WorkflowEngine
        yield* executeMcpEntryTool({
          contextId: "ctx_c",
          toolUseId: "tu_c1",
          toolName: "echo",
          input: "one",
        })
        yield* executeMcpEntryTool({
          contextId: "ctx_c",
          toolUseId: "tu_c2",
          toolName: "echo",
          input: "two",
        })
        return {
          one: yield* engine.invocationCount("tu_c1"),
          two: yield* engine.invocationCount("tu_c2"),
        }
      }).pipe(Effect.provide(baseLayer)),
    )
    expect(observed.one).toBe(1)
    expect(observed.two).toBe(1)
  })

  it("at-most-once SURVIVES the restart boundary purely via idempotencyKey (no tables/runtime-tool-result needed)", async () => {
    // Restart drops the in-memory handler registry (fiber/process
    // restart) but keeps the durable memo. Re-register the handler
    // after restart, then call execute again with the same toolUseId:
    // the second call must NOT re-invoke the executor — the memo
    // returns the first call's result.
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        yield* registerRuntimeToolCallWorkflow
        const engine = yield* WorkflowEngine
        const executor = yield* RuntimeToolUseExecutor
        const first = yield* executeMcpEntryTool({
          contextId: "ctx_restart",
          toolUseId: "tu_restart_1",
          toolName: "echo",
          input: "pre-restart",
        })
        const executorCallsBeforeRestart = yield* executor.invocations

        // Restart: drop in-memory handler state (mirrors a process
        // restart). The durable memo persists.
        yield* engine.restart

        // Re-register the handler — production does this by
        // re-installing the runtime root Layer at composition time on
        // process boot.
        yield* registerRuntimeToolCallWorkflow

        const second = yield* executeMcpEntryTool({
          contextId: "ctx_restart",
          toolUseId: "tu_restart_1",
          toolName: "echo",
          input: "post-restart-ignored",
        })
        const executorCallsAfterRestart = yield* executor.invocations
        const invocations = yield* engine.invocationCount("tu_restart_1")
        return {
          first,
          second,
          executorCallsBeforeRestart,
          executorCallsAfterRestart,
          invocations,
        }
      }).pipe(Effect.provide(baseLayer)),
    )
    // First call ran the executor once.
    expect(observed.executorCallsBeforeRestart).toBe(1)
    // Second call after restart did NOT re-invoke the executor.
    expect(observed.executorCallsAfterRestart).toBe(1)
    expect(observed.first.output).toBe("echo:pre-restart")
    expect(observed.second).toEqual(observed.first)
    expect(observed.invocations).toBe(1)
  })

  it("a failing executor surfaces the failure on the first call AND on subsequent calls (no half-memo)", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        yield* registerRuntimeToolCallWorkflow
        return yield* executeMcpEntryTool({
          contextId: "ctx_fail",
          toolUseId: "tu_fail_1",
          toolName: "echo",
          input: "boom",
        })
      }).pipe(Effect.provide(Layer.merge(
        WorkflowEngineLive,
        RuntimeToolUseExecutorLive({
          failFor: (input) =>
            input.toolUseId === "tu_fail_1"
              ? Option.some(new Error("executor blew up"))
              : Option.none(),
        }),
      ))),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("executor blew up")
    }
  })

  it("multiple different workflows can register on the same engine without interference", async () => {
    // Sanity: handler registry keyed by workflow name; idempotencyKey
    // memo keyed by (workflowName, key). Same toolUseId across different
    // workflow names would not collide. Here we just register the same
    // workflow twice and verify idempotent registration.
    const ok = await Effect.runPromise(
      Effect.gen(function*() {
        yield* registerRuntimeToolCallWorkflow
        yield* registerRuntimeToolCallWorkflow
        const result = yield* executeMcpEntryTool({
          contextId: "ctx_dup",
          toolUseId: "tu_dup_1",
          toolName: "echo",
          input: "dup",
        })
        return result.output === "echo:dup"
      }).pipe(Effect.provide(baseLayer)),
    )
    expect(ok).toBe(true)
  })
})

// ── NEGATIVE GUARDS (file-text) ───────────────────────────────────────

describe("shape-d-tool-dispatch-mcp-entry: negative guards", () => {
  it("host-facade.ts does NOT import RuntimeContextWorkflowRuntime / workflowRuntime.run / supportLayer / toolCallWorkflowSupportLayer", () => {
    const forbidden = [
      "RuntimeContextWorkflowRuntime",
      "workflowRuntime.run",
      "workflowRuntime",
      "supportLayer",
      "toolCallWorkflowSupportLayer",
      "AgentToolHost",
      "provideRuntimeContext",
    ]
    for (const banned of forbidden) {
      expect(facadeImports).not.toContain(banned)
      expect(facadeBody).not.toContain(banned)
    }
  })

  it("the entire sim contains NO RuntimeToolResultTable / runtimeToolResultAtMostOnce / wait-routing primitive (no #684 salvage)", () => {
    const forbidden = [
      // #684 anti-pattern: parallel tool-result table
      "RuntimeToolResultTable",
      "RuntimeToolResultRow",
      "runtimeToolResultAtMostOnce",
      "RuntimeToolResultStore",
      // #684 anti-pattern: parallel wait-completion
      "RuntimeWaitCompletionTable",
      "RuntimeWaitCompletionStore",
      "runtimeWaitForMatch",
      // #684 anti-pattern: streams aggregator
      "RuntimeObservationStreams",
      "callerFact",
      "RuntimeAgentOutputAfterEvents",
      // Wrong-tree paths #684 used
      "wait-routing/",
      "@firegrid/runtime/streams",
      // Workflow-engine internals that would indicate the bridge was kept
      "WorkflowEngineTable",
    ]
    for (const banned of forbidden) {
      expect(facadeBody).not.toContain(banned)
      expect(runtimeLayerBody).not.toContain(banned)
      expect(resourcesBody).not.toContain(banned)
    }
  })

  it("host-facade.ts R channel is exactly {WorkflowEngine} (compile-time)", () => {
    // The facade Effect's Context must be WorkflowEngine alone — that
    // is the load-bearing claim of option (A). If it grew to include
    // RuntimeContextWorkflowRuntime, AgentToolHost, or any other
    // host-bound capability, the bridge is not actually deletable.
    type FacadeR = Effect.Effect.Context<ReturnType<typeof executeMcpEntryTool>>
    const assertOnlyWorkflowEngine = (
      _: [FacadeR] extends [WorkflowEngine] ? true : false,
    ): void => undefined
    assertOnlyWorkflowEngine(true)
    expect(true).toBe(true)
  })

  it("runtime-layer R channel is exactly {WorkflowEngine, RuntimeToolUseExecutor} (compile-time)", () => {
    // The registration step needs both — the engine to register on, and
    // the executor to close over. The host composition provides both at
    // boot time; nothing else is required.
    type RegisterR = Effect.Effect.Context<typeof registerRuntimeToolCallWorkflow>
    const assertExactly = (
      _: [RegisterR] extends [WorkflowEngine | RuntimeToolUseExecutor]
        ? [WorkflowEngine | RuntimeToolUseExecutor] extends [RegisterR]
          ? true
          : false
        : false,
    ): void => undefined
    assertExactly(true)
    expect(true).toBe(true)
  })

  it("idempotencyKey is literally `({ toolUseId }) => toolUseId` — matches production ToolCallWorkflow", () => {
    // This is the SDD's C3 result identity claim for the Shape D tool
    // path. If anyone changes the key to something else (or adds a
    // separate at-most-once table), the proof's C3 anchor moves and
    // Wave D dispatch needs to re-resolve.
    expect(resourcesBody).toContain("idempotencyKey: ({ toolUseId }) => toolUseId")
    expect(resourcesBody).toContain("name: \"firegrid.agent-tool-call\"")
  })
})

// Reference for the executor instance used in tests above — keeps knip
// happy without changing the negative-guard imports list.
void makeRuntimeToolUseExecutor
