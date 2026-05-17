import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt } from "@effect/ai"
import { Workflow } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  hostOwnedStreamUrl,
  local,
  makeHostSessionRow,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostSessionId,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  RuntimeIngressInputRowSchema,
  makeRuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Fiber, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeControlPlaneRecorderLive,
  RuntimeIngressAppenderLayer,
  RuntimeOutputJournalLayer,
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/host-substrate"
import {
  encodeRuntimeAgentOutputEnvelope,
  type AgentInputEvent,
} from "@firegrid/runtime/events"
import { DurableToolsWaitForLive, WaitFor } from "@firegrid/runtime/durable-tools"
import {
  FiregridRuntimeHostWithWorkflowLive,
} from "../../src/host/layers.ts"
import {
  RuntimeHostConfig,
} from "../../src/host/config.ts"
import {
  HostRuntimeObservationSubstrateLive,
} from "../../src/host/runtime-substrate.ts"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowNativeLayer,
  RuntimeContextWorkflowSession,
} from "../../src/host/runtime-context-workflow-core.ts"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"

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

describe("workflow-native runtime-context core", () => {
  it("host observation substrate resolves AgentOutputAfter from per-context output initial state", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-output-initial-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const activityAttempt = 1
    const prefix = makeHostStreamPrefix({ namespace, hostId })

    const workflowUrl = hostOwnedStreamUrl({ baseUrl, prefix, segment: "workflow" })
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const ingressUrl = hostOwnedStreamUrl({ baseUrl, prefix, segment: "runtimeIngress" })
    const hostOutputUrl = hostOwnedStreamUrl({ baseUrl, prefix, segment: "runtimeOutput" })
    const contextOutputUrl = runtimeContextOutputStreamUrl({ baseUrl, prefix, contextId })

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
          name: `runtime-context/${payloadContextId}/output-after/${activityAttempt}/-1`,
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

    const testLayer = workflowLayer.pipe(
      Layer.provideMerge(HostRuntimeObservationSubstrateLive),
      Layer.provideMerge(DurableStreamsWorkflowEngine.layer({ streamUrl: workflowUrl })),
      Layer.provideMerge(RuntimeControlPlaneTable.layer({
        streamOptions: { url: controlUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeIngressTable.layer({
        streamOptions: { url: ingressUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeOutputTable.layer({
        streamOptions: { url: hostOutputUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(Layer.succeed(RuntimeHostConfig, {
        durableStreamsBaseUrl: baseUrl,
        inputEnabled: false,
      })),
      Layer.provideMerge(hostSessionLayer(namespace, hostId)),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const output = yield* RuntimeOutputTable
          yield* output.events.insert(outputRow({
            contextId,
            activityAttempt,
            sequence: 0,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* AgentOutputAfterWorkflow.execute({ contextId })
        }).pipe(
          Effect.provide(RuntimeOutputTable.layer({
            streamOptions: { url: contextOutputUrl, contentType: "application/json" },
          })),
          Effect.provide(testLayer),
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

  it("host observation substrate resolves AgentOutputAfter from per-context output live writes", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-output-live-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const activityAttempt = 1
    const prefix = makeHostStreamPrefix({ namespace, hostId })

    const workflowUrl = hostOwnedStreamUrl({ baseUrl, prefix, segment: "workflow" })
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const ingressUrl = hostOwnedStreamUrl({ baseUrl, prefix, segment: "runtimeIngress" })
    const hostOutputUrl = hostOwnedStreamUrl({ baseUrl, prefix, segment: "runtimeOutput" })
    const contextOutputUrl = runtimeContextOutputStreamUrl({ baseUrl, prefix, contextId })

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
          name: `runtime-context/${payloadContextId}/output-after/${activityAttempt}/-1`,
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

    const testLayer = workflowLayer.pipe(
      Layer.provideMerge(HostRuntimeObservationSubstrateLive),
      Layer.provideMerge(DurableStreamsWorkflowEngine.layer({ streamUrl: workflowUrl })),
      Layer.provideMerge(RuntimeControlPlaneTable.layer({
        streamOptions: { url: controlUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeIngressTable.layer({
        streamOptions: { url: ingressUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeOutputTable.layer({
        streamOptions: { url: hostOutputUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(Layer.succeed(RuntimeHostConfig, {
        durableStreamsBaseUrl: baseUrl,
        inputEnabled: false,
      })),
      Layer.provideMerge(hostSessionLayer(namespace, hostId)),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const fiber = yield* AgentOutputAfterWorkflow.execute({ contextId }).pipe(
            Effect.forkScoped,
          )
          const output = yield* RuntimeOutputTable
          yield* output.events.insert(outputRow({
            contextId,
            activityAttempt,
            sequence: 0,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(RuntimeOutputTable.layer({
            streamOptions: { url: contextOutputUrl, contentType: "application/json" },
          })),
          Effect.provide(testLayer),
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

  it("production host composition resolves AgentOutputAfter from per-context output initial state", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-output-host-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const activityAttempt = 1
    const prefix = makeHostStreamPrefix({ namespace, hostId })
    const contextOutputUrl = runtimeContextOutputStreamUrl({ baseUrl, prefix, contextId })

    const AgentOutputAfterWorkflow = Workflow.make({
      name: "path-x-agent-output-after-production-host",
      payload: Schema.Struct({ contextId: Schema.String }),
      success: Schema.Unknown,
      error: Schema.Unknown,
      idempotencyKey: payload => payload.contextId,
    })
    const workflowLayer = AgentOutputAfterWorkflow.toLayer(({ contextId: payloadContextId }) =>
      Effect.gen(function*() {
        const outcome = yield* WaitFor.match({
          name: `runtime-context/${payloadContextId}/output-after/${activityAttempt}/-1`,
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
          const output = yield* RuntimeOutputTable
          yield* output.events.insert(outputRow({
            contextId,
            activityAttempt,
            sequence: 0,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* AgentOutputAfterWorkflow.execute({ contextId })
        }).pipe(
          Effect.provide(RuntimeOutputTable.layer({
            streamOptions: { url: contextOutputUrl, contentType: "application/json" },
          })),
          Effect.provide(workflowLayer),
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

  it("production host composition resolves AgentOutputAfter from per-context output live writes", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-output-host-live-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const activityAttempt = 1
    const prefix = makeHostStreamPrefix({ namespace, hostId })
    const contextOutputUrl = runtimeContextOutputStreamUrl({ baseUrl, prefix, contextId })

    const AgentOutputAfterWorkflow = Workflow.make({
      name: "path-x-agent-output-after-production-host-live",
      payload: Schema.Struct({ contextId: Schema.String }),
      success: Schema.Unknown,
      error: Schema.Unknown,
      idempotencyKey: payload => payload.contextId,
    })
    const workflowLayer = AgentOutputAfterWorkflow.toLayer(({ contextId: payloadContextId }) =>
      Effect.gen(function*() {
        const outcome = yield* WaitFor.match({
          name: `runtime-context/${payloadContextId}/output-after/${activityAttempt}/-1`,
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
          const output = yield* RuntimeOutputTable
          yield* output.events.insert(outputRow({
            contextId,
            activityAttempt,
            sequence: 0,
            event: { _tag: "Terminated", exitCode: 0 },
          }))
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(RuntimeOutputTable.layer({
            streamOptions: { url: contextOutputUrl, contentType: "application/json" },
          })),
          Effect.provide(workflowLayer),
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

  it("workflow-native runtime-context core resolves sequenced input commands through runtime-context wait-router scope", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `path-x-core-${crypto.randomUUID()}`
    const hostId = "host-a" as HostId
    const contextId = `ctx_${crypto.randomUUID()}`

    const workflowUrl = streamUrl(`${namespace}.host-a.workflow`)
    const waitUrl = streamUrl(`${namespace}.host-a.waits`)
    const controlUrl = streamUrl(`${namespace}.firegrid.runtime`)
    const ingressUrl = streamUrl(`${namespace}.host-a.runtimeIngress`)
    const outputUrl = streamUrl(`${namespace}.host-a.runtimeOutput`)

    const RuntimeIngressCommandWorkflow = Workflow.make({
      name: "path-x-runtime-ingress-command-wait",
      payload: Schema.Struct({ contextId: Schema.String }),
      success: RuntimeIngressInputRowSchema,
      error: Schema.Unknown,
      idempotencyKey: payload => payload.contextId,
    })
    const workflowLayer = RuntimeIngressCommandWorkflow.toLayer(({ contextId }) =>
      Effect.gen(function*() {
        const outcome = yield* WaitFor.match({
          name: `runtime-context/${contextId}/input/0`,
          source: { _tag: "RuntimeIngressInput" },
          trigger: [
            { path: ["contextId"], equals: contextId },
            { path: ["status"], equals: "sequenced" },
            { path: ["sequence"], equals: 0 },
          ],
          resultSchema: RuntimeIngressInputRowSchema,
        })
        if (outcome._tag === "Timeout") {
          return yield* Effect.fail("unexpected timeout")
        }
        return outcome.row
      }))

    const testLayer = workflowLayer.pipe(
      Layer.provideMerge(DurableToolsWaitForLive({ streamUrl: waitUrl })),
      Layer.provideMerge(RuntimeControlPlaneRecorderLive),
      Layer.provideMerge(RuntimeIngressAppenderLayer({ currentContextId: contextId })),
      Layer.provideMerge(RuntimeOutputJournalLayer),
      Layer.provideMerge(DurableStreamsWorkflowEngine.layer({ streamUrl: workflowUrl })),
      Layer.provideMerge(RuntimeControlPlaneTable.layer({
        streamOptions: { url: controlUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeIngressTable.layer({
        streamOptions: { url: ingressUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeOutputTable.layer({
        streamOptions: { url: outputUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(hostSessionLayer(namespace, hostId)),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          const ingress = yield* RuntimeIngressTable
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
          yield* RuntimeIngressCommandWorkflow.execute({ contextId }, { discard: true })
          yield* ingress.inputs.insert({
            ...makeRuntimeIngressInputRow({
              inputId: "input-0",
              contextId,
              kind: "message",
              authoredBy: "client",
              payload: "hello",
            }),
            status: "sequenced",
            sequence: 0,
            sequencedAt: new Date().toISOString(),
          })
          return yield* RuntimeIngressCommandWorkflow.execute({ contextId })
        }).pipe(Effect.provide(testLayer)),
      ),
    )

    expect(result).toMatchObject({ contextId, inputId: "input-0", sequence: 0 })
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
    const ingressUrl = streamUrl(`${namespace}.host-a.runtimeIngress`)
    const outputUrl = streamUrl(`${namespace}.host-a.runtimeOutput`)

    const testLayer = RuntimeContextWorkflowNativeLayer.pipe(
      Layer.provideMerge(RuntimeContextWorkflowSession.layer({
        startOrAttach: (context, activityAttempt) =>
          Effect.succeed({
            contextId: context.contextId,
            activityAttempt,
            supervisorSessionId: "test-supervisor",
            startCommandId: "test-start",
          }),
        send: (_context, _activityAttempt, command) =>
          Effect.sync(() => {
            sent.push(command.event)
            return {
              contextId: _context.contextId,
              activityAttempt: _activityAttempt,
              supervisorSessionId: "test-supervisor",
              commandId: command.commandId,
            }
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
      Layer.provideMerge(RuntimeIngressAppenderLayer({ currentContextId: contextId })),
      Layer.provideMerge(RuntimeOutputJournalLayer),
      Layer.provideMerge(DurableStreamsWorkflowEngine.layer({ streamUrl: workflowUrl })),
      Layer.provideMerge(RuntimeControlPlaneTable.layer({
        streamOptions: { url: controlUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeIngressTable.layer({
        streamOptions: { url: ingressUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(RuntimeOutputTable.layer({
        streamOptions: { url: outputUrl, contentType: "application/json" },
      })),
      Layer.provideMerge(hostSessionLayer(namespace, hostId)),
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
          yield* RuntimeContextWorkflowNative.execute(
            { contextId },
            { discard: true },
          )
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
          return yield* RuntimeContextWorkflowNative.execute({ contextId })
        }).pipe(Effect.provide(testLayer)),
      ),
    )

    expect(toolRuns).toBe(1)
    expect(sent).toMatchObject([{ _tag: "ToolResult", part: { id: "tool-1" } }])
    expect(result).toMatchObject({ contextId, activityAttempt: 1, exitCode: 0 })
  })
})
