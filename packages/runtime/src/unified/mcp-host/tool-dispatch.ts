/**
 * THE REWIRE (tf-r06u.28 slice 2) — the shared agent-tool executor plus
 * the relay-free MCP-entry dispatch surface, both built over #765's
 * unified substrate.
 *
 * Two collaborators live here:
 *
 *   1. `FiregridAgentToolExecutor` — the SINGLE shared lowering. It
 *      implements the unified `ToolExecutor` interface
 *      (`../subscribers/permission-and-tool.ts`): `execute(payload) =>
 *      Effect<string>`, switching on `payload.toolName` and mapping each
 *      tool onto a #765 substrate primitive. There is deliberately ONE
 *      executor; the two entry paths (wire/codec via
 *      `ToolDispatchWorkflow`, and MCP-entry via `McpToolDispatchWorkflow`
 *      below) share it. What differs per path is only the body /
 *      durability / delivery shape, never the executor — that is the line
 *      that keeps this faithful to the #765 dual-dispatch collapse
 *      (`docs/architecture/shape-c-vs-shape-d.md`).
 *
 *   2. `McpToolDispatchWorkflow` + `ToolDispatch` — the MCP-entry binding.
 *      A bounded Shape D workflow, at-most-once via
 *      `Workflow.idempotencyKey` over `toolUseId` alone (no separate
 *      result table — `docs/architecture/shape-c-vs-shape-d.md` §Decision
 *      table; `packages/tiny-firegrid/test/shape-d-tool-dispatch-mcp-entry`).
 *      RELAY-FREE by construction: an MCP `tools/call` is a synchronous
 *      request/response, so the result is returned in that response — there
 *      is no parked session turn to relay a `tool-result` signal into (that
 *      relay is the wire/codec path's concern, baked into
 *      `ToolDispatchWorkflow`). So this path touches neither `SignalTable`
 *      nor `permission-and-tool.ts`.
 *
 * Slice-2 scope is `sleep` only. `sleep` has a clean Shape D answer; the
 * suspending tools (`wait_for` / `wait_for_any`, which park on a domain
 * signal) are a separate, harder milestone gated on the kernel-owned
 * write+arm direction (tf-12q9 / tf-c9r9) and are NOT attempted here. Every
 * other tool returns a typed "not yet ported" result so the surface stays
 * honest.
 */

import { Activity, Workflow, WorkflowEngine } from "@effect/workflow"
import * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import { Clock, Context, Duration, Effect, Layer, ParseResult, Ref, Schema } from "effect"
import type { AgentInputEvent } from "../../events/index.ts"
import {
  ToolDispatchPayloadSchema,
  ToolDispatchResultSchema,
  type ToolDispatchPayload,
  type ToolExecutor,
} from "../subscribers/permission-and-tool.ts"
import {
  toolErrorResult,
  toolExecutionFailed,
  toolInvalidInputFromParseError,
  toolResult,
} from "./tool-error.ts"

type ToolResultEvent = Extract<AgentInputEvent, { _tag: "ToolResult" }>

// ---------------------------------------------------------------------------
// FiregridAgentToolExecutor — the single shared lowering
// ---------------------------------------------------------------------------

const decodeJson = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknown(Schema.parseJson(schema))

/**
 * `sleep` — durably suspend until a duration elapses.
 *
 * Maps onto `Clock.sleep`. Per the sleep spike
 * (`docs/findings/tf-r06u-28-sleep-spike-suspension-boundary.md`), this is
 * the PERMANENT answer for the MCP-entry path, not a shortcut: an MCP
 * `tools/call` is synchronous request/response, so the durability boundary
 * is the agent connection — if the host dies mid-sleep the connection drops
 * and the agent re-issues. (Durable wire-path sleep — body-level
 * `DurableClock.sleep` — is tracked separately; it cannot live inside this
 * executor's Activity because `Activity.make`'s interrupt-retry fights
 * `Workflow.suspend`.)
 */
const runSleep = (
  toolUseId: string,
  inputJson: string,
): Effect.Effect<ToolResultEvent> =>
  decodeJson(AgentToolSchemas.SleepToolInputSchema)(inputJson).pipe(
    Effect.flatMap((input) =>
      Clock.sleep(Duration.millis(input.durationMs)).pipe(
        Effect.as(
          toolResult(toolUseId, "sleep", {
            slept: true,
          } satisfies AgentToolSchemas.SleepToolOutput),
        ),
      ),
    ),
    Effect.catchAll((cause) =>
      Effect.succeed(
        cause instanceof ParseResult.ParseError
          ? toolErrorResult(
              toolInvalidInputFromParseError(toolUseId, "sleep", cause),
            )
          : toolErrorResult(toolExecutionFailed(toolUseId, "sleep", cause)),
      ),
    ),
  )

/**
 * Tools exposed by `FiregridAgentToolkit` but not yet ported onto the
 * unified executor. Returns a structured `ToolExecutionFailed` result (an
 * agent-visible error, not a workflow failure) so the surface is honest
 * about scope rather than silently mis-dispatching.
 */
