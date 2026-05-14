/**
 * `toolUseToEffect` — host-side lowering for the canonical Firegrid
 * agent tools.
 *
 * Given a Phase 1 `ToolUse` output event:
 *   1. Look up the descriptor in `FiregridAgentTools` by `event.name`.
 *   2. Decode `event.input` against `descriptor.inputSchema`.
 *   3. Dispatch the validated invocation to the matching arm via
 *      `Match.exhaustive`.
 *   4. Catch every failure (lookup miss, decode error, tool-arm error,
 *      output schema mismatch) and surface it as a `ToolResult` input
 *      event with `isError: true`.
 *
 * Per `agent-codec-runtime-tools.md/agent-tool-layer-phase-2.md`:
 *  - Tool failures are NOT workflow failures — the agent receives a
 *    structured error and decides what to do next.
 *  - The outer `Effect` error channel is `never`. New arms MUST NOT use
 *    `Effect.orDie` or defects to satisfy that constraint; they must
 *    return typed expected errors that the outer wrapper converts to a
 *    `ToolResult` event.
 *  - The descriptor set is the public contract. The match expression is
 *    the implementation. Adding a tool requires a protocol Effect Schema
 *    plus a descriptor plus a match arm.
 *
 * Anchors:
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.3
 *  - firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.1
 *  - firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1..3
 */

import { DurableClock, type WorkflowEngine } from "@effect/workflow"
import {
  type EventQuery,
  type ExecuteToolInput,
  type ScheduleMeToolInput,
  type SleepToolInput,
  type SleepToolOutput,
  type SpawnAllToolInput,
  type SpawnAllToolOutput,
  type SpawnToolInput,
  type SpawnToolOutput,
  type ScheduleMeToolOutput,
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
  type AgentToolDescriptor,
  type PromptContent,
} from "../agent-io/index.ts"
import {
  WaitFor,
  type DurableToolsTable,
  type FieldEqualsTrigger,
} from "../durable-tools/index.ts"
import { FiregridAgentTools } from "./descriptors.ts"
import { ScheduledInputWorkflow } from "./scheduled-input-workflow.ts"
import { AgentToolHost } from "./tool-host.ts"
import {
  toolErrorResult,
  toolExecutionFailed,
  toolInvalidInputFromParseError,
  toolResult,
  unknownToolResult,
  type ToolError,
} from "./tool-error.ts"

type ToolUseEvent = Extract<AgentOutputEvent, { _tag: "ToolUse" }>
type ToolResultEvent = Extract<AgentInputEvent, { _tag: "ToolResult" }>

export interface ToolLoweringContext {
  /** Parent runtime-context id; used to derive deterministic child ids. */
  readonly contextId: string
}

// ---------------------------------------------------------------------------
// EventQuery → FieldEqualsTrigger adapter
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

