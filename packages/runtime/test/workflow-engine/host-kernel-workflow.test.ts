import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt } from "@effect/ai"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  hostOwnedStreamUrl,
  local,
  makeHostSessionRow,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { Duration, Effect, Layer, Option, Stream, Tracer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeAgentOutputAfterEvents,
} from "../../src/agent-event-pipeline/authorities/runtime-output-public.ts"
import {
  RuntimeToolUseExecutor,
} from "../../src/workflow-engine/tool-execution/runtime-tool-use-executor.ts"
import {
  RuntimeControlPlaneRecorderLive,
} from "../../src/authorities/runtime-control-plane-recorder.ts"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "../../src/workflow-engine/DurableStreamsWorkflowEngine.ts"
import {
  HostKernelControlPlane,
  HostKernelControlPlaneLive,
  HostKernelWorkflow,
  HostKernelWorkflowLayer,
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowNativeLayer,
  RuntimeContextWorkflowSession,
  hostKernelWorkflowExecutionId,
  runtimeContextWorkflowExecutionId,
  type RuntimeContextSessionCommand,
} from "../../src/kernel/index.ts"

interface CapturedSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
}

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const capturingTracerLayer = (
  capturedSpans: Array<CapturedSpan>,
): Layer.Layer<never> => {
  const tracer: Tracer.Tracer = {
    [Tracer.TracerTypeId]: Tracer.TracerTypeId,
    span: (name, parent, context, links, startTime, kind) => {
      const attributes: Record<string, unknown> = {}
      capturedSpans.push({ name, attributes })
      return {
        _tag: "Span",
        name,
        spanId: `host-kernel-${crypto.randomUUID()}`,
        traceId: "host-kernel-test",
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes: new Map<string, unknown>(),
        links,
        sampled: true,
        kind,
        end: () => {},
        attribute: (key, value) => {
          attributes[key] = value
        },
        event: () => {},
        addLinks: () => {},
      }
    },
    context: f => f(),
  }
  return Layer.setTracer(tracer)
}

const hostSessionLayer = (
  namespace: string,
  hostId: HostId,
) =>
  Layer.succeed(
    CurrentHostSession,
    makeHostSessionRow({
      hostId,
      hostSessionId: `hs_${crypto.randomUUID()}` as HostSessionId,
      namespace,
      startedAtMs: 1_700_000_000_000,
    }),
  )

const acceptedCommand = (
  contextId: string,
  activityAttempt: number,
  command: RuntimeContextSessionCommand,
) => ({
  contextId,
  activityAttempt,
  commandId: command.commandId,
  ownerSessionId: `owner-${contextId}-${activityAttempt}`,
})

const sessionLayer = (events: {
  readonly starts: Array<string>
  readonly sends: Array<RuntimeContextSessionCommand>
}) =>
  Layer.succeed(
    RuntimeContextWorkflowSession,
    RuntimeContextWorkflowSession.of({
      startOrAttach: (context, activityAttempt) =>
        Effect.sync(() => {
          events.starts.push(`${context.contextId}:${activityAttempt}`)
          return {
            contextId: context.contextId,
            activityAttempt,
            ownerKind: "codec" as const,
            ownerSessionId: `owner-${context.contextId}-${activityAttempt}`,
            startCommandId: `start-${context.contextId}-${activityAttempt}`,
          }
        }),
      send: (context, activityAttempt, command) =>
        Effect.sync(() => {
          events.sends.push(command)
          return acceptedCommand(context.contextId, activityAttempt, command)
        }),
    }),
  )

const runtimeAgentOutputAfterEventsLayer = Layer.succeed(
  RuntimeAgentOutputAfterEvents,
  RuntimeAgentOutputAfterEvents.of({
    initial: () => Effect.succeed(Option.none()),
    after: () => Stream.empty,
    forContext: () => Stream.empty,
  }),
)

const runtimeToolUseExecutorLayer = RuntimeToolUseExecutor.layer({
  execute: (_context, event) =>
    Effect.succeed({
      _tag: "ToolResult" as const,
      part: Prompt.toolResultPart({
        id: event.part.id,
        name: event.part.name,
        result: { ok: true },
        isFailure: false,
        providerExecuted: false,
      }),
    }),
})

const workflowUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: HostId
}) =>
  hostOwnedStreamUrl({
    baseUrl: input.baseUrl,
    prefix: makeHostStreamPrefix({
      namespace: input.namespace,
      hostId: input.hostId,
    }),
    segment: "workflow",
  })

const controlUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
}) => runtimeControlPlaneStreamUrl(input)

const hostKernelTestLayer = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: HostId
  readonly capturedSpans: Array<CapturedSpan>
  readonly sessionEvents: {
    readonly starts: Array<string>
    readonly sends: Array<RuntimeContextSessionCommand>
  }
}): Layer.Layer<
  HostKernelControlPlane | RuntimeControlPlaneTable | WorkflowEngineTable,
  unknown,
  never
> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable-backed workflow engine layer leaks any through test composition; the declared services are the intended test boundary.
  Layer.mergeAll(
    HostKernelControlPlaneLive,
    HostKernelWorkflowLayer,
    RuntimeContextWorkflowNativeLayer,
  ).pipe(
    Layer.provideMerge(sessionLayer(input.sessionEvents)),
    Layer.provideMerge(runtimeToolUseExecutorLayer),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(runtimeAgentOutputAfterEventsLayer),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: workflowUrl(input),
      workerId: input.hostId,
    })),
    Layer.provideMerge(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: controlUrl(input),
        contentType: "application/json",
      },
    })),
    Layer.provideMerge(hostSessionLayer(input.namespace, input.hostId)),
    Layer.provideMerge(capturingTracerLayer(input.capturedSpans)),
  )

const waitForActivity = (
  startsWith: string,
) =>
  Effect.gen(function*() {
    const table = yield* WorkflowEngineTable
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const rows = yield* table.activities.query((coll) =>
        coll.toArray.filter(row =>
          row.activityName.startsWith(startsWith) && row.result !== undefined))
      if (rows.length > 0) return rows[0]!
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.dieMessage(`timed out waiting for activity ${startsWith}`)
  })

const waitForRunStatus = (
  contextId: string,
  status: "started" | "exited" | "failed",
) =>
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const rows = yield* control.runs.query((coll) =>
        coll.toArray.filter(row =>
          row.contextId === contextId && row.status === status))
      if (rows.length > 0) return rows[0]!
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.dieMessage(`timed out waiting for ${contextId} ${status}`)
  })

const waitForSessionSend = (
  events: { readonly sends: ReadonlyArray<RuntimeContextSessionCommand> },
  count: number,
) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (events.sends.length >= count) return
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.dieMessage(`timed out waiting for ${count} session sends`)
  })

const runScoped = <A, E, R>(
  layer: Layer.Layer<never, unknown, R>,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>),
  )

