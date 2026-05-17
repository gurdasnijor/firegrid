/**
 * `toolUseToEffect` — host-side lowering for the canonical Firegrid
 * agent tools.
 *
 * Given a Phase 1 `ToolUse` output event:
 *   1. Switch on `event.part.name` against the canonical tool name set.
 *   2. Decode `event.part.params` against the matching protocol Effect Schema
 *      from `@firegrid/protocol/agent-tools`.
 *   3. Dispatch the validated invocation to the matching arm.
 *   4. Catch every failure (unknown name, decode error, tool-arm error,
 *      defect) and surface it as a `ToolResult` input event with
 *      `isError: true`.
 *
 * Per `agent-codec-runtime-tools.md/agent-tool-layer-phase-2.md`:
 *  - Tool failures are NOT workflow failures — the agent receives a
 *    structured error and decides what to do next.
 *  - The outer `Effect` error channel is `never`. New arms MUST NOT use
 *    `Effect.orDie` or defects to satisfy that constraint; they must
 *    return typed expected errors that the outer wrapper converts to a
 *    `ToolResult` event.
 *  - `FiregridAgentToolkit` (the Effect AI `Toolkit.make` allowlist in
 *    `tools.ts`) is the public exposure contract. This `name`-switch
 *    is the host implementation: a new tool requires a protocol Effect
 *    Schema, a `Tool.make` entry in the toolkit, and a new arm here.
 *
 * Anchors:
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.3
 *  - firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.1
 *  - firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1..3
 */

