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
  type ScheduleMeToolInput,
  type WaitForToolInput,
  WaitForToolOutputSchema,
} from "@firegrid/protocol/agent-tools"
import {
  Duration,
  Effect,
  Match,
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

const eventQueryToTrigger = (
  query: EventQuery,
): FieldEqualsTrigger =>
  Object.entries(query.whereFields).flatMap(([key, value]) =>
    isFieldEqualsScalar(value)
      ? [{ path: [key], equals: value }]
      : [],
  )

// ---------------------------------------------------------------------------
// Per-arm runners
// ---------------------------------------------------------------------------

const runSleepTool = (
  toolUseId: string,
  durationMs: number,
): Effect.Effect<
  ToolResultEvent,
  ToolError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1
  DurableClock.sleep({
    name: `tool:${toolUseId}`,
    duration: Duration.millis(durationMs),
    inMemoryThreshold: Duration.zero,
  }).pipe(Effect.as(toolResult(toolUseId, { slept: true as const })))

const runWaitForTool = (
  toolUseId: string,
  input: WaitForToolInput,
): Effect.Effect<
  ToolResultEvent,
  ToolError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableToolsTable
  | Scope.Scope
> =>
  WaitFor.match({
    name: `tool:${toolUseId}`,
    source: input.eventQuery.stream,
    trigger: eventQueryToTrigger(input.eventQuery),
    ...(input.timeoutMs === undefined
      ? {}
      : { timeoutMs: input.timeoutMs }),
  }).pipe(
    Effect.map((outcome) =>
      outcome._tag === "Match"
        ? toolResult(toolUseId, {
          matched: true as const,
          event: outcome.row,
        })
        : toolResult(toolUseId, {
          matched: false as const,
          timedOut: true as const,
        }),
    ),
    Effect.mapError((cause) =>
      toolExecutionFailed(toolUseId, "wait_for", cause),
    ),
  )

const runSpawnTool = (
  ctx: ToolLoweringContext,
  toolUseId: string,
  input: {
    readonly agentKind: string
    readonly prompt: string
    readonly options?: {
      readonly cwd?: string
      readonly metadata?: Record<string, string>
    }
  },
): Effect.Effect<ToolResultEvent, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    const { childContextId, terminalState } = yield* host.spawnChildContext({
      parentContextId: ctx.contextId,
      toolUseId,
      agentKind: input.agentKind,
      prompt: input.prompt,
      ...(input.options === undefined ? {} : { spawnOptions: input.options }),
    })
    return toolResult(toolUseId, { childContextId, terminalState })
  })

const runSpawnAllTool = (
  ctx: ToolLoweringContext,
  toolUseId: string,
  input: {
    readonly tasks: ReadonlyArray<{
      readonly key?: string
      readonly agentKind: string
      readonly prompt: string
      readonly options?: {
        readonly cwd?: string
        readonly metadata?: Record<string, string>
      }
    }>
  },
): Effect.Effect<ToolResultEvent, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    const { children } = yield* host.spawnChildContexts({
      parentContextId: ctx.contextId,
      toolUseId,
      tasks: input.tasks,
    })
    return toolResult(toolUseId, { children })
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
  ToolResultEvent,
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
    Effect.as(
      toolResult(toolUseId, {
        scheduled: true as const,
        scheduleId,
      }),
    ),
    Effect.mapError((cause) =>
      toolExecutionFailed(toolUseId, "schedule_me", cause),
    ),
  )
}

const runExecuteTool = (
  toolUseId: string,
  input: {
    readonly sandbox: { readonly providerName: string; readonly toolName: string }
    readonly input: unknown
  },
): Effect.Effect<ToolResultEvent, ToolError, AgentToolHost> =>
  Effect.gen(function* () {
    const host = yield* AgentToolHost
    const output = yield* host.executeSandboxTool({
      toolUseId,
      sandbox: input.sandbox,
      input: input.input,
    })
    return toolResult(toolUseId, output)
  })

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type ToolEnvironment =
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableToolsTable
  | Scope.Scope
  | AgentToolHost

