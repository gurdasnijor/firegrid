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
import {
  RuntimeObservationStreams,
  type RuntimeObservationSource,
} from "../../streams/index.ts"
import type {
  FieldEqualsTrigger,
} from "../../workflow-engine/workflows/field-equals.ts"
export {
  evaluateFieldEquals,
  type FieldEqualsTrigger,
} from "../../workflow-engine/workflows/field-equals.ts"
import {
  RuntimeWaitCompletionTable,
  runtimeWaitForAnyCompletionKey,
  runtimeWaitForCompletionKey,
  runtimeWaitForMatch,
  type RuntimeWaitForRequest,
  type RuntimeWaitOutcome,
} from "../wait-routing/runtime-wait-completion.ts"
import {
  ScheduledPromptWorkflow,
} from "../../workflow-engine/workflows/scheduled-prompt.ts"

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
  // `wait` Effect). wait_for_any now races these under the Shape C wait
  // primitive (durable completion row keyed by toolUseId), so an in-flight
  // wait_for_any survives host restart by reading the recorded outcome.
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

// 0 means "no timeout"-shaped agent input; Shape C primitive treats undefined
// as no timeout (matches the prior workflow shape). Preserve the historical 0
// → 1 floor to keep duplicate-suppression tests stable. Returns the partial
// shape so the request literal can spread it conditionally
// (exactOptionalPropertyTypes).
const waitTimeoutFromInput = (
  timeoutMs: number | undefined,
): { readonly timeoutMs?: number } =>
  timeoutMs === undefined
    ? {}
    : { timeoutMs: timeoutMs === 0 ? 1 : timeoutMs }

const waitOutcomeToOutput = (
  outcome: RuntimeWaitOutcome,
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

interface RuntimeAgentToolExecutionDeps {
  readonly waitCompletionTable: RuntimeWaitCompletionTable["Type"]
  readonly observationStreams: RuntimeObservationStreams["Type"]
}

// Provide the Shape C wait primitive's R channel from the dispatcher's
// constructed deps. The handler's surface is `Effect<…, error, never>` — the
// requirement is discharged here, NOT by an unsafe cast.
const provideShapeCWaitDeps = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    RuntimeObservationStreams | RuntimeWaitCompletionTable
  >,
  deps: RuntimeAgentToolExecutionDeps,
): Effect.Effect<A, E, never> =>
  effect.pipe(
    Effect.provideService(RuntimeWaitCompletionTable, deps.waitCompletionTable),
    Effect.provideService(RuntimeObservationStreams, deps.observationStreams),
  )

// Shape C wait_for_any per tf-28b8 (#676). The dispatch contract is unchanged:
// race N descriptors over their typed observation sources, return the winning
// index + the channel name. The race + at-most-once survival is now a durable
// completion row, not a workflow execution memo.
const waitForAny = (
  deps: RuntimeAgentToolExecutionDeps,
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
  const request: RuntimeWaitForRequest = {
    completionKey: runtimeWaitForAnyCompletionKey(contextId, toolUseId),
    source: primary.source,
    trigger: primary.trigger,
    additionalSources: rest.map(descriptor => ({
      source: descriptor.source,
      trigger: descriptor.trigger,
    })),
    ...waitTimeoutFromInput(input.timeoutMs),
  }
  return provideShapeCWaitDeps(runtimeWaitForMatch(request), deps).pipe(
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
  )
}

// Erase the `WorkflowEngine.WorkflowEngine` requirement that `DurableClock` and
// `Workflow.execute` leak into the dispatcher's outer call site: the ambient
// workflow execution scope the host provides via `workflowRuntime.run` covers
// these at runtime, and the public `RuntimeAgentToolExecutionService` contract
// is `R = never`. This cast is narrow to those two Shape D bindings (sleep +
// schedule_me), which are the only retained workflow-machinery uses on this
// surface per tf-28b8 (#676).
const hideWorkflowEngineRequirements = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, never> =>
  effect as Effect.Effect<A, E, never>

