import { Activity, Workflow } from "@effect/workflow"
import { Prompt } from "@effect/ai"
import {
  durableStreamUrl,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { toolResult } from "@firegrid/host-sdk/agent-tools/bindings"
import {
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/tool-executor"
import {
  ToolResultEventSchema,
  type AgentInputEvent,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowActivityRow,
} from "@firegrid/runtime/workflow-engine"
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Fiber,
  Layer,
  Ref,
  Schema,
} from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

type ToolUseEvent = Extract<AgentOutputEvent, { readonly _tag: "ToolUse" }>
type ToolResultEvent = Extract<AgentInputEvent, { readonly _tag: "ToolResult" }>

type ScenarioVerdict =
  | "GREEN-CONTRACT-COMPLETE"
  | "SEAM-GAP-timeout"
  | "SEAM-GAP-cancel"
  | "SEAM-GAP-dedup"

interface ScenarioReport {
  readonly scenario: string
  readonly verdict: ScenarioVerdict
  readonly evidence: Record<string, unknown>
}

interface RuntimeToolUseExecutorContractResult {
  readonly timeout: ScenarioReport
  readonly cancel: ScenarioReport
  readonly dedup: ScenarioReport
}

interface InvocationRecord {
  readonly callNo: number
  readonly toolUseId: string
  readonly branch: string
  readonly marker: string | undefined
  readonly startedAtMs: number
}

interface ProbeState {
  readonly starts: ReadonlyArray<InvocationRecord>
  readonly completions: ReadonlyArray<string>
  readonly interrupts: ReadonlyArray<string>
  readonly staleCallbacks: ReadonlyArray<string>
}

interface Streams {
  readonly workflow: string
}

/* eslint-disable local/no-module-durable-cache -- simulation-local host/driver handshake; replay state under test lives in Durable Streams. */
let resolveResult: (result: RuntimeToolUseExecutorContractResult) => void
let rejectResult: (error: unknown) => void

export const runtimeToolUseExecutorContractResult =
  new Promise<RuntimeToolUseExecutorContractResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
/* eslint-enable local/no-module-durable-cache */

const ProbeWorkflow = Workflow.make({
  name: "tf-i724.runtime-tool-use-executor-contract",
  payload: Schema.Struct({
    scenario: Schema.Literal("timeout", "cancel", "dedup"),
  }),
  success: Schema.Unknown,
  error: Schema.Unknown,
  idempotencyKey: payload => payload.scenario,
})

const stateEmpty: ProbeState = {
  starts: [],
  completions: [],
  interrupts: [],
  staleCallbacks: [],
}

const branchFrom = (event: ToolUseEvent): string =>
  typeof event.part.params === "object" &&
    event.part.params !== null &&
    "branch" in event.part.params &&
    typeof event.part.params.branch === "string"
    ? event.part.params.branch
    : "unknown"

const markerFrom = (event: ToolUseEvent): string | undefined =>
  typeof event.part.params === "object" &&
    event.part.params !== null &&
    "marker" in event.part.params &&
    typeof event.part.params.marker === "string"
    ? event.part.params.marker
    : undefined

const toolUse = (
  toolUseId: string,
  branch: string,
  params: Record<string, unknown> = {},
): ToolUseEvent => ({
  _tag: "ToolUse",
  part: Prompt.toolCallPart({
    id: toolUseId,
    name: "contract_probe",
    params: { branch, ...params },
    providerExecuted: false,
  }),
})

const recordStart = (
  state: Ref.Ref<ProbeState>,
  event: ToolUseEvent,
): Effect.Effect<InvocationRecord> =>
  Effect.gen(function*() {
    const startedAtMs = yield* Clock.currentTimeMillis
    return yield* Ref.updateAndGet(state, current => {
      const record: InvocationRecord = {
        callNo: current.starts.length + 1,
        toolUseId: event.part.id,
        branch: branchFrom(event),
        marker: markerFrom(event),
        startedAtMs,
      }
      return { ...current, starts: [...current.starts, record] }
    }).pipe(Effect.map(next => next.starts[next.starts.length - 1]!))
  })

const recordList = (
  state: Ref.Ref<ProbeState>,
  key: "completions" | "interrupts" | "staleCallbacks",
  value: string,
): Effect.Effect<void> =>
  Ref.update(state, current => ({
    ...current,
    [key]: [...current[key], value],
  }))

const resultFor = (
  event: ToolUseEvent,
  content: Record<string, unknown>,
): ToolResultEvent => toolResult(event.part.id, event.part.name, content)

const cancellableDelayResult = (
  state: Ref.Ref<ProbeState>,
  event: ToolUseEvent,
  callNo: number,
  delayMs: number,
): Effect.Effect<ToolResultEvent> =>
  Effect.sleep(Duration.millis(delayMs)).pipe(
    Effect.zipRight(recordList(state, "completions", `${event.part.id}#${callNo}`)),
    Effect.as(resultFor(event, {
      callNo,
      marker: markerFrom(event),
      completed: true,
    })),
    Effect.onInterrupt(() =>
      recordList(state, "interrupts", `${event.part.id}#${callNo}`)),
  )

const staleCallbackResult = (
  state: Ref.Ref<ProbeState>,
  event: ToolUseEvent,
  callNo: number,
  delayMs: number,
): Effect.Effect<ToolResultEvent> =>
  Effect.async<ToolResultEvent>((resume) => {
    // durable-lint-allow-timer: sim intentionally models a callback racing cancellation.
    const timer = globalThis.setTimeout(() => {
      Effect.runFork(recordList(
        state,
        "staleCallbacks",
        `${event.part.id}#${callNo}`,
      ))
      resume(Effect.succeed(resultFor(event, {
        callNo,
        staleCallbackCompleted: true,
      })))
    }, delayMs)
    return Effect.sync(() => {
      globalThis.clearTimeout(timer)
      Effect.runFork(recordList(
        state,
        "interrupts",
        `${event.part.id}#${callNo}`,
      ))
      // durable-lint-allow-timer: sim intentionally fires a stale callback after cancellation.
      globalThis.setTimeout(() => {
        Effect.runFork(recordList(
          state,
          "staleCallbacks",
          `${event.part.id}#${callNo}:after-cancel`,
        ))
        resume(Effect.succeed(resultFor(event, {
          callNo,
          staleCallbackCompleted: true,
          afterCancel: true,
        })))
      }, delayMs)
    })
  })

const executorLayer = (
  state: Ref.Ref<ProbeState>,
): Layer.Layer<RuntimeToolUseExecutor> =>
  RuntimeToolUseExecutor.layer({
    execute: (_context, event) =>
      Effect.gen(function*() {
        const record = yield* recordStart(state, event)
        const branch = branchFrom(event)
        if (branch === "codec-timeout") {
          const maybeResult = yield* cancellableDelayResult(
            state,
            event,
            record.callNo,
            500,
          ).pipe(
            Effect.timeoutTo({
              duration: Duration.millis(50),
              onTimeout: () => undefined,
              onSuccess: result => result,
            }),
          )
          if (maybeResult !== undefined) return maybeResult
          return resultFor(event, {
            callNo: record.callNo,
            timedOut: true,
            timeoutOwner: "codec",
          })
        }
        if (branch === "scope-cancel") {
          return yield* staleCallbackResult(state, event, record.callNo, 75)
        }
        return yield* cancellableDelayResult(state, event, record.callNo, 500)
      }),
  })

const runToolUseActivity = (
  contextId: string,
  event: ToolUseEvent,
) =>
  Activity.make({
    name: `firegrid.runtime-context.tool.${event.part.id}`,
    success: ToolResultEventSchema,
    error: Schema.Never,
    execute: Effect.gen(function*() {
      const executor = yield* RuntimeToolUseExecutor
      return yield* executor.execute({ contextId }, event)
    }),
  })

const startsFor = (
  state: ProbeState,
  toolUseId: string,
): ReadonlyArray<InvocationRecord> =>
  state.starts.filter(start => start.toolUseId === toolUseId)

const waitUntil = <A>(
  label: string,
  poll: Effect.Effect<A, unknown>,
  satisfied: (value: A) => boolean,
): Effect.Effect<A, unknown> =>
  /* eslint-disable local/no-fixed-polling -- bounded probe polling waits for in-process state visibility during adversarial cancellation. */
  Effect.gen(function*() {
    const deadlineMs = (yield* Clock.currentTimeMillis) + 5_000
    let latest = yield* poll
    while (!satisfied(latest)) {
      if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
        return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
      }
      yield* Effect.sleep(Duration.millis(10))
      latest = yield* poll
    }
    return latest
  })