import { DurableClock, type WorkflowEngine } from "@effect/workflow"
import { Prompt } from "@effect/ai"
import {
  ExecuteToolInputSchema,
  ScheduleMeToolInputSchema,
  SessionCancelToolInputSchema,
  SessionCloseToolInputSchema,
  SessionNewToolInputSchema,
  SessionPromptToolInputSchema,
  SleepToolInputSchema,
  SpawnAllToolInputSchema,
  SpawnToolInputSchema,
  WaitForToolInputSchema,
  type RuntimeWaitQuery,
  type ExecuteToolInput,
  type ScheduleMeToolInput,
  type ScheduleMeToolOutput,
  type SessionCancelToolInput,
  type SessionCancelToolOutput,
  type SessionCloseToolInput,
  type SessionCloseToolOutput,
  type SessionNewToolInput,
  type SessionNewToolOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
  type SessionStatus,
  type SleepToolInput,
  type SleepToolOutput,
  type SpawnAllToolInput,
  type SpawnAllToolOutput,
  type SpawnToolInput,
  type SpawnToolOutput,
  type WaitForToolInput,
  type WaitForToolOutput,
} from "@firegrid/protocol/agent-tools"
import {
  Duration,
  Effect,
  ParseResult,
  Schema,
  type Scope,
} from "effect"
import {
  type AgentInputEvent,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import {
  WaitFor,
  type DurableWaitCompletionRowLookup,
  type DurableWaitCompletionRowUpsert,
  type DurableWaitRowLookup,
  type DurableWaitRowUpsert,
  type FieldEqualsTrigger,
} from "@firegrid/runtime/durable-tools"
import { ScheduledInputWorkflow } from "./scheduled-input-workflow.ts"
import { AgentToolHost } from "./tool-host.ts"
import {
  toolErrorResult,
  toolExecutionFailed,
  toolInvalidInputFromParseError,
  toolResult,
  unknownToolResult,
  type ToolError,
} from "../bindings/tool-error.ts"

type ToolUseEvent = Extract<AgentOutputEvent, { _tag: "ToolUse" }>
type ToolResultEvent = Extract<AgentInputEvent, { _tag: "ToolResult" }>

export interface ToolLoweringContext {
  /** Parent runtime-context id; used to derive deterministic child ids. */
  readonly contextId: string
}

// ---------------------------------------------------------------------------
// RuntimeWaitQuery → FieldEqualsTrigger adapter
// ---------------------------------------------------------------------------

const isFieldEqualsScalar = (
  value: unknown,
): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"

interface EventQueryAdapterFailure {
  readonly key: string
  readonly value: unknown
}

const describeNonScalarValue = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

const waitQueryToTrigger = (
  query: RuntimeWaitQuery,
):
  | { readonly _tag: "Ok"; readonly trigger: FieldEqualsTrigger }
  | { readonly _tag: "NonScalar"; readonly failures: ReadonlyArray<EventQueryAdapterFailure> }
  | { readonly _tag: "Empty" } => {
  const entries = Object.entries(query.whereFields)
  if (entries.length === 0) return { _tag: "Empty" }
  const failures: Array<EventQueryAdapterFailure> = []
  const trigger: Array<FieldEqualsTrigger[number]> = []
  for (const [key, value] of entries) {
    if (isFieldEqualsScalar(value)) {
      trigger.push({ path: [key], equals: value })
    } else {
      failures.push({ key, value })
    }
  }
  if (failures.length > 0) return { _tag: "NonScalar", failures }
  return { _tag: "Ok", trigger }
}

// ---------------------------------------------------------------------------
// Per-arm runners
//
// Each arm receives the typed decoded input from its
// `@firegrid/protocol/agent-tools` input schema and returns the typed
// output that the same protocol module declares. TypeScript checks the
// schema-to-arm coupling at compile time: if a shared protocol schema
// changes shape, the corresponding arm's body fails to compile rather
// than silently passing the wrong payload to a primitive.
// ---------------------------------------------------------------------------

const runSleepTool = (
  toolUseId: string,
  input: SleepToolInput,
): Effect.Effect<
  SleepToolOutput,
  ToolError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1
  DurableClock.sleep({
    name: `tool:${toolUseId}`,
    duration: Duration.millis(input.durationMs),
    inMemoryThreshold: Duration.zero,
  }).pipe(Effect.as<SleepToolOutput>({ slept: true }))

const runWaitForTool = (
  toolUseId: string,
  input: WaitForToolInput,
): Effect.Effect<
  WaitForToolOutput,
  ToolError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableWaitRowLookup
  | DurableWaitRowUpsert
  | DurableWaitCompletionRowLookup
  | DurableWaitCompletionRowUpsert
  | Scope.Scope
> => {
  // `whereFields` is typed `Record<string, unknown>` because schema-level
  // scalar refinement would prevent codecs from publishing the JSON shape
  // unchanged. We enforce scalar-only predicates here because the downstream
  // FieldEqualsTrigger evaluator treats an empty trigger as a universal
  // match — an agent emitting non-scalar values would otherwise see wait_for
  // "match any row" instead of an invalid-input ToolResult.
  const adapted = waitQueryToTrigger(input.waitQuery)
  if (adapted._tag === "NonScalar") {
    const summary = adapted.failures
      .map((f) => `${f.key}=${describeNonScalarValue(f.value)}`)
      .join(", ")
    return Effect.fail({
      _tag: "ToolInvalidInput",
      toolUseId,
      name: "wait_for",
      reason:
        `waitQuery.whereFields values must be string, number, or boolean (got non-scalar: ${summary})`,
    })
  }
  if (adapted._tag === "Empty") {
    return Effect.fail({
      _tag: "ToolInvalidInput",
      toolUseId,
      name: "wait_for",
      reason:
        "waitQuery.whereFields must declare at least one predicate; empty predicate sets are rejected because they would match every row.",
    })
  }
  return WaitFor.match({
    name: `tool:${toolUseId}`,
    source: input.waitQuery.source,
    trigger: adapted.trigger,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  }).pipe(
    Effect.map((outcome): WaitForToolOutput =>
      outcome._tag === "Match"
        ? { matched: true, event: outcome.row }
        : { matched: false, timedOut: true },
    ),
    Effect.mapError((cause) =>
      toolExecutionFailed(toolUseId, "wait_for", cause),
    ),
  )
}

const runSpawnTool = (
  ctx: ToolLoweringContext,
  toolUseId: string,
  input: SpawnToolInput,
): Effect.Effect<SpawnToolOutput, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const { childContextId, terminalState } = yield* runSpawnChildContext(
      ctx,
      toolUseId,
      input,
    )
    if (terminalState === undefined) {
      return yield* Effect.fail(toolExecutionFailed(
        toolUseId,
        "spawn",
        "spawnChildContext did not return a terminal state",
      ))
    }
    return { childContextId, terminalState }
  })

const runSpawnChildContext = (
  ctx: ToolLoweringContext,
  toolUseId: string,
  input: SpawnToolInput | SessionNewToolInput,
) =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    return yield* host.spawnChildContext({
      parentContextId: ctx.contextId,
      toolUseId,
      agentKind: input.agentKind,
      prompt: input.prompt,
      ...(input.options === undefined ? {} : { spawnOptions: input.options }),
    })
  })

const runSpawnAllTool = (
  ctx: ToolLoweringContext,
  toolUseId: string,
  input: SpawnAllToolInput,
): Effect.Effect<SpawnAllToolOutput, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    const { children } = yield* host.spawnChildContexts({
      parentContextId: ctx.contextId,
      toolUseId,
      tasks: input.tasks,
    })
    return { children }
  })

