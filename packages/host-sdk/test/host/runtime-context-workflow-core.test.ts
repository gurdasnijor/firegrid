import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt } from "@effect/ai"
import { Workflow } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  local,
  makeHostSessionRow,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
  type HostSessionId,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeControlPlaneRecorderLive,
} from "@firegrid/runtime/control-plane"
import {
  RuntimeAgentOutputAfterEvents,
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputEventsLayer,
} from "@firegrid/runtime/runtime-output"
import {
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/tool-executor"
import {
  encodeRuntimeAgentOutputEnvelope,
  type AgentInputEvent,
} from "@firegrid/runtime/events"
import { DurableToolsTable, DurableToolsWaitForLive, WaitFor } from "@firegrid/runtime/durable-tools"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowNativeLayer,
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
} from "../../src/host/runtime-context-workflow-core.ts"
import { WorkflowEngine } from "@effect/workflow"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import {
  FiregridRuntimeHostWithWorkflowLive,
} from "../../src/host/layers.ts"
import {
  HostRuntimeObservationSubstrateLive,
} from "../../src/host/runtime-substrate.ts"
import { RuntimeHostConfig } from "../../src/host/config.ts"
import {
  PerContextRuntimeOutputWriter,
} from "../../src/host/per-context-runtime-output.ts"
import {
  appendRuntimeInputDeferred,
} from "../../src/host/runtime-input-deferred.ts"
import { executeRuntimeContextWorkflow } from "../../src/host/internal/run-context-workflow.ts"
import { runtimeContextWorkflowExecutionId } from "../../src/host/internal/runtime-context-helpers.ts"

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

const streamUrl = (name: string) => `${baseUrl}/v1/stream/${name}`

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

// TFIND-031: the workflow capture seam (`RuntimeContextWorkflowNativeLayer`)
// now honestly carries `RuntimeHostConfig` in its precise requirements
// channel (it was masked while `DurableTable.layer` leaked `any`). The
// production host provides it via `namespaceScopedLayer`; the hand-rolled
// test layers must provide an equivalent so the seam is satisfied.
const hostConfigLayer = (namespace: string) =>
  Layer.succeed(RuntimeHostConfig, {
    inputEnabled: false,
    durableStreamsBaseUrl: baseUrl ?? "",
    namespace,
  })

// tf-uo2c: the hand-rolled runtime-context workflow tests write agent output
// rows through their host-wide RuntimeOutputTable. Production host composition
// uses the per-context output substrate, so this test adapter keeps the test
// surface explicit without changing production code.
const testHostWideRuntimeAgentOutputAfterEventsLive = Layer.effect(
  RuntimeAgentOutputAfterEvents,
  Effect.map(RuntimeAgentOutputEvents, agentOutput =>
    RuntimeAgentOutputAfterEvents.of({
      initial: source =>
        Stream.runHead(agentOutput.pipe(
          Stream.filter((row) =>
            row.contextId === source.contextId &&
            row.activityAttempt === source.activityAttempt &&
            row.sequence > source.afterSequence),
        )),
      after: source =>
        agentOutput.pipe(
          Stream.filter((row) =>
            row.contextId === source.contextId &&
            row.activityAttempt === source.activityAttempt &&
            row.sequence > source.afterSequence),
        ),
      forContext: contextId =>
        agentOutput.pipe(Stream.filter(row => row.contextId === contextId)),
    })),
).pipe(Layer.provide(RuntimeAgentOutputEventsLayer))

const outputRow = (input: {
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly event: Parameters<typeof encodeRuntimeAgentOutputEnvelope>[0]
}): RuntimeEventRow => ({
  eventId: {
    contextId: input.contextId,
    activityAttempt: input.activityAttempt,
    target: "events",
    sequence: input.sequence,
  },
  contextId: input.contextId,
  activityAttempt: input.activityAttempt,
  sequence: input.sequence,
  source: "stdout",
  format: "jsonl",
  receivedAt: new Date().toISOString(),
  raw: encodeRuntimeAgentOutputEnvelope(input.event),
})

const logRow = (input: {
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
}): RuntimeLogLineRow => ({
  logLineId: {
    contextId: input.contextId,
    activityAttempt: input.activityAttempt,
    target: "logs",
    sequence: input.sequence,
  },
  contextId: input.contextId,
  activityAttempt: input.activityAttempt,
  sequence: input.sequence,
  source: "stderr",
  format: "text-lines",
  receivedAt: new Date().toISOString(),
  raw: "startup log",
})