/* eslint-enable local/no-fixed-polling */

const runTimeoutScenario = (
  state: Ref.Ref<ProbeState>,
) =>
  Effect.gen(function*() {
    const workflowTimeoutId = "tf-i724-timeout-workflow"
    const codecTimeoutId = "tf-i724-timeout-codec"
    const workflowSideReturned = yield* runToolUseActivity(
      "ctx-timeout",
      toolUse(workflowTimeoutId, "workflow-timeout"),
    ).pipe(
      Effect.timeoutTo({
        duration: Duration.millis(50),
        onTimeout: () => false,
        onSuccess: () => true,
      }),
    )
    const codecResult = yield* runToolUseActivity(
      "ctx-timeout",
      toolUse(codecTimeoutId, "codec-timeout"),
    )
    yield* Effect.sleep(Duration.millis(125))
    const snapshot = yield* Ref.get(state)
    const workflowStarts = startsFor(snapshot, workflowTimeoutId)
    const codecStarts = startsFor(snapshot, codecTimeoutId)
    const workflowInterrupted = snapshot.interrupts.some(interrupt =>
      interrupt.startsWith(workflowTimeoutId),
    )
    const codecInterrupted = snapshot.interrupts.some(interrupt =>
      interrupt.startsWith(codecTimeoutId),
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.tf_i724.timeout.workflow_side_returned": workflowSideReturned,
      "firegrid.tf_i724.timeout.workflow_side_starts": workflowStarts.length,
      "firegrid.tf_i724.timeout.workflow_side_interrupted": workflowInterrupted,
      "firegrid.tf_i724.timeout.codec_side_starts": codecStarts.length,
      "firegrid.tf_i724.timeout.codec_side_interrupted_subprocess": codecInterrupted,
      "firegrid.tf_i724.timeout.codec_side_result_timed_out":
        typeof codecResult.part.result === "object" &&
          codecResult.part.result !== null &&
          "timedOut" in codecResult.part.result &&
          codecResult.part.result.timedOut === true,
    })
    return {
      scenario: "timeout",
      verdict: "SEAM-GAP-timeout" as const,
      evidence: {
        workflowSideReturned,
        workflowSideStarts: workflowStarts.length,
        workflowSideInterrupted: workflowInterrupted,
        codecSideStarts: codecStarts.length,
        codecSideInterruptedSubprocess: codecInterrupted,
        codecSideResult: codecResult.part.result,
      },
    }
  }).pipe(
    Effect.withSpan("firegrid.tf_i724.scenario.timeout", {
      kind: "internal",
    }),
  )

