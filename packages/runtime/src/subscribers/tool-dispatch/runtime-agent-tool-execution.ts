import { DurableClock } from "@effect/workflow"
import type {
  CallToolInput,
  CallToolOutput,
  ScheduleMeToolInput,
  ScheduleMeToolOutput,
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
} from "../../streams/index.ts"
export type { RuntimeObservationSource } from "../../streams/index.ts"
import type {
  FieldEqualsTrigger,
} from "../../transforms/field-equals.ts"
export {
  evaluateFieldEquals,
  type FieldEqualsTrigger,
} from "../../transforms/field-equals.ts"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  type WaitForWorkflowOutcome,
} from "../wait-router/workflow.ts"
import {
  ScheduledPromptWorkflow,
} from "../scheduled-prompt/workflow.ts"

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
  readonly channel: string
  // tf-0xe4: serializable observation source + trigger (was an in-memory
  // `wait` Effect). wait_for_any now races these inside the durable
  // WaitForWorkflow Activity instead of an in-memory Effect.raceAll.
  readonly source: RuntimeObservationSource
  readonly trigger: FieldEqualsTrigger
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

export interface RuntimeScheduleToolExecutionParams
  extends RuntimeToolExecutionContext
{
  readonly input: ScheduleMeToolInput
  readonly scheduleId: string
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

export interface RuntimeAgentToolExecutionService {
  readonly sleep: (
    params: RuntimeToolExecutionContext & {
      readonly input: SleepToolInput
    },
  ) => Effect.Effect<
    SleepToolOutput,
    RuntimeAgentToolExecutionError
  >
  readonly waitFor: (
    params: RuntimeWaitForToolExecutionParams,
  ) => Effect.Effect<
    WaitForToolOutput,
    RuntimeAgentToolExecutionError
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
  readonly schedule: (
    params: RuntimeScheduleToolExecutionParams,
  ) => Effect.Effect<ScheduleMeToolOutput, RuntimeAgentToolExecutionError>
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

// tf-0xe4: wait_for_any over the durable WaitForWorkflow. The N descriptor
// sources are raced inside one journaled workflow Activity (primary +
// additionalSources), so an in-flight wait_for_any survives host restart. The
// workflow returns the winning source's index; map it back to the channel.
const waitForAny = (
  params: RuntimeWaitForAnyToolExecutionParams,
): Effect.Effect<WaitForAnyToolOutput, RuntimeAgentToolExecutionError> => {
  const { contextId, toolUseId, input, waits } = params
  const [primary, ...rest] = waits
  if (primary === undefined) {
    return Effect.fail<RuntimeAgentToolExecutionError>({
      _tag: "InvalidToolInput",
      reason: "wait_for_any requires at least one channel",
    })
  }
  return WaitForWorkflow.execute({
    executionKey: `wait-any:${contextId}:${toolUseId}`,
    source: primary.source,
    trigger: primary.trigger,
    additionalSources: rest.map(descriptor => ({
      source: descriptor.source,
      trigger: descriptor.trigger,
    })),
    ...waitForTimeoutPayload(input.timeoutMs),
  }).pipe(
    Effect.provide(WaitForWorkflowLayer),
    Effect.map((outcome): WaitForAnyToolOutput => {
      if (outcome._tag === "Timeout") return { timedOut: true }
      const winnerIndex = outcome.winnerIndex ?? 0
      return {
        winnerIndex,
        channel: waits[winnerIndex]?.channel ?? primary.channel,
        result: outcome.raw,
      }
    }),
    Effect.mapError(toolExecutionFailed),
    hideExecutionRequirements,
  )
}

const hideExecutionRequirements = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, never> =>
  effect as Effect.Effect<A, E, never>

// firegrid-host-sdk.PACKAGE_GRAPH.6
// firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.9
export const makeRuntimeAgentToolExecutionService =
  (): RuntimeAgentToolExecutionService => ({
    sleep: ({ toolUseId, input }) =>
      DurableClock.sleep({
        name: `tool:${toolUseId}`,
        duration: Duration.millis(input.durationMs),
        inMemoryThreshold: Duration.zero,
      }).pipe(
        Effect.as<SleepToolOutput>({ slept: true }),
        hideExecutionRequirements,
      ),
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
        hideExecutionRequirements,
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
    // tf-5ose: start the durable, replay-safe ScheduledPromptWorkflow
    // fire-and-forget (`discard: true` returns the executionId without awaiting
    // the timer) and return {scheduled:true} immediately, so the agent's turn
    // completes now and the self-prompt fires later. idempotencyKey = scheduleId
    // makes a replay re-start a no-op; the workflow handler is registered on the
    // host-engine scope (toolCallWorkflowSupportLayer) so the engine resumes it
    // after the delay. (NOT awaited inline like the prior DurableClock.sleep,
    // which blocked the turn until `when` and timed the edge out.)
    schedule: ({ contextId, scheduleId, input }) =>
      ScheduledPromptWorkflow.execute(
        { contextId, scheduleId, when: input.when, prompt: input.prompt },
        { discard: true },
      ).pipe(
        Effect.as<ScheduleMeToolOutput>({ scheduled: true, scheduleId }),
        Effect.mapError(toolExecutionFailed),
        hideExecutionRequirements,
      ),
  })

export class RuntimeAgentToolExecution extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentToolExecution",
)<RuntimeAgentToolExecution, RuntimeAgentToolExecutionService>() {
  static layer = (
    service: RuntimeAgentToolExecutionService,
  ): Layer.Layer<RuntimeAgentToolExecution> => Layer.succeed(this, service)
}

export const RuntimeAgentToolExecutionLive = RuntimeAgentToolExecution.layer(
  makeRuntimeAgentToolExecutionService(),
).pipe(
  Layer.withSpan("firegrid.runtime.agent_tool_execution.layer", {
    kind: "internal",
  }),
)