const agentOutputAfterWaitName = (
  contextId: string,
  activityAttempt: number,
  afterSequence: number,
) => `runtime-context/${contextId}/output-after/${activityAttempt}/${afterSequence}`

const waitUntilActiveWait = (
  name: string,
) =>
  Effect.gen(function*() {
    const table = yield* DurableToolsTable
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = yield* table.waits.query((coll) =>
        coll.toArray.filter(row =>
          row.waitKey.name === name && row.status === "active"))
      if (rows.length > 0) return rows[0]!
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.fail(new Error(`wait row did not become active: ${name}`))
  })

// tf-uo2c: gate tests on workflow body entry instead of a particular active
// wait row. This keeps synchronization stable across pre-collapse WaitFor and
// post-collapse direct observation bodies.
const waitUntilWorkflowStarted = (
  contextId: string,
  activityAttempt: number,
) =>
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = yield* control.runs.query((coll) =>
        coll.toArray.filter(row =>
          row.contextId === contextId &&
          row.activityAttempt === activityAttempt &&
          row.status === "started"))
      if (rows.length > 0) return rows[0]!
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.fail(new Error(
      `workflow body did not record a started run row: ${contextId}/${activityAttempt}`,
    ))
  })

const startedEvidence = (
  contextId: string,
  activityAttempt: number,
) => ({
  contextId,
  activityAttempt,
  ownerKind: "codec" as const,
  ownerSessionId: `owner-${contextId}-${activityAttempt}`,
  startCommandId: `start-${contextId}-${activityAttempt}`,
})

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

const seededRuntimeContext = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) => ({
  contextId: input.contextId,
  createdAt: new Date().toISOString(),
  runtime: normalizeRuntimeIntent(local.jsonl({
    argv: ["node", "-e", "process.exit(0)"],
    agentProtocol: "stdio-jsonl",
  })),
  host: {
    hostId: input.hostId,
    streamPrefix: makeHostStreamPrefix({
      namespace: input.namespace,
      hostId: input.hostId,
    }),
    boundAtMs: Date.now(),
  },
})

const reconstructableSessionLayer = (events: {
  readonly starts: Array<string>
  readonly reattaches: Array<string>
  readonly emissions: Array<string>
}) =>
  Layer.effect(
    RuntimeContextWorkflowSession,
    Effect.gen(function*() {
      const registry = yield* Ref.make(new Set<string>())
      const emitted = yield* Ref.make(new Set<string>())
      return RuntimeContextWorkflowSession.of({
        startOrAttach: (context, activityAttempt) =>
          Effect.gen(function*() {
            const key = `${context.contextId}:${activityAttempt}`
            const registered = yield* Ref.get(registry)
            if (!registered.has(key)) {
              events.starts.push(key)
              yield* Ref.update(registry, set => new Set([...set, key]))
            }
            return startedEvidence(context.contextId, activityAttempt)
          }),
        send: (context, activityAttempt, command) =>
          Effect.gen(function*() {
            const key = `${context.contextId}:${activityAttempt}`
            const registered = yield* Ref.get(registry)
            if (!registered.has(key)) {
              events.reattaches.push(key)
              yield* Ref.update(registry, set => new Set([...set, key]))
            }
            const emittedCommands = yield* Ref.get(emitted)
            if (!emittedCommands.has(command.commandId)) {
              events.emissions.push(command.commandId)
              yield* Ref.update(emitted, set => new Set([...set, command.commandId]))
            }
            return acceptedCommand(context.contextId, activityAttempt, command)
          }),
      })
    }),
  )