describe("HostKernelWorkflow validation slice", () => {
  it("firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.4 firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.5 serializes create/load, start, prompt, and cancel through workflow mailbox artifacts", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `host-kernel-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const capturedSpans: Array<CapturedSpan> = []
    const sessionEvents = { starts: [] as Array<string>, sends: [] as Array<RuntimeContextSessionCommand> }
    const layer = hostKernelTestLayer({
      baseUrl,
      namespace,
      hostId,
      capturedSpans,
      sessionEvents,
    })

    await runScoped(
      layer,
      Effect.gen(function*() {
        const kernel = yield* HostKernelControlPlane
        yield* kernel.signal(hostId, {
          _tag: "CreateLoad",
          requestId: "kernel-create",
          contextId,
          createdBy: "host-kernel-test",
          runtime: normalizeRuntimeIntent(local.jsonl({
            argv: [process.execPath, "-e", "process.stdin.resume()"],
            agentProtocol: "stdio-jsonl",
          })),
        })
        yield* waitForActivity(`host-kernel/${hostId}/intent/0`)

        yield* kernel.signal(hostId, {
          _tag: "Start",
          requestId: "kernel-start",
          contextId,
        })
        yield* waitForRunStatus(contextId, "started")

        yield* kernel.signal(hostId, {
          _tag: "Prompt",
          requestId: "kernel-prompt",
          contextId,
          request: {
            inputId: "kernel-input-1",
            contextId,
            kind: "message",
            authoredBy: "client",
            payload: "hello kernel",
            idempotencyKey: "kernel-input-1",
          },
        })
        yield* waitForSessionSend(sessionEvents, 1)

        yield* kernel.signal(hostId, {
          _tag: "Cancel",
          requestId: "kernel-cancel",
          contextId,
        })
        yield* waitForRunStatus(contextId, "exited")
      }),
    )

    const artifacts = await runScoped(
      layer,
      Effect.gen(function*() {
        const control = yield* RuntimeControlPlaneTable
        const workflow = yield* WorkflowEngineTable
        const contextRows = yield* control.contexts.query((coll) => coll.toArray)
        const runRows = yield* control.runs.query((coll) => coll.toArray)
        const contextRequests = yield* control.contextRequests.query((coll) => coll.toArray)
        const startRequests = yield* control.startRequests.query((coll) => coll.toArray)
        const lifecycleRequests = yield* control.lifecycleRequests.query((coll) => coll.toArray)
        const claims = yield* control.controlRequestClaims.query((coll) => coll.toArray)
        const completions = yield* control.controlRequestCompletions.query((coll) => coll.toArray)
        const executions = yield* workflow.executions.query((coll) => coll.toArray)
        const activities = yield* workflow.activities.query((coll) => coll.toArray)
        const deferreds = yield* workflow.deferreds.query((coll) => coll.toArray)
        return {
          contextRows,
          runRows,
          contextRequests,
          startRequests,
          lifecycleRequests,
          claims,
          completions,
          executions,
          activities,
          deferreds,
        }
      }),
    )

    expect(artifacts.contextRows).toHaveLength(1)
    expect(artifacts.contextRows[0]).toMatchObject({ contextId })
    expect(artifacts.runRows.map(row => row.status).sort()).toEqual(["exited", "started"])
    expect(artifacts.runRows.find(row => row.status === "exited")).toMatchObject({
      contextId,
      exitCode: 130,
      signal: "SIGTERM",
    })
    expect(sessionEvents.starts).toEqual([`${contextId}:1`])
    expect(sessionEvents.sends).toHaveLength(1)
    expect(sessionEvents.sends[0]?.event).toMatchObject({ _tag: "Prompt" })

    expect(artifacts.executions.map(row => row.executionId).sort()).toEqual([
      hostKernelWorkflowExecutionId(hostId),
      runtimeContextWorkflowExecutionId(contextId),
    ].sort())
    expect(artifacts.deferreds.filter(row =>
      row.workflowName === HostKernelWorkflow.name &&
      row.deferredName.includes("/intent/"))).toHaveLength(4)
    expect(artifacts.deferreds.some(row =>
      row.workflowName === RuntimeContextWorkflowNative.name &&
      row.deferredName.includes(`runtime-context/${contextId}/input/0`))).toBe(true)
    expect(artifacts.activities.filter(row =>
      row.activityName.startsWith(`host-kernel/${hostId}/intent/`))).toHaveLength(4)
    expect(artifacts.activities.some(row =>
      row.activityName.includes("/intent/0"))).toBe(true)
    expect(artifacts.activities.some(row =>
      row.activityName.includes("/intent/3"))).toBe(true)

    expect(artifacts.contextRequests).toEqual([])
    expect(artifacts.startRequests).toEqual([])
    expect(artifacts.lifecycleRequests).toEqual([])
    expect(artifacts.claims).toEqual([])
    expect(artifacts.completions).toEqual([])
    expect(artifacts.executions.find(row =>
      row.executionId === runtimeContextWorkflowExecutionId(contextId))).toMatchObject({
      interrupted: true,
    })

    expect(capturedSpans.some(span => span.name === "firegrid.host_kernel.intent.signal")).toBe(true)
    expect(capturedSpans.some(span => span.name === "firegrid.host_kernel.workflow.intent.apply")).toBe(true)
    expect(capturedSpans.some(span => span.name === "firegrid.host_kernel.child.start")).toBe(true)
    expect(capturedSpans.some(span => span.name === "firegrid.host_kernel.child.cancel")).toBe(true)
  })
})
