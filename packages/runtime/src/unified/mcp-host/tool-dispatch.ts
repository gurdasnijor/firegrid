/**
 * THE REWIRE (tf-r06u.28 slice 2) — the shared typed agent-tool arms plus
 * the relay-free MCP-entry dispatch surface, built over #765's unified
 * substrate.
 *
 * Two collaborators live here:
 *
 *   1. `FiregridAgentToolExecutor` — the SINGLE shared lowering. Each tool
 *      is a TYPED arm `(input) => Effect<Output, ToolError>` (the same
 *      shape as main's `toolUseToEffect` arms). There is deliberately ONE
 *      lowering; the two entry paths share it. What differs per path is
 *      only delivery: the MCP-entry path (here) returns the tool output in
 *      the `tools/call` response and lets `@effect/ai`'s `McpServer` encode
 *      a `ToolError` failure into `CallToolResult{isError:true}`; the FUTURE
 *      wire/codec path adapts the same arm to the unified `Effect<string>`
 *      `ToolExecutor` + a `ToolResultEvent` relay. The stringify+relay is
 *      wire-delivery machinery, never intrinsic to a tool, so it does NOT
 *      live here (`docs/architecture/shape-c-vs-shape-d.md`).
 *
 *   2. `McpToolDispatchWorkflow` + `ToolDispatch` — the MCP-entry binding.
 *      A bounded Shape D workflow, at-most-once via
 *      `Workflow.idempotencyKey` over `toolUseId` alone (no separate result
 *      table). RELAY-FREE by construction: an MCP `tools/call` is a
 *      synchronous request/response, so the result is returned in that
 *      response — there is no parked session turn to relay into. So this
 *      path touches neither `SignalTable` nor `permission-and-tool.ts`, and
 *      builds NO `ToolResultEvent` / `AgentInputEvent`.
 *
 * A tool failure rides the typed error channel (`ToolError`) all the way to
 * the toolkit handler, which fails with it; `@effect/ai`'s
 * `McpServer.registerToolkit` (default `failureMode: "error"`) catches that
 * via `Effect.match` and builds `CallToolResult{isError:true,
 * structuredContent: <ToolError>}` without crashing the host or workflow.
 * We never construct the MCP result ourselves.
 *
 * The wait family shares one lowering shape: no prompt resolves inline in
 * the MCP response; prompt-bearing waits append the prompt to the owning
 * runtime context after the wait resolves, using the host prompt channel's
 * idempotency key as the replay fence.
 */

import { Activity, Workflow, WorkflowEngine } from "@effect/workflow"
import * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import { HostPromptChannel } from "@firegrid/protocol/channels"
import { Clock, Context, Duration, Effect, Layer, Option, ParseResult, Ref, Schema, Stream } from "effect"
import { RuntimeChannelRouter } from "../../channels/router.ts"
import { traversePath } from "../../transforms/field-equals.ts"
import {
  ToolDispatchPayloadSchema,
  ToolDispatchResultSchema,
  type ToolDispatchPayload,
} from "../subscribers/permission-and-tool.ts"
import {
  ToolError,
  toolExecutionFailed,
  toolInvalidInputFromParseError,
} from "./tool-error.ts"

// ---------------------------------------------------------------------------
// Typed per-tool arms — the single shared lowering
// ---------------------------------------------------------------------------

const decodeJson = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknown(Schema.parseJson(schema))

const relativeTimePattern = /^\+(\d+)(ms|s|m|h|d|w)$/

const relativeUnitMs: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const parseWaitDelayMs = (
  time: string,
): Effect.Effect<number, string> =>
  Effect.gen(function*() {
    const relative = relativeTimePattern.exec(time)
    if (relative !== null) {
      const amount = Number(relative[1])
      const unit = relativeUnitMs[relative[2] ?? ""]
      if (Number.isSafeInteger(amount) && unit !== undefined) {
        return amount * unit
      }
    }
    const absolute = Date.parse(time)
    if (Number.isNaN(absolute)) {
      return yield* Effect.fail(
        `invalid wait_until time "${time}"; expected ISO timestamp or relative +Nms|s|m|h|d|w`,
      )
    }
    const now = yield* Clock.currentTimeMillis
    return Math.max(0, absolute - now)
  })

const appendPromptOnResolve = (
  contextId: string,
  toolUseId: string,
  toolName: string,
  prompt: string | undefined,
): Effect.Effect<void, ToolError> => {
  if (prompt === undefined) return Effect.void
  return Effect.serviceOption(HostPromptChannel).pipe(
    Effect.flatMap(Option.match({
      onNone: () =>
        Effect.fail(
          toolExecutionFailed(
            toolUseId,
            toolName,
            "prompt-bearing waits require HostPromptChannel",
          ),
        ),
      onSome: channel =>
        channel.binding.append({
          contextId,
          payload: prompt,
          idempotencyKey: `wait-prompt:${toolUseId}`,
        }).pipe(
          Effect.asVoid,
          Effect.mapError(cause => toolExecutionFailed(toolUseId, toolName, cause)),
        ),
    })),
  )
}