const runNotYetPorted = (
  toolUseId: string,
  toolName: string,
): Effect.Effect<ToolResultEvent> =>
  Effect.succeed(
    toolErrorResult(
      toolExecutionFailed(
        toolUseId,
        toolName,
        `tool "${toolName}" is not yet ported onto the unified executor (tf-r06u.28 slice 2 scope = sleep)`,
      ),
    ),
  )

const dispatchByName = (payload: ToolDispatchPayload): Effect.Effect<ToolResultEvent> => {
  switch (payload.toolName) {
    case "sleep":
      return runSleep(payload.toolUseId, payload.inputJson)
    default:
      return runNotYetPorted(payload.toolUseId, payload.toolName)
  }
}

/**
 * Build the shared `FiregridAgentToolExecutor`. Conforms to the unified
 * `ToolExecutor` interface so it can drive BOTH the wire-path
 * `ToolDispatchWorkflow` (via `buildToolDispatchLayer`) and the MCP-entry
 * `McpToolDispatchWorkflow` below — one executor, two bodies.
 *
 * `invocationCount` is the Shape D at-most-once witness: incremented on
 * each genuine executor invocation, asserted `== 1` per `toolUseId` across
 * replay/restart (`Workflow.idempotencyKey` memoizes the enclosing
 * Activity, so the executor runs once).
 */
export const makeFiregridAgentToolExecutor = (): Effect.Effect<ToolExecutor> =>
  Effect.gen(function*() {
    const invocationCount = yield* Ref.make(0)
    return {
      state: { invocationCount },
      execute: (payload) =>
        Effect.gen(function*() {
          yield* Ref.update(invocationCount, (n) => n + 1)
          const event = yield* dispatchByName(payload)
          return JSON.stringify(event)
        }),
    }
  })

// ---------------------------------------------------------------------------
// McpToolDispatchWorkflow — relay-free Shape D MCP-entry binding
// ---------------------------------------------------------------------------
//
// Reuses the unified `ToolDispatchPayloadSchema` / `ToolDispatchResultSchema`
// (same wire shape; `attempt` is a structural artifact of the shared
// executor signature — for MCP entry there is no session attempt, so the
// facade pins it). At-most-once is `Workflow.idempotencyKey: toolUseId`
// alone. The body wraps the shared executor in one `Activity.make` and
// returns — NO `sendSignal` relay, NO `SignalTable`.

export const McpToolDispatchWorkflow = Workflow.make({
  name: "unified.mcp-tool-dispatch",
  payload: ToolDispatchPayloadSchema,
  success: ToolDispatchResultSchema,
  idempotencyKey: ({ toolUseId }) => toolUseId,
})

const mcpToolDispatchBody = (executor: ToolExecutor) =>
  (payload: ToolDispatchPayload) =>
    Effect.gen(function*() {
      const resultJson = yield* Activity.make({
        name: `unified.mcp-tool.execute/${payload.toolUseId}`,
        success: Schema.String,
        execute: executor.execute(payload),
      })
      return { toolUseId: payload.toolUseId, resultJson }
    }) as Effect.Effect<
      Schema.Schema.Type<typeof ToolDispatchResultSchema>,
      never,
      WorkflowEngine.WorkflowEngine
    >

export const buildMcpToolDispatchLayer = (executor: ToolExecutor) =>
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

/**
 * Narrow failure for the facade. The toolkit handler maps this to the
 * MCP-facing failure schema; the runtime side stays decoupled.
 */
export interface ToolDispatchFailure {
  readonly _tag: "ToolDispatchFailure"
  readonly toolUseId: string
  readonly toolName: string
  readonly cause: unknown
}

export interface ToolDispatchService {
  readonly call: (
    input: ToolDispatchInput,
  ) => Effect.Effect<ToolResultEvent, ToolDispatchFailure>
}

export class ToolDispatch extends Context.Tag(
  "@firegrid/runtime/unified/mcp-host/ToolDispatch",
)<ToolDispatch, ToolDispatchService>() {}

// MCP entry has no session attempt; the workflow is keyed on toolUseId, so
// the attempt value is inert. Pin a constant to satisfy the shared payload.
const MCP_ENTRY_ATTEMPT = 1

/**
 * Host-scope install of the MCP-entry tool-dispatch facade.
 *
 * Composition mirrors the Shape D MCP-entry proof
 * (`shape-d-tool-dispatch-mcp-entry`): co-install the relay-free workflow
 * handler on the host-scoped `WorkflowEngine`, and provide a `ToolDispatch`
 * Tag whose `.call` closes over the resolved engine and re-provides it into
 * `McpToolDispatchWorkflow.execute(...)`. So a caller (the MCP toolkit
 * handler) resolves the Tag from any scope without re-resolving the engine.
 * The facade's R-channel is exactly `{WorkflowEngine}`.
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
                Effect.map((result) =>
                  JSON.parse(result.resultJson) as ToolResultEvent,
                ),
                Effect.mapError((cause): ToolDispatchFailure => ({
                  _tag: "ToolDispatchFailure",
                  toolUseId,
                  toolName,
                  cause,
                })),
              ),
          })
        }),
      ),
    )
  }),
)