const runtimeContextWorkflowTestLayer = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly workflowUrl: string
  readonly waitUrl: string
  readonly controlUrl: string
  readonly outputUrl: string
  readonly sessionLayer: Layer.Layer<RuntimeContextWorkflowSession>
  readonly workerId?: string
}) =>
  RuntimeContextWorkflowNativeLayer.pipe(
    Layer.provideMerge(input.sessionLayer),
    Layer.provideMerge(RuntimeToolUseExecutor.layer({
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
    })),
    Layer.provideMerge(DurableToolsWaitForLive({ streamUrl: input.waitUrl })),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(RuntimeAgentOutputEventsLayer),
    Layer.provideMerge(testHostWideRuntimeAgentOutputAfterEventsLive),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: input.workflowUrl,
      ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    })),
    Layer.provideMerge(RuntimeControlPlaneTable.layer({
      streamOptions: { url: input.controlUrl, contentType: "application/json" },
    })),
    Layer.provideMerge(RuntimeOutputTable.layer({
      streamOptions: { url: input.outputUrl, contentType: "application/json" },
    })),
    Layer.provideMerge(hostSessionLayer(input.namespace, input.hostId)),
    Layer.provideMerge(hostConfigLayer(input.namespace)),
  )

const executeNativeRuntimeContext = (
  contextId: string,
  options?: { readonly discard?: boolean },
) =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return yield* executeRuntimeContextWorkflow(engine, RuntimeContextWorkflowNative, {
      executionId: runtimeContextWorkflowExecutionId(contextId),
      payload: { contextId },
      ...(options?.discard === undefined ? {} : { discard: options.discard }),
    })
  })