const matchesRow = (
  row: unknown,
  match: AgentToolSchemas.WaitForToolMatch | undefined,
): boolean => {
  if (match === undefined) return true
  return Object.entries(match).every(([key, value]) =>
    traversePath(row, key.split(".").filter(segment => segment.length > 0)) === value)
}

const waitOnChannel = (
  toolUseId: string,
  toolName: string,
  channelName: string,
  match: AgentToolSchemas.WaitForToolMatch | undefined,
): Effect.Effect<unknown, ToolError> =>
  Effect.serviceOption(RuntimeChannelRouter).pipe(
    Effect.flatMap(Option.match({
      onNone: () =>
        Effect.fail(
          toolExecutionFailed(
            toolUseId,
            toolName,
            "wait tools require RuntimeChannelRouter",
          ),
        ),
      onSome: router =>
        router.route(channelName).pipe(
          Effect.flatMap(route => route.stream === undefined
            ? Effect.fail(
              toolExecutionFailed(
                toolUseId,
                toolName,
                `channel "${channelName}" is not ingress-capable`,
              ),
            )
            : route.stream.pipe(
              Stream.filter(row => matchesRow(row, match)),
              Stream.runHead,
              Effect.flatMap(Option.match({
                onNone: () => Effect.never,
                onSome: row => Effect.succeed(row),
              })),
              Effect.mapError(cause =>
                toolExecutionFailed(toolUseId, toolName, cause)),
            )),
          Effect.mapError(cause => toolExecutionFailed(toolUseId, toolName, cause)),
        ),
    })),
  )

/**
 * `sleep` — suspend until a duration elapses, then return `{ slept: true }`.
 *
 * Maps onto `Clock.sleep` — the PERMANENT answer for the MCP-entry path,
 * not a shortcut: an MCP `tools/call` is synchronous request/response, so
 * the durability boundary is the agent connection (if the host dies
 * mid-sleep the connection drops and the agent re-issues). Durable
 * wire-path sleep (body-level `DurableClock.sleep`) is tracked separately
 * (tf-qmkn); it cannot live inside this dispatch's `Activity.make` because
 * `Activity.make`'s interrupt-retry fights `Workflow.suspend`.
 */
const runSleep = (
  input: AgentToolSchemas.SleepToolInput,
): Effect.Effect<AgentToolSchemas.SleepToolOutput, ToolError> =>
  Clock.sleep(Duration.millis(input.durationMs)).pipe(
    Effect.as({ slept: true } satisfies AgentToolSchemas.SleepToolOutput),
  )

const runWaitUntil = (
  contextId: string,
  toolUseId: string,
  input: AgentToolSchemas.WaitUntilToolInput,
): Effect.Effect<AgentToolSchemas.WaitUntilToolOutput, ToolError> =>
  parseWaitDelayMs(input.time).pipe(
    Effect.mapError(cause => toolExecutionFailed(toolUseId, "wait_until", cause)),
    Effect.flatMap(delay =>
      Clock.sleep(Duration.millis(delay)).pipe(
        Effect.andThen(appendPromptOnResolve(contextId, toolUseId, "wait_until", input.prompt)),
        Effect.as({
          waited: true,
          firedAt: new Date().toISOString(),
        } satisfies AgentToolSchemas.WaitUntilToolOutput),
      ),
    ),
  )

const runWaitFor = (
  contextId: string,
  toolUseId: string,
  input: AgentToolSchemas.WaitForToolInput,
): Effect.Effect<AgentToolSchemas.WaitForToolOutput, ToolError> => {
  const match = input.match ?? input.event.match
  const timeoutMs = input.timeoutMs ?? input.event.timeoutMs
  const wait = waitOnChannel(toolUseId, "wait_for", input.event.channel, match).pipe(
    Effect.map(event => ({ matched: true, event }) satisfies AgentToolSchemas.WaitForToolOutput),
  )
  const bounded = timeoutMs === undefined
    ? wait
    : Effect.raceFirst(
      wait,
      Clock.sleep(Duration.millis(timeoutMs)).pipe(
        Effect.as({
          matched: false,
          timedOut: true,
        } satisfies AgentToolSchemas.WaitForToolOutput),
      ),
    )
  return bounded.pipe(
    Effect.tap(() => appendPromptOnResolve(contextId, toolUseId, "wait_for", input.prompt)),
  )
}