const runCancelScenario = (
  state: Ref.Ref<ProbeState>,
) =>
  Effect.gen(function*() {
    const toolUseId = "tf-i724-scope-cancel"
    yield* runToolUseActivity(
      "ctx-cancel",
      toolUse(toolUseId, "scope-cancel"),
    ).pipe(
      Effect.forkScoped,
      Effect.tap(() =>
        waitUntil(
          "scope-cancel executor start",
          Ref.get(state),
          snapshot => startsFor(snapshot, toolUseId).length > 0,
        )),
      Effect.flatMap(fiber => Fiber.interrupt(fiber)),
    )
    yield* Effect.sleep(Duration.millis(150))
    const snapshot = yield* Ref.get(state)
    const executorObservedInterrupt = snapshot.interrupts.some(interrupt =>
      interrupt.startsWith(toolUseId),
    )
    const staleCallbackFiredAfterCancel = snapshot.staleCallbacks.some(callback =>
      callback.startsWith(`${toolUseId}#`) &&
      callback.endsWith(":after-cancel"),
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.tf_i724.cancel.starts": startsFor(snapshot, toolUseId).length,
      "firegrid.tf_i724.cancel.executor_observed_interrupt":
        executorObservedInterrupt,
      "firegrid.tf_i724.cancel.stale_callback_after_cancel":
        staleCallbackFiredAfterCancel,
    })
    return {
      scenario: "cancel",
      verdict: "SEAM-GAP-cancel" as const,
      evidence: {
        starts: startsFor(snapshot, toolUseId).length,
        executorObservedInterrupt,
        staleCallbackFiredAfterCancel,
      },
    }
  }).pipe(
    Effect.withSpan("firegrid.tf_i724.scenario.cancel", {
      kind: "internal",
    }),
  )

