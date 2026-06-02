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
 * Slice-2 scope is `sleep` only. `sleep` has a clean Shape D answer
 * (`Clock.sleep` — the permanent MCP-path answer; see
 * `docs/findings/tf-r06u-28-sleep-spike-suspension-boundary.md`). Every
 * other tool fails with a typed `ToolExecutionFailed` "not yet ported" so
 * the surface stays honest. `wait_for` / `wait_for_any` (domain-signal
 * suspend) are a separate, harder milestone (tf-12q9 / tf-c9r9).
 */

import { Activity, Workflow, WorkflowEngine } from "@effect/workflow"
import * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import { Clock, Context, Duration, Effect, Layer, ParseResult, Ref, Schema } from "effect"
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

/**
 * Lower a `(toolName, inputJson)` invocation to a typed arm, decode its
 * input against the protocol schema, run it, and JSON-encode the success
 * output. Decode failures become a typed `ToolInvalidInput`; unported tools
 * a typed `ToolExecutionFailed`. The error channel is `ToolError` — the
 * `@effect/ai` failure schema — so the toolkit handler can fail with it and
 * the library encodes the MCP `isError` result.
 */
const dispatchArm = (
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
    default:
      return Effect.fail(
        toolExecutionFailed(
          toolUseId,
          toolName,
          `tool "${toolName}" is not yet ported onto the unified executor (tf-r06u.28 slice 2 scope = sleep)`,
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
          Effect.andThen(dispatchArm(payload.toolName, payload.toolUseId, payload.inputJson)),
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