const runWaitAny = (
  contextId: string,
  toolUseId: string,
  input: AgentToolSchemas.WaitAnyToolInput,
): Effect.Effect<AgentToolSchemas.WaitAnyToolOutput, ToolError> => {
  const waits = input.events.map((event, winnerIndex) =>
    waitOnChannel(toolUseId, "wait_any", event.channel, event.match).pipe(
      Effect.map(result => ({
        winnerIndex,
        channel: event.channel,
        result,
      }) satisfies AgentToolSchemas.WaitAnyToolOutput),
    ),
  )
  const wait = Effect.raceAll(
    waits as [
      Effect.Effect<AgentToolSchemas.WaitAnyToolOutput, ToolError>,
      ...Array<Effect.Effect<AgentToolSchemas.WaitAnyToolOutput, ToolError>>,
    ],
  )
  const bounded = input.timeoutMs === undefined
    ? wait
    : Effect.raceFirst(
      wait,
      Clock.sleep(Duration.millis(input.timeoutMs)).pipe(
        Effect.as({
          timedOut: true,
        } satisfies AgentToolSchemas.WaitAnyToolOutput),
      ),
    )
  return bounded.pipe(
    Effect.tap(() => appendPromptOnResolve(contextId, toolUseId, "wait_any", input.prompt)),
  )
}

/**
 * Lower a `(toolName, inputJson)` invocation to a typed arm, decode its
 * input against the protocol schema, run it, and JSON-encode the success
 * output. Decode failures become a typed `ToolInvalidInput`; unported tools
 * a typed `ToolExecutionFailed`. The error channel is `ToolError` — the
 * `@effect/ai` failure schema — so the toolkit handler can fail with it and
 * the library encodes the MCP `isError` result.
 */
const dispatchArm = (
  contextId: string,
  toolName: string,
  toolUseId: string,
  inputJson: string,
): Effect.Effect<string, ToolError> => {
  switch (toolName) {
    case "sleep":
      return decodeJson(AgentToolSchemas.SleepToolInputSchema)(inputJson).pipe(
        Effect.mapError((cause): ToolError =>
          cause instanceof ParseResult.ParseError
            ? toolInvalidInputFromParseError(toolUseId, "sleep", cause)
            : toolExecutionFailed(toolUseId, "sleep", cause)),
        Effect.flatMap(runSleep),
        Effect.map((output) => JSON.stringify(output)),
      )
    case "wait_until":
      return decodeJson(AgentToolSchemas.WaitUntilToolInputSchema)(inputJson).pipe(
        Effect.mapError((cause): ToolError =>
          cause instanceof ParseResult.ParseError
            ? toolInvalidInputFromParseError(toolUseId, "wait_until", cause)
            : toolExecutionFailed(toolUseId, "wait_until", cause)),
        Effect.flatMap(input => runWaitUntil(contextId, toolUseId, input)),
        Effect.map((output) => JSON.stringify(output)),
      )
    case "wait_for":
      return decodeJson(AgentToolSchemas.WaitForToolInputSchema)(inputJson).pipe(
        Effect.mapError((cause): ToolError =>
          cause instanceof ParseResult.ParseError
            ? toolInvalidInputFromParseError(toolUseId, "wait_for", cause)
            : toolExecutionFailed(toolUseId, "wait_for", cause)),
        Effect.flatMap(input => runWaitFor(contextId, toolUseId, input)),
        Effect.map((output) => JSON.stringify(output)),
      )
    case "wait_any":
      return decodeJson(AgentToolSchemas.WaitAnyToolInputSchema)(inputJson).pipe(
        Effect.mapError((cause): ToolError =>
          cause instanceof ParseResult.ParseError
            ? toolInvalidInputFromParseError(toolUseId, "wait_any", cause)
            : toolExecutionFailed(toolUseId, "wait_any", cause)),
        Effect.flatMap(input => runWaitAny(contextId, toolUseId, input)),
        Effect.map((output) => JSON.stringify(output)),
      )
    default:
      return Effect.fail(
        toolExecutionFailed(
          toolUseId,
          toolName,
          `tool "${toolName}" is not yet ported onto the unified executor`,
        ),
      )
  }
}

export interface FiregridAgentToolExecutorState {
  /** Increments per genuine arm invocation. Asserted `== 1` per `toolUseId`. */
  readonly invocationCount: Ref.Ref<number>
}

export interface FiregridAgentToolExecutor {
  readonly state: FiregridAgentToolExecutorState
  /** Run the lowering for `payload`, returning the JSON-encoded tool output. */
  readonly execute: (
    payload: ToolDispatchPayload,
  ) => Effect.Effect<string, ToolError>
}