const resultCallNo = (event: ToolResultEvent): unknown =>
  typeof event.part.result === "object" &&
    event.part.result !== null &&
    "callNo" in event.part.result
    ? event.part.result.callNo
    : undefined

const runDedupScenario = (
  state: Ref.Ref<ProbeState>,
) =>
  Effect.gen(function*() {
    const sameAttemptId = "tf-i724-duplicate-same-attempt"
    const retryAttemptId = "tf-i724-duplicate-retry-attempt"
    const sameAttemptFirst = yield* runToolUseActivity(
      "ctx-dedup",
      toolUse(sameAttemptId, "dedup", { marker: "same-attempt-first" }),
    )
    const sameAttemptSecond = yield* runToolUseActivity(
      "ctx-dedup",
      toolUse(sameAttemptId, "dedup", { marker: "same-attempt-second" }),
    )
    const retryAttemptFirst = yield* runToolUseActivity(
      "ctx-dedup",
      toolUse(retryAttemptId, "dedup", { marker: "retry-attempt-first" }),
    )
    const retryAttemptSecond = yield* runToolUseActivity(
      "ctx-dedup",
      toolUse(retryAttemptId, "dedup", { marker: "retry-attempt-second" }),
    ).pipe(Effect.provideService(Activity.CurrentAttempt, 2))
    const snapshot = yield* Ref.get(state)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tf_i724.dedup.same_attempt_starts":
        startsFor(snapshot, sameAttemptId).length,
      "firegrid.tf_i724.dedup.same_attempt_first_call_no":
        String(resultCallNo(sameAttemptFirst)),
      "firegrid.tf_i724.dedup.same_attempt_second_call_no":
        String(resultCallNo(sameAttemptSecond)),
      "firegrid.tf_i724.dedup.retry_attempt_starts":
        startsFor(snapshot, retryAttemptId).length,
      "firegrid.tf_i724.dedup.retry_attempt_first_call_no":
        String(resultCallNo(retryAttemptFirst)),
      "firegrid.tf_i724.dedup.retry_attempt_second_call_no":
        String(resultCallNo(retryAttemptSecond)),
    })
    return {
      scenario: "dedup",
      verdict: "SEAM-GAP-dedup" as const,
      evidence: {
        sameAttemptExecutorStarts: startsFor(snapshot, sameAttemptId).length,
        sameAttemptFirstCallNo: resultCallNo(sameAttemptFirst),
        sameAttemptSecondCallNo: resultCallNo(sameAttemptSecond),
        retryAttemptExecutorStarts: startsFor(snapshot, retryAttemptId).length,
        retryAttemptFirstCallNo: resultCallNo(retryAttemptFirst),
        retryAttemptSecondCallNo: resultCallNo(retryAttemptSecond),
      },
    }
  }).pipe(
    Effect.withSpan("firegrid.tf_i724.scenario.dedup", {
      kind: "internal",
    }),
  )

