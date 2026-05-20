import { DurableClock, type WorkflowEngine } from "@effect/workflow"
import type {
  CallToolInput,
  CallToolOutput,
  SendToolInput,
  SendToolOutput,
  SleepToolInput,
  SleepToolOutput,
  WaitForAnyToolInput,
  WaitForAnyToolOutput,
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

export interface RuntimeWaitForAnyDescriptorExecution {
  readonly winnerIndex: number
  readonly channel: string
  readonly wait: Effect.Effect<unknown, unknown, never>
}

export interface RuntimeWaitForAnyToolExecutionParams
  extends RuntimeToolExecutionContext
{
  readonly input: WaitForAnyToolInput
  readonly waits: ReadonlyArray<RuntimeWaitForAnyDescriptorExecution>
}

export interface RuntimeSendToolExecutionParams
  extends RuntimeToolExecutionContext
{
  readonly input: SendToolInput
  readonly append: Effect.Effect<void, unknown, never>
}

export interface RuntimeCallToolExecutionParams
  extends RuntimeToolExecutionContext
{
  readonly input: CallToolInput
  readonly call: Effect.Effect<CallToolOutput, unknown, never>
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
  readonly waitForAny: (
    params: RuntimeWaitForAnyToolExecutionParams,
  ) => Effect.Effect<WaitForAnyToolOutput, RuntimeAgentToolExecutionError>
  readonly send: (
    params: RuntimeSendToolExecutionParams,
  ) => Effect.Effect<SendToolOutput, RuntimeAgentToolExecutionError>
  readonly call: (
    params: RuntimeCallToolExecutionParams,
  ) => Effect.Effect<CallToolOutput, RuntimeAgentToolExecutionError>
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

const toolExecutionFailed = (
  cause: unknown,
): RuntimeAgentToolExecutionError => ({
  _tag: "ToolExecutionFailed",
  cause,
})

const waitForAnyDescriptorOutput = (
  descriptor: RuntimeWaitForAnyDescriptorExecution,
): Effect.Effect<WaitForAnyToolOutput, RuntimeAgentToolExecutionError> =>
  descriptor.wait.pipe(
    Effect.map(result => ({
      winnerIndex: descriptor.winnerIndex,
      channel: descriptor.channel,
      result,
    })),
    Effect.mapError(toolExecutionFailed),
  )

const waitForAny = (
  params: RuntimeWaitForAnyToolExecutionParams,
): Effect.Effect<WaitForAnyToolOutput, RuntimeAgentToolExecutionError> => {
  const raced = Effect.raceAll(
    params.waits.map(waitForAnyDescriptorOutput),
  )
  if (params.input.timeoutMs === undefined) return raced
  return raced.pipe(
    Effect.timeoutTo({
      duration: Duration.millis(params.input.timeoutMs),
      onSuccess: output => output,
      onTimeout: (): WaitForAnyToolOutput => ({ timedOut: true }),
    }),
  )
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
        Effect.mapError(toolExecutionFailed),
      ),
    waitForAny,
    send: ({ input, append }) =>
      append.pipe(
        Effect.as<SendToolOutput>({ sent: true, channel: input.channel }),
        Effect.mapError(toolExecutionFailed),
      ),
    call: ({ call }) =>
      call.pipe(
        Effect.mapError(toolExecutionFailed),
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