/**
 * Build the shared `FiregridAgentToolExecutor`. The MCP-entry workflow
 * below drives it; the future wire path will adapt the same arms.
 *
 * `invocationCount` is the Shape D at-most-once witness: incremented per
 * genuine arm invocation, asserted `== 1` per `toolUseId` across
 * replay/restart (`Workflow.idempotencyKey` memoizes the enclosing
 * Activity success, so the arm runs once).
 */
export const makeFiregridAgentToolExecutor = (): Effect.Effect<FiregridAgentToolExecutor> =>
  Effect.gen(function*() {
    const invocationCount = yield* Ref.make(0)
    return {
      state: { invocationCount },
      execute: (payload) =>
        Ref.update(invocationCount, (n) => n + 1).pipe(
          Effect.andThen(dispatchArm(payload.contextId, payload.toolName, payload.toolUseId, payload.inputJson)),
        ),
    }
  })

// ---------------------------------------------------------------------------
// McpToolDispatchWorkflow — relay-free Shape D MCP-entry binding
// ---------------------------------------------------------------------------
//
// Reuses the unified `ToolDispatchPayloadSchema` / `ToolDispatchResultSchema`
// (same wire shape; `attempt` is a structural artifact of the payload —
// for MCP entry there is no session attempt, so the facade pins it).
// At-most-once is `Workflow.idempotencyKey: toolUseId` alone. The typed
// `error: ToolError` carries a tool failure to the facade/handler; the body
// wraps the arm in one `Activity.make` and returns — NO relay, NO
// `SignalTable`.

export const McpToolDispatchWorkflow = Workflow.make({
  name: "unified.mcp-tool-dispatch",
  payload: ToolDispatchPayloadSchema,
  success: ToolDispatchResultSchema,
  error: ToolError,
  idempotencyKey: ({ toolUseId }) => toolUseId,
})

const mcpToolDispatchBody = (executor: FiregridAgentToolExecutor) =>
  (payload: ToolDispatchPayload) =>
    Effect.gen(function*() {
      const resultJson = yield* Activity.make({
        name: `unified.mcp-tool.execute/${payload.toolUseId}`,
        success: Schema.String,
        error: ToolError,
        execute: executor.execute(payload),
      })
      return { toolUseId: payload.toolUseId, resultJson }
    }) as Effect.Effect<
      Schema.Schema.Type<typeof ToolDispatchResultSchema>,
      ToolError,
      WorkflowEngine.WorkflowEngine
    >

export const buildMcpToolDispatchLayer = (executor: FiregridAgentToolExecutor) =>
  McpToolDispatchWorkflow.toLayer(mcpToolDispatchBody(executor))

// ---------------------------------------------------------------------------
// ToolDispatch facade — the narrow seam the toolkit handlers consume
// ---------------------------------------------------------------------------

export interface ToolDispatchInput {
  readonly contextId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
}

export interface ToolDispatchService {
  /**
   * Run the tool at-most-once (keyed on `toolUseId`) and return the decoded
   * tool output. A tool failure surfaces on the typed `ToolError` channel —
   * the toolkit handler fails with it and `McpServer` encodes the MCP
   * `isError` result.
   */
  readonly call: (
    input: ToolDispatchInput,
  ) => Effect.Effect<unknown, ToolError>
}

export class ToolDispatch extends Context.Tag(
  "@firegrid/runtime/unified/mcp-host/ToolDispatch",
)<ToolDispatch, ToolDispatchService>() {}

// MCP entry has no session attempt; the workflow is keyed on toolUseId, so
// the attempt value is inert. Pin a constant to satisfy the shared payload.
const MCP_ENTRY_ATTEMPT = 1

/**
 * Host-scope install of the MCP-entry tool-dispatch facade. Co-installs the
 * relay-free workflow handler on the host-scoped `WorkflowEngine` and
 * provides a `ToolDispatch` Tag whose `.call` closes over the resolved
 * engine. R-channel is exactly `{WorkflowEngine}`.
 */
export const ToolDispatchLive: Layer.Layer<
  ToolDispatch,
  never,
  WorkflowEngine.WorkflowEngine
> = Layer.unwrapEffect(
  Effect.gen(function*() {
    const executor = yield* makeFiregridAgentToolExecutor()
    return Layer.merge(
      buildMcpToolDispatchLayer(executor),
      Layer.effect(
        ToolDispatch,
        Effect.gen(function*() {
          const engine = yield* WorkflowEngine.WorkflowEngine
          return ToolDispatch.of({
            call: ({ contextId, toolUseId, toolName, input }) =>
              McpToolDispatchWorkflow.execute({
                contextId,
                attempt: MCP_ENTRY_ATTEMPT,
                toolUseId,
                toolName,
                inputJson: JSON.stringify(input),
              }).pipe(
                Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
                Effect.map((result) => JSON.parse(result.resultJson) as unknown),
              ),
          })
        }),
      ),
    )
  }),
)