const workflowLayer = (
  state: Ref.Ref<ProbeState>,
) =>
  ProbeWorkflow.toLayer(({ scenario }) => {
    switch (scenario) {
      case "timeout":
        return runTimeoutScenario(state)
      case "cancel":
        return runCancelScenario(state)
      case "dedup":
        return runDedupScenario(state)
    }
  })

const contractLayer = (
  streams: Streams,
  state: Ref.Ref<ProbeState>,
) =>
  workflowLayer(state).pipe(
    Layer.provideMerge(executorLayer(state)),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflow,
      workerId: "tf-i724-runtime-tool-use-executor-contract",
    })),
  )

const tableLayer = (streams: Streams) =>
  WorkflowEngineTable.layer({
    streamOptions: {
      url: streams.workflow,
      contentType: "application/json",
    },
  })

const inspectActivities = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowActivityRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* WorkflowEngineTable
      return yield* table.activities.query(coll => coll.toArray)
    }).pipe(Effect.provide(tableLayer(streams))),
  )

const executeProbe = (
  streams: Streams,
): Effect.Effect<RuntimeToolUseExecutorContractResult, unknown> =>
  Effect.gen(function*() {
    const state = yield* Ref.make(stateEmpty)
    const layer = contractLayer(streams, state)
    const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
      Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<
        A,
        unknown
      >
    const timeout = yield* run(ProbeWorkflow.execute({ scenario: "timeout" }))
    const cancel = yield* run(ProbeWorkflow.execute({ scenario: "cancel" }))
    const dedup = yield* run(ProbeWorkflow.execute({ scenario: "dedup" }))
    const activities = yield* inspectActivities(streams)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tf_i724.timeout.verdict": (timeout as ScenarioReport).verdict,
      "firegrid.tf_i724.cancel.verdict": (cancel as ScenarioReport).verdict,
      "firegrid.tf_i724.dedup.verdict": (dedup as ScenarioReport).verdict,
      "firegrid.tf_i724.activity_rows": activities.length,
    })
    return {
      timeout: timeout as ScenarioReport,
      cancel: {
        ...(cancel as ScenarioReport),
        evidence: {
          ...(cancel as ScenarioReport).evidence,
          activityRowsForCancelledTool: activities.filter(row =>
            row.activityName.endsWith("tf-i724-scope-cancel"),
          ).length,
        },
      },
      dedup: dedup as ScenarioReport,
    }
  }).pipe(
    Effect.withSpan("firegrid.tf_i724.contract_probe", {
      kind: "internal",
      attributes: {
        "firegrid.tf_i724.workflow_stream": streams.workflow,
      },
    }),
  )

const publishResult = (
  env: TinyFiregridHostEnv,
): Effect.Effect<void, unknown> => {
  const streams: Streams = {
    workflow: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.${env.runId}.tf-i724.workflow`,
    ),
  }
  return executeProbe(streams).pipe(
    Effect.matchCauseEffect({
      onFailure: cause =>
        Effect.sync(() => {
          rejectResult(new Error(Cause.pretty(cause)))
        }).pipe(Effect.zipRight(Effect.failCause(cause))),
      onSuccess: result =>
        Effect.sync(() => {
          resolveResult(result)
        }),
    }),
  )
}

export const runtimeToolUseExecutorContractHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  Layer.scopedDiscard(
    publishResult(env).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          rejectResult(new Error("tf-i724 contract host interrupted"))
        })),
      Effect.withSpan("firegrid.tf_i724.host"),
    ),
  ) as Layer.Layer<FiregridHost, unknown>