const runSessionNewTool = (
  ctx: ToolLoweringContext,
  toolUseId: string,
  input: SessionNewToolInput,
): Effect.Effect<SessionNewToolOutput, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const { childContextId, status, terminalState } = yield* runSpawnChildContext(
      ctx,
      toolUseId,
      input,
    )
    return {
      session: {
        // firegrid-factory-aligned-agent-tools.SESSION.7
        sessionId: childContextId,
        contextId: childContextId,
        status: status ?? statusFromTerminalState(terminalState),
        metadata: {
          parentSessionId: ctx.contextId,
          ...(input.options?.metadata ?? {}),
        },
        ...(terminalState === undefined ? {} : { terminalState }),
      },
    }
  })

const statusFromTerminalState = (
  terminalState: SpawnToolOutput["terminalState"] | undefined,
): SessionStatus => {
  if (terminalState === undefined) return "running"
  switch (terminalState._tag) {
    case "Completed":
      return "done"
    case "Failed":
      return "failed"
    case "Cancelled":
      return "aborted"
  }
}

const promptFromText = (text: string) =>
  Prompt.userMessage({
    content: [Prompt.textPart({ text })],
  })

const sessionPromptInputId = (
  sessionId: string,
  toolUseId: string,
): string => `session-prompt:${sessionId}:${toolUseId}`

const runSessionPromptTool = (
  toolUseId: string,
  input: SessionPromptToolInput,
): Effect.Effect<SessionPromptToolOutput, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    const inputId =
      input.inputId ?? sessionPromptInputId(input.sessionId, toolUseId)
    yield* host.appendSessionPrompt({
      toolUseId,
      sessionId: input.sessionId,
      inputId,
      prompt: promptFromText(input.prompt),
    })
    return {
      appended: true,
      sessionId: input.sessionId,
      inputId,
    }
  })

const runSessionCancelTool = (
  toolUseId: string,
  input: SessionCancelToolInput,
): Effect.Effect<SessionCancelToolOutput, ToolError, AgentToolHost> =>
  runSessionLifecycleTool(toolUseId, input, "session_cancel").pipe(
    Effect.as({ cancelled: true, sessionId: input.sessionId }),
  )

const runSessionCloseTool = (
  toolUseId: string,
  input: SessionCloseToolInput,
): Effect.Effect<SessionCloseToolOutput, ToolError, AgentToolHost> =>
  runSessionLifecycleTool(toolUseId, input, "session_close").pipe(
    Effect.as({ closed: true, sessionId: input.sessionId }),
  )

const runSessionLifecycleTool = (
  toolUseId: string,
  input: SessionCancelToolInput | SessionCloseToolInput,
  name: "session_cancel" | "session_close",
): Effect.Effect<void, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    const params = {
      toolUseId,
      sessionId: input.sessionId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }
    if (name === "session_cancel") {
      return yield* host.cancelSession(params)
    }
    return yield* host.closeSession(params)
  })

const scheduleIdFor = (
  contextId: string,
  toolUseId: string,
): string => `schedule-me:${contextId}:${toolUseId}`

const runScheduleMeTool = (
  ctx: ToolLoweringContext,
  toolUseId: string,
  input: ScheduleMeToolInput,
): Effect.Effect<
  ScheduleMeToolOutput,
  ToolError,
  WorkflowEngine.WorkflowEngine
> => {
  const scheduleId = scheduleIdFor(ctx.contextId, toolUseId)
  const prompt = promptFromText(input.prompt)
  return ScheduledInputWorkflow.execute(
    {
      contextId: ctx.contextId,
      dueAtMs: input.when,
      prompt,
      inputId: scheduleId,
    },
    { discard: true },
  ).pipe(
    Effect.as<ScheduleMeToolOutput>({ scheduled: true, scheduleId }),
    Effect.mapError((cause) =>
      toolExecutionFailed(toolUseId, "schedule_me", cause),
    ),
  )
}

const runExecuteTool = (
  toolUseId: string,
  input: ExecuteToolInput,
): Effect.Effect<unknown, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    if (input.sessionId !== undefined && input.capability !== undefined) {
      return yield* host.executeSessionCapability({
        toolUseId,
        sessionId: input.sessionId,
        capability: input.capability,
        input: input.input,
      })
    }
    if (input.sandbox === undefined) {
      return yield* Effect.fail({
        _tag: "ToolInvalidInput" as const,
        toolUseId,
        name: "execute",
        reason:
          "execute requires either sessionId + capability or a legacy sandbox reference.",
      })
    }
    return yield* host.executeSandboxTool({
      toolUseId,
      sandbox: input.sandbox,
      input: input.input,
    })
  })

// ---------------------------------------------------------------------------
// Typed protocol-schema dispatch
// ---------------------------------------------------------------------------

type ToolEnvironment =
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableWaitRowLookup
  | DurableWaitRowUpsert
  | DurableWaitCompletionRowLookup
  | DurableWaitCompletionRowUpsert
  | Scope.Scope
  | AgentToolHost