interface KnownInvocation {
  readonly toolUseId: string
  readonly name: keyof typeof FiregridAgentTools
  readonly input: unknown
}

const runKnownTool = (
  ctx: ToolLoweringContext,
  invocation: KnownInvocation,
): Effect.Effect<ToolResultEvent, ToolError, ToolEnvironment> =>
  Match.value(invocation).pipe(
    Match.when({ name: "sleep" }, ({ toolUseId, input }) =>
      runSleepTool(toolUseId, (input as { durationMs: number }).durationMs),
    ),
    Match.when({ name: "wait_for" }, ({ toolUseId, input }) =>
      runWaitForTool(toolUseId, input as WaitForToolInput),
    ),
    Match.when({ name: "spawn" }, ({ toolUseId, input }) =>
      runSpawnTool(
        ctx,
        toolUseId,
        input as Parameters<typeof runSpawnTool>[2],
      ),
    ),
    Match.when({ name: "spawn_all" }, ({ toolUseId, input }) =>
      runSpawnAllTool(
        ctx,
        toolUseId,
        input as Parameters<typeof runSpawnAllTool>[2],
      ),
    ),
    Match.when({ name: "schedule_me" }, ({ toolUseId, input }) =>
      runScheduleMeTool(ctx, toolUseId, input as ScheduleMeToolInput),
    ),
    Match.when({ name: "execute" }, ({ toolUseId, input }) =>
      runExecuteTool(
        toolUseId,
        input as Parameters<typeof runExecuteTool>[1],
      ),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Output-schema enforcement
// ---------------------------------------------------------------------------

const verifyOutputAgainstDescriptor = (
  result: ToolResultEvent,
  name: keyof typeof FiregridAgentTools,
): Effect.Effect<ToolResultEvent, ToolError> => {
  // ExecuteToolOutputSchema is `Schema.Unknown` — the sandbox provider's
  // output shape is provider-specific and verified at the SandboxProvider
  // boundary, not at the agent-tool descriptor boundary.
  if (name === "execute") return Effect.succeed(result)
  // wait_for output decoding needs the discriminator literal preserved; the
  // shared schema handles that already.
  void WaitForToolOutputSchema
  const descriptor = FiregridAgentTools[
    name
  ] as unknown as AgentToolDescriptor<unknown, unknown>
  return Schema.decodeUnknown(descriptor.outputSchema)(result.content).pipe(
    Effect.as(result),
    Effect.mapError((cause) =>
      toolExecutionFailed(result.toolUseId, name, cause),
    ),
  )
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Host-side lowering of a Phase 1 `ToolUse` output event to a
 * `ToolResult` input event. Errors are caught and surfaced as
 * `ToolResult` events with `isError: true`. The outer error channel is
 * `never`: tool failures are NOT workflow failures.
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
  const descriptor = (FiregridAgentTools as Record<
    string,
    AgentToolDescriptor<unknown, unknown>
  >)[event.name]
  if (descriptor === undefined) {
    return Effect.succeed(unknownToolResult(event.toolUseId, event.name))
  }
  const name = descriptor.name as keyof typeof FiregridAgentTools
  return Schema.decodeUnknown(descriptor.inputSchema)(event.input).pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        if (cause instanceof ParseResult.ParseError) {
          return Effect.succeed(
            toolErrorResult(
              toolInvalidInputFromParseError(event.toolUseId, name, cause),
            ),
          )
        }
        return Effect.succeed(
          toolErrorResult(toolExecutionFailed(event.toolUseId, name, cause)),
        )
      },
      onSuccess: (decoded) =>
        runKnownTool(ctx, {
          toolUseId: event.toolUseId,
          name,
          input: decoded,
        }).pipe(
          Effect.flatMap((result) => verifyOutputAgainstDescriptor(result, name)),
          Effect.catchAll((error) => Effect.succeed(toolErrorResult(error))),
          Effect.catchAllDefect((defect) =>
            Effect.succeed(
              toolErrorResult(toolExecutionFailed(event.toolUseId, name, defect)),
            ),
          ),
        ),
    }),
  )
}

