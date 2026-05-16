/**
 * `AgentToolHost` — narrow Context service for the host-specific bits of
 * the canonical tool surface that need wiring the lowering function
 * itself does not own.
 *
 * Specifically, the `spawn` family lowers onto `Workflow.execute` over
 * `RuntimeContextWorkflow`, which lives in `runtime-host` and would
 * create a module cycle if imported here. The `execute` arm routes a
 * sandbox-neutral `SandboxRef` to a `SandboxProvider`-backed Effect; the
 * routing policy (which provider serves which `providerName`, how to
 * shape a `SandboxCommand` from the tool-specific `input`) is also a
 * host-side concern.
 *
 * This is NOT a dynamic registry — the interface is a small, static
 * service tag with one method per host-coupled tool family. New tools
 * still require a `Tool.make(...)` entry in `FiregridAgentToolkit` and
 * a matching arm in `tool-use-to-effect.ts`. The Live `AgentToolHost`
 * layer composes runtime primitives; tests provide a stub layer.
 *
 * Implements:
 *  - agent-codec-runtime-tools.md/agent-tool-layer-phase-2 §"PR sequencing",
 *    §"`ScheduledInputWorkflow`" (host-specific activity wiring)
 *  - firegrid-scheduling-tool-bindings.PACKAGE_PLACEMENT.2 (mount Layers
 *    live on @firegrid/runtime)
 */

import { Context, type Effect, Layer } from "effect"
import type {
  SandboxRef,
  SessionCapabilityRef,
  SessionStatus,
  SpawnOptions,
  SpawnTask,
  WorkflowTerminalState,
} from "@firegrid/protocol/agent-tools"
import type { AgentPrompt } from "../agent-event-pipeline/events/index.ts"
import type { ToolExecutionFailedError } from "./tool-error.ts"

export interface SpawnChildContextParams {
  readonly parentContextId: string
  readonly toolUseId: string
  readonly agentKind: string
  readonly prompt: string
  readonly spawnOptions?: SpawnOptions
}

export interface SpawnChildContextResult {
  readonly childContextId: string
  readonly status?: SessionStatus
  readonly terminalState?: WorkflowTerminalState
}

export interface SpawnAllParams {
  readonly parentContextId: string
  readonly toolUseId: string
  readonly tasks: ReadonlyArray<SpawnTask>
}

export interface SpawnAllResult {
  readonly children: ReadonlyArray<{
    readonly key: string
    readonly childContextId: string
    readonly terminalState: WorkflowTerminalState
  }>
}

export interface ExecuteSandboxToolParams {
  readonly toolUseId: string
  readonly sandbox: SandboxRef
  readonly input: unknown
}

export interface ExecuteSessionCapabilityParams {
  readonly toolUseId: string
  readonly sessionId: string
  readonly capability: SessionCapabilityRef
  readonly input: unknown
}

export interface AppendSessionPromptParams {
  readonly toolUseId: string
  readonly sessionId: string
  readonly inputId: string
  readonly prompt: AgentPrompt
}

export interface SessionLifecycleParams {
  readonly toolUseId: string
  readonly sessionId: string
  readonly reason?: string
}

export interface AppendScheduledPromptParams {
  readonly contextId: string
  readonly inputId: string
  readonly prompt: AgentPrompt
}

export interface AgentToolHostService {
  /**
   * Create/start a child `RuntimeContextWorkflow` session.
   * The host derives the child's `contextId` deterministically from
   * `(parentContextId, toolUseId)` for replay-safety.
   */
  readonly spawnChildContext: (
    params: SpawnChildContextParams,
  ) => Effect.Effect<SpawnChildContextResult, ToolExecutionFailedError>

  /**
   * Fan-out variant of `spawnChildContext`. Each child's `childContextId`
   * is deterministic from `(parentContextId, toolUseId, key or index)`.
   */
  readonly spawnChildContexts: (
    params: SpawnAllParams,
  ) => Effect.Effect<SpawnAllResult, ToolExecutionFailedError>

  /**
   * Activity-bounded sandbox-tool dispatch. The host resolves the
   * `SandboxRef.providerName` to a concrete `SandboxProvider` and shapes
   * the call. Returns the raw provider-defined output payload; the
   * sandbox-neutral `execute` tool output is intentionally unknown at
   * this layer.
   */
  readonly executeSandboxTool: (
    params: ExecuteSandboxToolParams,
  ) => Effect.Effect<unknown, ToolExecutionFailedError>

  /**
   * Session-bound capability dispatch. The host resolves the session id
   * to the owning RuntimeContext before touching provider-local state.
   */
  readonly executeSessionCapability: (
    params: ExecuteSessionCapabilityParams,
  ) => Effect.Effect<unknown, ToolExecutionFailedError>

  /**
   * Append a prompt to an existing RuntimeContext-backed session. The
   * host implementation must route through RuntimeContext.host-owned
   * ingress instead of constructing stream URLs at the call site.
   */
  readonly appendSessionPrompt: (
    params: AppendSessionPromptParams,
  ) => Effect.Effect<void, ToolExecutionFailedError>

  readonly cancelSession: (
    params: SessionLifecycleParams,
  ) => Effect.Effect<void, ToolExecutionFailedError>

  readonly closeSession: (
    params: SessionLifecycleParams,
  ) => Effect.Effect<void, ToolExecutionFailedError>

  /**
   * Append a runtime-input row for a future-fired scheduled prompt.
   * Called from inside `ScheduledInputWorkflow`'s body after the
   * `DurableClock.sleep` wakes. The host implementation is responsible
   * for idempotency on `inputId` (so workflow replay does not duplicate
   * the row).
   */
  readonly appendScheduledPrompt: (
    params: AppendScheduledPromptParams,
  ) => Effect.Effect<void, ToolExecutionFailedError>
}

export class AgentToolHost extends Context.Tag(
  "firegrid/agent-tools/AgentToolHost",
)<AgentToolHost, AgentToolHostService>() {
  static layer = (
    service: AgentToolHostService,
  ): Layer.Layer<AgentToolHost> => Layer.succeed(this, service)
}