/**
 * Decode `event.part.params` against the concrete `@firegrid/protocol`
 * input Schema, pass the typed result to the arm, wrap the arm's
 * typed output in a `ToolResult` event, and catch every failure path
 * into an `isError: true` event. The schema parameter binds `I` and
 * `O` to the arm's parameter and result types — schema changes break
 * the corresponding arm at compile time rather than hiding behind an
 * `as` cast.
 */
const dispatchTool = <I, Encoded, O, R>(
  event: ToolUseEvent,
  toolName: string,
  parametersSchema: Schema.Schema<I, Encoded>,
  arm: (input: I) => Effect.Effect<O, ToolError, R>,
): Effect.Effect<ToolResultEvent, never, R> =>
  Schema.decodeUnknown(parametersSchema)(event.part.params).pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        if (cause instanceof ParseResult.ParseError) {
          return Effect.succeed(
            toolErrorResult(
              toolInvalidInputFromParseError(
                event.part.id,
                toolName,
                cause,
              ),
            ),
          )
        }
        return Effect.succeed(
          toolErrorResult(
            toolExecutionFailed(event.part.id, toolName, cause),
          ),
        )
      },
      onSuccess: (input) =>
        arm(input).pipe(
          Effect.map((output) => toolResult(event.part.id, toolName, output)),
          Effect.catchAll((error) => Effect.succeed(toolErrorResult(error))),
          Effect.catchAllDefect((defect) =>
            Effect.succeed(
              toolErrorResult(
                toolExecutionFailed(event.part.id, toolName, defect),
              ),
            ),
          ),
        ),
    }),
  )

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Host-side lowering of a Phase 1 `ToolUse` output event to a
 * `ToolResult` input event. Errors are caught and surfaced as
 * `ToolResult` events with `isError: true`. The outer error channel is
 * `never`: tool failures are NOT workflow failures.
 *
   * Dispatch switches on `event.part.name` and decodes against the canonical
 * protocol input Schema for that name. Each arm receives the typed
 * decoded input from its `@firegrid/protocol/agent-tools` schema and
 * returns the typed output declared by the same protocol module — so a
 * future schema change breaks the corresponding arm at compile time
 * rather than hiding behind an `as` cast. Adding a tool requires
 * (a) a protocol Effect Schema, (b) a new `case` here pointing at a
 * typed arm, and (c) a matching `Tool.make(...)` entry in
 * `FiregridAgentToolkit` (the exposure manifest in `tools.ts`).
 *
 * Implements:
 *  - SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"Runtime Semantics"
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.3
 *  - firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.1
 */
export const toolUseToEffect = (
  ctx: ToolLoweringContext,
  event: ToolUseEvent,
): Effect.Effect<ToolResultEvent, never, ToolEnvironment> => {
  switch (event.part.name) {
    case "sleep":
      return dispatchTool(event, "sleep", SleepToolInputSchema, (input) =>
        runSleepTool(event.part.id, input),
      )
    case "wait_for":
      return dispatchTool(event, "wait_for", WaitForToolInputSchema, (input) =>
        runWaitForTool(event.part.id, input),
      )
    case "spawn":
      return dispatchTool(event, "spawn", SpawnToolInputSchema, (input) =>
        runSpawnTool(ctx, event.part.id, input),
      )
    case "spawn_all":
      return dispatchTool(
        event,
        "spawn_all",
        SpawnAllToolInputSchema,
        (input) => runSpawnAllTool(ctx, event.part.id, input),
      )
    case "session_new":
      return dispatchTool(
        event,
        "session_new",
        SessionNewToolInputSchema,
        (input) => runSessionNewTool(ctx, event.part.id, input),
      )
    case "session_prompt":
      return dispatchTool(
        event,
        "session_prompt",
        SessionPromptToolInputSchema,
        (input) => runSessionPromptTool(event.part.id, input),
      )
    case "session_cancel":
      return dispatchTool(
        event,
        "session_cancel",
        SessionCancelToolInputSchema,
        (input) => runSessionCancelTool(event.part.id, input),
      )
    case "session_close":
      return dispatchTool(
        event,
        "session_close",
        SessionCloseToolInputSchema,
        (input) => runSessionCloseTool(event.part.id, input),
      )
    case "schedule_me":
      return dispatchTool(
        event,
        "schedule_me",
        ScheduleMeToolInputSchema,
        (input) => runScheduleMeTool(ctx, event.part.id, input),
      )
    case "execute":
      return dispatchTool(event, "execute", ExecuteToolInputSchema, (input) =>
        runExecuteTool(event.part.id, input),
      )
    default:
      return Effect.succeed(unknownToolResult(event.part.id, event.part.name))
  }
}