const eventQueryToTrigger = (
  query: EventQuery,
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
// Each arm receives the typed decoded input from its descriptor's
// `inputSchema` and returns the typed output that the descriptor's
// `outputSchema` declares. TypeScript therefore checks the
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
  | DurableToolsTable
  | Scope.Scope
> => {
  // EventQuery's `whereFields` is typed `Record<string, unknown>` because
  // schema-level scalar refinement would prevent codecs from publishing
  // the JSON shape unchanged. We enforce scalar-only predicates here
  // because the downstream FieldEqualsTrigger evaluator treats an empty
  // trigger as a universal match — an agent emitting non-scalar values
  // would otherwise see wait_for "match any row" instead of an
  // invalid-input ToolResult.
  const adapted = eventQueryToTrigger(input.eventQuery)
  if (adapted._tag === "NonScalar") {
    const summary = adapted.failures
      .map((f) => `${f.key}=${describeNonScalarValue(f.value)}`)
      .join(", ")
    return Effect.fail({
      _tag: "ToolInvalidInput",
      toolUseId,
      name: "wait_for",
      reason:
        `eventQuery.whereFields values must be string, number, or boolean (got non-scalar: ${summary})`,
    })
  }
  if (adapted._tag === "Empty") {
    return Effect.fail({
      _tag: "ToolInvalidInput",
      toolUseId,
      name: "wait_for",
      reason:
        "eventQuery.whereFields must declare at least one predicate; empty predicate sets are rejected because they would match every row.",
    })
  }
  return WaitFor.match({
    name: `tool:${toolUseId}`,
    source: input.eventQuery.stream,
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
    const host = yield* AgentToolHost
    const { childContextId, terminalState } = yield* host.spawnChildContext({
      parentContextId: ctx.contextId,
      toolUseId,
      agentKind: input.agentKind,
      prompt: input.prompt,
      ...(input.options === undefined ? {} : { spawnOptions: input.options }),
    })
    return { childContextId, terminalState }
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
  const content: PromptContent = [{ _tag: "Text", text: input.prompt }]
  return ScheduledInputWorkflow.execute(
    {
      contextId: ctx.contextId,
      dueAtMs: input.when,
      promptContent: content,
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
    return yield* host.executeSandboxTool({
      toolUseId,
      sandbox: input.sandbox,
      input: input.input,
    })
  })

// ---------------------------------------------------------------------------
// Typed descriptor-driven dispatch
// ---------------------------------------------------------------------------

type ToolEnvironment =
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableToolsTable
  | Scope.Scope
  | AgentToolHost

/**
 * Decode `event.input` against the concrete descriptor's `inputSchema`,
 * pass the typed result to the arm, wrap the arm's typed output in a
 * `ToolResult` event, and catch every failure path into an
 * `isError: true` event. The descriptor parameter binds I and O to the
 * arm's parameter and result types — schema changes break the
 * corresponding arm at compile time rather than hiding behind an `as`
 * cast.
 */
const dispatchTool = <I, O, R>(
  event: ToolUseEvent,
  descriptor: AgentToolDescriptor<I, O>,
  arm: (input: I) => Effect.Effect<O, ToolError, R>,
): Effect.Effect<ToolResultEvent, never, R> =>
  Schema.decodeUnknown(descriptor.inputSchema)(event.input).pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        if (cause instanceof ParseResult.ParseError) {
          return Effect.succeed(
            toolErrorResult(
              toolInvalidInputFromParseError(
                event.toolUseId,
                descriptor.name,
                cause,
              ),
            ),
          )
        }
        return Effect.succeed(
          toolErrorResult(
            toolExecutionFailed(event.toolUseId, descriptor.name, cause),
          ),
        )
      },
      onSuccess: (input) =>
        arm(input).pipe(
          Effect.map((output) => toolResult(event.toolUseId, output)),
          Effect.catchAll((error) => Effect.succeed(toolErrorResult(error))),
          Effect.catchAllDefect((defect) =>
            Effect.succeed(
              toolErrorResult(
                toolExecutionFailed(event.toolUseId, descriptor.name, defect),
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
 * Dispatch switches on `event.name` and looks up the concrete
 * descriptor in `FiregridAgentTools` so each arm receives its decoded
 * input typed by the descriptor's `inputSchema` and returns the typed
 * output declared by the descriptor's `outputSchema` — no per-arm `as`
 * casts. Adding a tool requires (a) a protocol Effect Schema, (b) a
 * descriptor entry in `FiregridAgentTools`, and (c) a new `case` here
 * pointing at a typed arm. Removing a tool requires removing the case
 * (exhaustiveness is enforced via the `never`-typed default).
 *
 * Implements:
 *  - agent-codec-runtime-tools.md/agent-tool-layer-phase-2 §"The function"
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.3
 *  - firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.1
 */
export const toolUseToEffect = (
  ctx: ToolLoweringContext,
  event: ToolUseEvent,
): Effect.Effect<ToolResultEvent, never, ToolEnvironment> => {
  switch (event.name) {
    case "sleep":
      return dispatchTool(event, FiregridAgentTools.sleep, (input) =>
        runSleepTool(event.toolUseId, input),
      )
    case "wait_for":
      return dispatchTool(event, FiregridAgentTools.wait_for, (input) =>
        runWaitForTool(event.toolUseId, input),
      )
    case "spawn":
      return dispatchTool(event, FiregridAgentTools.spawn, (input) =>
        runSpawnTool(ctx, event.toolUseId, input),
      )
    case "spawn_all":
      return dispatchTool(event, FiregridAgentTools.spawn_all, (input) =>
        runSpawnAllTool(ctx, event.toolUseId, input),
      )
    case "schedule_me":
      return dispatchTool(event, FiregridAgentTools.schedule_me, (input) =>
        runScheduleMeTool(ctx, event.toolUseId, input),
      )
    case "execute":
      return dispatchTool(event, FiregridAgentTools.execute, (input) =>
        runExecuteTool(event.toolUseId, input),
      )
    default:
      return Effect.succeed(unknownToolResult(event.toolUseId, event.name))
  }
}