// firegrid-host-sdk.PACKAGE_GRAPH.6
// firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.9
export const makeRuntimeAgentToolExecutionService = (
  deps: RuntimeAgentToolExecutionDeps,
): RuntimeAgentToolExecutionService => ({
  // sleep retains the narrow Shape D DurableClock binding: a true-future
  // wake has no producer to resolve a completion row (tf-28b8 Probe 3 /
  // PR #676 verdict — DurableClock is load-bearing for scheduled prompts).
  sleep: ({ toolUseId, input }) =>
    DurableClock.sleep({
      name: `tool:${toolUseId}`,
      duration: Duration.millis(input.durationMs),
      inMemoryThreshold: Duration.zero,
    }).pipe(
      Effect.as<SleepToolOutput>({ slept: true }),
      hideWorkflowEngineRequirements,
    ),
  // Shape C: the wait is a durable completion row keyed by toolUseId; the
  // source is replayable + the row terminalizes the outcome (C4).
  waitFor: ({ contextId, toolUseId, input, source, trigger }) => {
    const request: RuntimeWaitForRequest = {
      completionKey: runtimeWaitForCompletionKey(contextId, toolUseId),
      source,
      trigger,
      ...waitTimeoutFromInput(input.timeoutMs),
    }
    return provideShapeCWaitDeps(runtimeWaitForMatch(request), deps).pipe(
      Effect.map(waitOutcomeToOutput),
      Effect.mapError(toolExecutionFailed),
    )
  },
  waitForAny: params => waitForAny(deps, params),
  send: ({ input, append }) =>
    append.pipe(
      Effect.as<SendToolOutput>({ sent: true, channel: input.channel }),
      Effect.mapError(toolExecutionFailed),
    ),
  call: ({ call }) =>
    call.pipe(
      Effect.mapError(toolExecutionFailed),
    ),
  // tf-5ose: the scheduled-prompt workflow remains the narrow Shape D
  // DurableClock binding per tf-28b8 (#676). discard:true returns the
  // executionId without awaiting; the engine resumes the body after the delay.
  schedule: ({ contextId, scheduleId, input }) =>
    ScheduledPromptWorkflow.execute(
      { contextId, scheduleId, when: input.when, prompt: input.prompt },
      { discard: true },
    ).pipe(
      Effect.as<ScheduleMeToolOutput>({ scheduled: true, scheduleId }),
      Effect.mapError(toolExecutionFailed),
      hideWorkflowEngineRequirements,
    ),
})

export class RuntimeAgentToolExecution extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentToolExecution",
)<RuntimeAgentToolExecution, RuntimeAgentToolExecutionService>() {
  static layer = (
    service: RuntimeAgentToolExecutionService,
  ): Layer.Layer<RuntimeAgentToolExecution> => Layer.succeed(this, service)
}

// The Live layer pulls the Shape C dependencies from Context. Hosts compose
// `RuntimeWaitCompletionTable.layer(...)` + `RuntimeObservationStreamsLive`
// into their layer graph; this constructor closes over them so the public
// dispatcher methods stay `R = never` at the call site.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- DurableTable.layer leaks `any` through the wait completion table; the declared Layer R channel is the intended capability boundary.
export const RuntimeAgentToolExecutionLive: Layer.Layer<
  RuntimeAgentToolExecution,
  never,
  RuntimeWaitCompletionTable | RuntimeObservationStreams
> = Layer.effect(
  RuntimeAgentToolExecution,
  Effect.gen(function*() {
    const waitCompletionTable = yield* RuntimeWaitCompletionTable
    const observationStreams = yield* RuntimeObservationStreams
    return makeRuntimeAgentToolExecutionService({
      waitCompletionTable,
      observationStreams,
    })
  }),
).pipe(
  Layer.withSpan("firegrid.runtime.agent_tool_execution.layer", {
    kind: "internal",
  }),
)