describe("workflow-native runtime-context core", () => {
  it("workflow-native runtime-context core resolves AgentOutputAfter initial state through PerContextRuntimeOutputWriter", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-output-initial-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const activityAttempt = 1
    const context = {
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: ["node", "-e", "process.exit(0)"],
        agentProtocol: "stdio-jsonl",
      })),
      host: {
        hostId,
        streamPrefix: makeHostStreamPrefix({ namespace, hostId }),
        boundAtMs: Date.now(),
      },
    }

    const AgentOutputAfterWorkflow = Workflow.make({
      name: "path-x-agent-output-after-initial",
      payload: Schema.Struct({ contextId: Schema.String }),
      success: Schema.Unknown,
      error: Schema.Unknown,
      idempotencyKey: payload => payload.contextId,
    })
    const workflowLayer = AgentOutputAfterWorkflow.toLayer(({ contextId: payloadContextId }) =>
      Effect.gen(function*() {
        const outcome = yield* WaitFor.match({
          name: agentOutputAfterWaitName(payloadContextId, activityAttempt, -1),
          source: {
            _tag: "AgentOutputAfter",
            contextId: payloadContextId,
            activityAttempt,
            afterSequence: -1,
          },
          trigger: [],
        })
        if (outcome._tag === "Timeout") return yield* Effect.fail("unexpected timeout")
        return outcome.row
      }))

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const writer = yield* PerContextRuntimeOutputWriter
          yield* writer.appendAgentEvent(
            context,
            activityAttempt,
            0,
            { _tag: "Terminated", exitCode: 0 },
          )
          return yield* AgentOutputAfterWorkflow.execute({ contextId })
        }).pipe(
          Effect.provide(workflowLayer),
          Effect.provide(HostRuntimeObservationSubstrateLive),
          Effect.provide(DurableStreamsWorkflowEngine.layer({
            streamUrl: streamUrl(`${namespace}.test.workflow`),
          })),
          Effect.provide(FiregridRuntimeHostWithWorkflowLive({
            durableStreamsBaseUrl: baseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )

    expect(result).toMatchObject({
      contextId,
      activityAttempt,
      sequence: 0,
      _tag: "Terminated",
    })
  })

  it("workflow-native runtime-context core resolves AgentOutputAfter live writes through PerContextRuntimeOutputWriter", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-output-live-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const activityAttempt = 1
    const context = {
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: ["node", "-e", "process.exit(0)"],
        agentProtocol: "stdio-jsonl",
      })),
      host: {
        hostId,
        streamPrefix: makeHostStreamPrefix({ namespace, hostId }),
        boundAtMs: Date.now(),
      },
    }

    const AgentOutputAfterWorkflow = Workflow.make({
      name: "path-x-agent-output-after-live",
      payload: Schema.Struct({ contextId: Schema.String }),
      success: Schema.Unknown,
      error: Schema.Unknown,
      idempotencyKey: payload => payload.contextId,
    })
    const workflowLayer = AgentOutputAfterWorkflow.toLayer(({ contextId: payloadContextId }) =>
      Effect.gen(function*() {
        const outcome = yield* WaitFor.match({
          name: agentOutputAfterWaitName(payloadContextId, activityAttempt, -1),
          source: {
            _tag: "AgentOutputAfter",
            contextId: payloadContextId,
            activityAttempt,
            afterSequence: -1,
          },
          trigger: [],
        })
        if (outcome._tag === "Timeout") return yield* Effect.fail("unexpected timeout")
        return outcome.row
      }))

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const fiber = yield* AgentOutputAfterWorkflow.execute({ contextId }).pipe(
            Effect.forkScoped,
          )
          yield* waitUntilActiveWait(agentOutputAfterWaitName(contextId, activityAttempt, -1))
          yield* Effect.sleep("100 millis")
          const writer = yield* PerContextRuntimeOutputWriter
          yield* writer.appendAgentEvent(
            context,
            activityAttempt,
            0,
            { _tag: "Terminated", exitCode: 0 },
          )
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(workflowLayer),
          Effect.provide(HostRuntimeObservationSubstrateLive),
          Effect.provide(DurableStreamsWorkflowEngine.layer({
            streamUrl: streamUrl(`${namespace}.test.workflow`),
          })),
          Effect.provide(FiregridRuntimeHostWithWorkflowLive({
            durableStreamsBaseUrl: baseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )

    expect(result).toMatchObject({
      contextId,
      activityAttempt,
      sequence: 0,
      _tag: "Terminated",
    })
  })

  it("firegrid-workflow-driven-runtime.VALIDATION.6 proves idempotent startOrAttach across duplicate workflow starts", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-start-idempotent-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const workflowUrl = streamUrl(`${namespace}.host-a.workflow`)
    const waitUrl = streamUrl(`${namespace}.host-a.waits`)
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const outputUrl = streamUrl(`${namespace}.host-a.runtimeOutput`)
    const sessionEvents = { starts: [] as Array<string>, reattaches: [] as Array<string>, emissions: [] as Array<string> }
    const testLayer = runtimeContextWorkflowTestLayer({
      namespace,
      hostId,
      workflowUrl,
      waitUrl,
      controlUrl,
      outputUrl,
      sessionLayer: reconstructableSessionLayer(sessionEvents),
      workerId: "start-idempotent-worker",
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          const output = yield* RuntimeOutputTable
          yield* control.contexts.upsert(seededRuntimeContext({ namespace, hostId, contextId }))
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          yield* waitUntilWorkflowStarted(contextId, 1)
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          yield* output.events.upsert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 0,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* executeNativeRuntimeContext(contextId)
        }).pipe(Effect.provide(testLayer)),
      ),
    )

    expect(result).toMatchObject({ contextId, activityAttempt: 1, exitCode: 0 })
    expect(sessionEvents.starts).toEqual([`${contextId}:1`])
  })

  it("firegrid-workflow-driven-runtime.VALIDATION.6 proves cached startOrAttach replay can lazy reattach on send with an empty registry", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-send-reattach-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const workflowUrl = streamUrl(`${namespace}.host-a.workflow`)
    const waitUrl = streamUrl(`${namespace}.host-a.waits`)
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const outputUrl = streamUrl(`${namespace}.host-a.runtimeOutput`)
    const beforeRestart = { starts: [] as Array<string>, reattaches: [] as Array<string>, emissions: [] as Array<string> }
    const afterRestart = { starts: [] as Array<string>, reattaches: [] as Array<string>, emissions: [] as Array<string> }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          yield* control.contexts.upsert(seededRuntimeContext({ namespace, hostId, contextId }))
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          yield* waitUntilWorkflowStarted(contextId, 1)
        }).pipe(
          Effect.provide(runtimeContextWorkflowTestLayer({
            namespace,
            hostId,
            workflowUrl,
            waitUrl,
            controlUrl,
            outputUrl,
            sessionLayer: reconstructableSessionLayer(beforeRestart),
            workerId: "reattach-before",
          })),
        ),
      ),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const output = yield* RuntimeOutputTable
          yield* output.events.upsert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 0,
            event: {
              _tag: "ToolUse",
              part: Prompt.toolCallPart({
                id: "tool-reattach",
                name: "sleep",
                params: { durationMs: 1 },
                providerExecuted: false,
              }),
            },
          }))
          yield* output.events.upsert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 1,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* executeNativeRuntimeContext(contextId)
        }).pipe(
          Effect.provide(runtimeContextWorkflowTestLayer({
            namespace,
            hostId,
            workflowUrl,
            waitUrl,
            controlUrl,
            outputUrl,
            sessionLayer: reconstructableSessionLayer(afterRestart),
            workerId: "reattach-after",
          })),
        ),
      ),
    )

    expect(result).toMatchObject({ contextId, activityAttempt: 1, exitCode: 0 })
    expect(beforeRestart.starts).toEqual([`${contextId}:1`])
    expect(afterRestart.starts).toEqual([])
    expect(afterRestart.reattaches).toEqual([`${contextId}:1`])
    expect(afterRestart.emissions).toEqual([`tool-${contextId}-1-tool-reattach`])
  })

  it("delivers public session.prompt ingress through RuntimeContextWorkflowSession.send without ingress-delivery tracker", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-prompt-delivery-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const workflowUrl = streamUrl(`${namespace}.host-a.workflow`)
    const waitUrl = streamUrl(`${namespace}.host-a.waits`)
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const outputUrl = streamUrl(`${namespace}.host-a.runtimeOutput`)
    const sent: Array<RuntimeContextSessionCommand> = []

    const testLayer = runtimeContextWorkflowTestLayer({
      namespace,
      hostId,
      workflowUrl,
      waitUrl,
      controlUrl,
      outputUrl,
      sessionLayer: RuntimeContextWorkflowSession.layer({
        startOrAttach: (context, activityAttempt) =>
          Effect.succeed(startedEvidence(context.contextId, activityAttempt)),
        send: (context, activityAttempt, command) =>
          Effect.sync(() => {
            sent.push(command)
            return acceptedCommand(context.contextId, activityAttempt, command)
          }),
      }),
      workerId: "prompt-delivery-worker",
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          const output = yield* RuntimeOutputTable
          const context = seededRuntimeContext({ namespace, hostId, contextId })
          yield* control.contexts.upsert(context)
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          yield* waitUntilWorkflowStarted(contextId, 1)
          yield* appendRuntimeInputDeferred({
            contextId,
            inputId: "input-prompt-1",
            kind: "message",
            authoredBy: "client",
            payload: "hello from session.prompt",
            idempotencyKey: "input-prompt-1",
          }, context)
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          for (let attempt = 0; attempt < 40 && sent.length === 0; attempt += 1) {
            yield* Effect.sleep("25 millis")
          }
          yield* output.events.upsert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 0,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* executeNativeRuntimeContext(contextId)
        }).pipe(Effect.provide(testLayer)),
      ),
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      _tag: "AgentInput",
      commandId: `runtime-input-${contextId}-input-prompt-1`,
      event: {
        _tag: "Prompt",
        correlationId: "input-prompt-1",
      },
    })
  })

  it("firegrid-workflow-driven-runtime.VALIDATION.6 proves send activity replay does not duplicate external emission across restart", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-send-once-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const workflowUrl = streamUrl(`${namespace}.host-a.workflow`)
    const waitUrl = streamUrl(`${namespace}.host-a.waits`)
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const outputUrl = streamUrl(`${namespace}.host-a.runtimeOutput`)
    const beforeRestart = { starts: [] as Array<string>, reattaches: [] as Array<string>, emissions: [] as Array<string> }
    const afterRestart = { starts: [] as Array<string>, reattaches: [] as Array<string>, emissions: [] as Array<string> }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          const output = yield* RuntimeOutputTable
          yield* control.contexts.upsert(seededRuntimeContext({ namespace, hostId, contextId }))
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          yield* waitUntilWorkflowStarted(contextId, 1)
          yield* output.events.upsert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 0,
            event: {
              _tag: "ToolUse",
              part: Prompt.toolCallPart({
                id: "tool-once",
                name: "sleep",
                params: { durationMs: 1 },
                providerExecuted: false,
              }),
            },
          }))
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          yield* Effect.gen(function*() {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              if (beforeRestart.emissions.length >= 1) return
              yield* Effect.sleep("25 millis")
            }
            return yield* Effect.fail(new Error(
              `workflow body did not emit ToolResult before restart: ${contextId}`,
            ))
          })
        }).pipe(
          Effect.provide(runtimeContextWorkflowTestLayer({
            namespace,
            hostId,
            workflowUrl,
            waitUrl,
            controlUrl,
            outputUrl,
            sessionLayer: reconstructableSessionLayer(beforeRestart),
            workerId: "send-once-before",
          })),
        ),
      ),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const output = yield* RuntimeOutputTable
          yield* output.events.upsert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 1,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* executeNativeRuntimeContext(contextId)
        }).pipe(
          Effect.provide(runtimeContextWorkflowTestLayer({
            namespace,
            hostId,
            workflowUrl,
            waitUrl,
            controlUrl,
            outputUrl,
            sessionLayer: reconstructableSessionLayer(afterRestart),
            workerId: "send-once-after",
          })),
        ),
      ),
    )

    expect(result).toMatchObject({ contextId, activityAttempt: 1, exitCode: 0 })
    expect(beforeRestart.emissions).toEqual([`tool-${contextId}-1-tool-once`])
    expect(afterRestart.emissions).toEqual([])
  })

  it("workflow-native runtime-context core skips runtime-output log gaps while waiting for ToolUse output", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-core-tool-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const sent: Array<AgentInputEvent> = []
    let toolRuns = 0

    const workflowUrl = streamUrl(`${namespace}.host-a.workflow`)
    const waitUrl = streamUrl(`${namespace}.host-a.waits`)
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const outputUrl = streamUrl(`${namespace}.host-a.runtimeOutput`)

    const testLayer = RuntimeContextWorkflowNativeLayer.pipe(
      Layer.provideMerge(RuntimeContextWorkflowSession.layer({
        startOrAttach: (context, activityAttempt) =>
          Effect.succeed(startedEvidence(context.contextId, activityAttempt)),
        send: (context, activityAttempt, command) =>
          Effect.sync(() => {
            sent.push(command.event)
            return acceptedCommand(context.contextId, activityAttempt, command)
          }),
      })),
      Layer.provideMerge(RuntimeToolUseExecutor.layer({
        execute: (_context, event) =>
          Effect.sync(() => {
            toolRuns += 1
            return {
              _tag: "ToolResult" as const,
              part: Prompt.toolResultPart({
                id: event.part.id,
                name: event.part.name,
                result: { slept: true },
                isFailure: false,
                providerExecuted: false,
              }),
            }
          }),
      })),
      Layer.provideMerge(DurableToolsWaitForLive({ streamUrl: waitUrl })),
      Layer.provideMerge(RuntimeControlPlaneRecorderLive),
      Layer.provideMerge(RuntimeAgentOutputEventsLayer),
      Layer.provideMerge(testHostWideRuntimeAgentOutputAfterEventsLive),
      Layer.provideMerge(DurableStreamsWorkflowEngine.layer({ streamUrl: workflowUrl })),
      Layer.provideMerge(RuntimeControlPlaneTable.layer({
        streamOptions: { url: controlUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeOutputTable.layer({
        streamOptions: { url: outputUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(hostSessionLayer(namespace, hostId)),
      Layer.provideMerge(hostConfigLayer(namespace)),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          const output = yield* RuntimeOutputTable
          yield* control.contexts.upsert({
            contextId,
            createdAt: new Date().toISOString(),
            runtime: normalizeRuntimeIntent(local.jsonl({
              argv: ["node", "-e", "process.exit(0)"],
              agentProtocol: "stdio-jsonl",
            })),
            host: {
              hostId,
              streamPrefix: makeHostStreamPrefix({ namespace, hostId }),
              boundAtMs: Date.now(),
            },
          })
          yield* executeNativeRuntimeContext(contextId, { discard: true })
          yield* output.logs.insert(logRow({
            contextId,
            activityAttempt: 1,
            sequence: 0,
          }))
          yield* output.events.insert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 1,
            event: {
              _tag: "ToolUse",
              part: Prompt.toolCallPart({
                id: "tool-1",
                name: "sleep",
                params: { durationMs: 1 },
                providerExecuted: false,
              }),
            },
          }))
          yield* output.events.insert(outputRow({
            contextId,
            activityAttempt: 1,
            sequence: 2,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* executeNativeRuntimeContext(contextId)
        }).pipe(Effect.provide(testLayer)),
      ),
    )

    expect(toolRuns).toBe(1)
    expect(sent).toMatchObject([{ _tag: "ToolResult", part: { id: "tool-1" } }])
    expect(result).toMatchObject({ contextId, activityAttempt: 1, exitCode: 0 })
  })
})
