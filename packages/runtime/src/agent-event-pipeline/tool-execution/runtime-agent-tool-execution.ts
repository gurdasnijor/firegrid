import { DurableClock, type WorkflowEngine } from "@effect/workflow"
import type {
  SleepToolInput,
  SleepToolOutput,
  WaitForToolInput,
  WaitForToolOutput,
} from "@firegrid/protocol/agent-tools"
import { Context, Duration, Effect, Layer } from "effect"
import type {
  RuntimeObservationSource,
  RuntimeObservationStreams,
} from "../../streams/index.ts"
import type {
  FieldEqualsTrigger,
} from "../../workflow-engine/workflows/field-equals.ts"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  type WaitForWorkflowOutcome,
} from "../../workflow-engine/workflows/wait-for.ts"

export interface RuntimeToolExecutionContext {
  readonly contextId: string
  readonly toolUseId: string
}

export interface RuntimeWaitForToolExecutionParams
  extends RuntimeToolExecutionContext
{
  readonly input: WaitForToolInput
  readonly source: RuntimeObservationSource
  readonly trigger: FieldEqualsTrigger
}

export type RuntimeAgentToolExecutionError =
  | {
    readonly _tag: "InvalidToolInput"
    readonly reason: string
    readonly cause?: unknown
  }
  | {
    readonly _tag: "ToolExecutionFailed"
    readonly cause: unknown
  }
  | {
    readonly _tag: "UnsupportedTool"
    readonly reason: string
  }

/**
 * @effect-expect-leaking WorkflowEngine
 * @effect-expect-leaking WorkflowInstance
 * @effect-expect-leaking RuntimeObservationStreams
 */
export interface RuntimeAgentToolExecutionService {
  readonly sleep: (
    params: RuntimeToolExecutionContext & {
      readonly input: SleepToolInput
    },
  ) => Effect.Effect<
    SleepToolOutput,
    RuntimeAgentToolExecutionError,
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  >
  readonly waitFor: (
    params: RuntimeWaitForToolExecutionParams,
  ) => Effect.Effect<
    WaitForToolOutput,
    RuntimeAgentToolExecutionError,
    | RuntimeObservationStreams
    | WorkflowEngine.WorkflowEngine
    | WorkflowEngine.WorkflowInstance
  >
}

const waitForTimeoutPayload = (
  timeoutMs: number | undefined,
): { readonly timeoutMs?: number } =>
  timeoutMs === undefined
    ? {}
    : { timeoutMs: timeoutMs === 0 ? 1 : timeoutMs }

const waitForWorkflowOutput = (
  outcome: WaitForWorkflowOutcome,
): WaitForToolOutput => {
  switch (outcome._tag) {
    case "Match":
      return { matched: true, event: outcome.raw }
    case "Timeout":
      return { matched: false, timedOut: true }
  }
}

// firegrid-host-sdk.PACKAGE_GRAPH.6
// firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.9
export const makeRuntimeAgentToolExecutionService =
  (): RuntimeAgentToolExecutionService => ({
    sleep: ({ toolUseId, input }) =>
      DurableClock.sleep({
        name: `tool:${toolUseId}`,
        duration: Duration.millis(input.durationMs),
        inMemoryThreshold: Duration.zero,
      }).pipe(Effect.as<SleepToolOutput>({ slept: true })),
    waitFor: ({ contextId, toolUseId, input, source, trigger }) =>
      WaitForWorkflow.execute({
        executionKey: `wait:${contextId}:${toolUseId}`,
        source,
        trigger,
        ...waitForTimeoutPayload(input.timeoutMs),
      }).pipe(
        Effect.provide(WaitForWorkflowLayer),
        Effect.map(waitForWorkflowOutput),
        Effect.mapError((cause): RuntimeAgentToolExecutionError => ({
          _tag: "ToolExecutionFailed",
          cause,
        })),
      ),
  })

/**
 * @effect-expect-leaking WorkflowEngine
 * @effect-expect-leaking WorkflowInstance
 * @effect-expect-leaking RuntimeObservationStreams
 */
export class RuntimeAgentToolExecution extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentToolExecution",
)<RuntimeAgentToolExecution, RuntimeAgentToolExecutionService>() {
  static layer = (
    service: RuntimeAgentToolExecutionService,
  ): Layer.Layer<RuntimeAgentToolExecution> => Layer.succeed(this, service)
}
