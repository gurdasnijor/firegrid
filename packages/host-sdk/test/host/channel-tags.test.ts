import { DurableStreamTestServer } from "@durable-streams/server"
import { Chunk, Effect, Fiber, Option, Schema, Stream } from "effect"
import { access, readFile } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  RuntimeControlPlaneTable,
  type HostId,
} from "@firegrid/protocol/launch"
import {
  RuntimeContextMcpChannelCatalog,
  channelMetadata,
  findRuntimeContextMcpChannel,
  FiregridRuntimeHostWithWorkflowLive,
  makeCallableChannel,
  makeChannelTarget,
  makeEgressChannel,
  makeIngressChannel,
  SessionSelfCheckpointChannel,
  SessionSelfCheckpointChannelTarget,
  SessionSelfLifecycleChannel,
  SessionSelfLifecycleChannelTarget,
} from "../../src/host/index.ts"
import {
  RuntimeContextCheckpointSource,
  RuntimeContextWorkflowRuntime,
} from "../../src/host/runtime-context-workflow-runtime.ts"

const FactoryEventRowSchema = Schema.Struct({
  eventType: Schema.String,
  payload: Schema.Unknown,
})

const NotifySchema = Schema.Struct({
  message: Schema.String,
})

const ApprovalRequestSchema = Schema.Struct({
  prompt: Schema.String,
})

const ApprovalResponseSchema = Schema.Struct({
  approved: Schema.Boolean,
})

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

describe("channel Tags", () => {
  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.1 decodes ChannelTarget as an opaque non-empty string token", () => {
    const target = makeChannelTarget("factory.events")

    expect(target).toBe("factory.events")
    expect(() => makeChannelTarget("")).toThrow()
  })

  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.2 firegrid-agent-body-plan.CHANNEL_REGISTRY.3 firegrid-agent-body-plan.CHANNEL_REGISTRY.4 provides channels through their own Tags without binding metadata", async () => {
    const factoryEvent = {
      eventType: "factory.run.approved",
      payload: { approved: true },
    }
    const emitted: Array<Schema.Schema.Type<typeof NotifySchema>> = []
    const factory = makeIngressChannel({
      target: "factory.events",
      schema: FactoryEventRowSchema,
      stream: Stream.succeed(factoryEvent),
    })
    const notify = makeEgressChannel({
      target: "notification.operator",
      schema: NotifySchema,
      append: payload =>
        Effect.sync(() => {
          emitted.push(payload)
        }),
    })
    const approval = makeCallableChannel({
      target: "approval.operator",
      requestSchema: ApprovalRequestSchema,
      responseSchema: ApprovalResponseSchema,
      call: request => Effect.succeed({ approved: request.prompt.length > 0 }),
    })

    const metadata = [factory, notify, approval].map(channelMetadata)
    expect(metadata.map(entry => entry.direction)).toEqual([
      "ingress",
      "egress",
      "call",
    ])
    for (const entry of metadata) {
      expect("binding" in entry).toBe(false)
    }

    const rows = await Effect.runPromise(
      Stream.runCollect(factory.binding.stream).pipe(
        Effect.map(Chunk.toReadonlyArray),
      ),
    )
    expect(rows).toEqual([factoryEvent])

    await Effect.runPromise(notify.binding.append({ message: "ready" }))
    expect(emitted).toEqual([{ message: "ready" }])

    await expect(
      Effect.runPromise(approval.binding.call({ prompt: "Ship?" })),
    ).resolves.toEqual({ approved: true })
  })

  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.5 composes factory.events as a host channel Layer without CallerFact or stream metadata", async () => {
    expect(baseUrl).toBeDefined()
    const durableStreamsBaseUrl = baseUrl ?? ""
    const channel = makeIngressChannel({
      target: "factory.events",
      schema: FactoryEventRowSchema,
      stream: Stream.empty,
    })
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const namespace = `channel-tags-${crypto.randomUUID()}`

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const inventory = yield* RuntimeContextMcpChannelCatalog
        const provided = Option.getOrThrow(findRuntimeContextMcpChannel(inventory, "factory.events"))
        const metadata = channelMetadata(provided)
        return {
          direction: metadata.direction,
          target: metadata.target,
          text: JSON.stringify(metadata),
        }
      }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl,
          namespace,
          hostId,
          controlRequestReconciler: false,
          mcpChannels: [channel],
        })),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({
      direction: "ingress",
      target: "factory.events",
    })
    expect(result.text).not.toContain("CallerFact")
    expect(result.text).not.toContain("stream")
  })

  it("firegrid-agent-body-plan.SESSION_SELF.1 firegrid-agent-body-plan.SESSION_SELF.2 firegrid-agent-body-plan.SESSION_SELF.3 provides session.self lifecycle and checkpoint channels without substrate metadata", async () => {
    expect(baseUrl).toBeDefined()
    const durableStreamsBaseUrl = baseUrl ?? ""
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const namespace = `session-self-channel-${crypto.randomUUID()}`
    const contextId = `ctx_${crypto.randomUUID()}`
    const streamPrefix = makeHostStreamPrefix({ namespace, hostId })

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* RuntimeControlPlaneTable
        const workflowRuntime = yield* RuntimeContextWorkflowRuntime
        const checkpoints = yield* RuntimeContextCheckpointSource
        const lifecycle = yield* SessionSelfLifecycleChannel
        const checkpoint = yield* SessionSelfCheckpointChannel
        const lifecycleMetadata = channelMetadata(lifecycle)
        const checkpointMetadata = channelMetadata(checkpoint)
        const lifecycleStream = lifecycle.binding.stream
        const checkpointStream = checkpoint.binding.stream
        const lifecycleFiber = yield* lifecycleStream.pipe(
          Stream.filter(event =>
            event.event.contextId === contextId &&
            event.event.status === "started",
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.fork,
        )
        const runtime = normalizeRuntimeIntent(local.jsonl({
          argv: [
            process.execPath,
            "--input-type=module",
            "-e",
            "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ready'}]}}))",
          ],
        }))
        const context = {
          contextId,
          createdAt: new Date().toISOString(),
          runtime,
          host: {
            hostId,
            streamPrefix,
            boundAtMs: Date.now(),
          },
        }
        yield* control.contexts.upsert(context)
        yield* workflowRuntime.ensureActive(context)
        const handle = Option.getOrThrow(yield* checkpoints.get(contextId))
        const checkpointFiber = yield* checkpointStream.pipe(
          Stream.filter(event =>
            event.contextId === contextId &&
            event._tag === "Execution" &&
            event.workflowName === "firegrid.runtime-context",
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.fork,
        )
        yield* handle.table.executions.upsert({
          executionId: handle.executionId,
          workflowName: "firegrid.runtime-context",
          payload: { contextId },
          interrupted: false,
          suspended: true,
        })
        yield* control.runs.upsert({
          runEventId: {
            contextId,
            activityAttempt: 1,
            status: "started",
          },
          contextId,
          activityAttempt: 1,
          provider: "local-process",
          status: "started",
          at: new Date().toISOString(),
        })
        const lifecycleEvent = yield* Fiber.join(lifecycleFiber)
        const checkpointEvent = yield* Fiber.join(checkpointFiber)
        return {
          lifecycleDirection: lifecycleMetadata.direction,
          checkpointDirection: checkpointMetadata.direction,
          lifecycleText: JSON.stringify(lifecycleMetadata),
          checkpointText: JSON.stringify(checkpointMetadata),
          lifecycleEvent,
          checkpointEvent,
        }
      }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl,
          namespace,
          hostId,
          controlRequestReconciler: false,
        })),
        Effect.scoped,
      ),
    )

    expect(observed.lifecycleDirection).toBe("ingress")
    expect(observed.checkpointDirection).toBe("ingress")
    expect(observed.lifecycleEvent).toMatchObject({
      channel: SessionSelfLifecycleChannelTarget,
      event: {
        contextId,
        status: "started",
      },
    })
    expect(observed.checkpointEvent).toMatchObject({
      _tag: "Execution",
      channel: SessionSelfCheckpointChannelTarget,
      contextId,
      workflowName: "firegrid.runtime-context",
    })
    expect(observed.lifecycleText).not.toContain("firegrid.runtime_context.workflow")
    expect(observed.lifecycleText).not.toContain("WorkflowEngineTable")
    expect(observed.lifecycleText).not.toContain("stream")
    expect(observed.checkpointText).not.toContain("firegrid.runtime_context.workflow")
    expect(observed.checkpointText).not.toContain("WorkflowEngineTable")
    expect(observed.checkpointText).not.toContain("stream")
  })

  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.2-1 removes the ChannelRegistry service surface", async () => {
    await expect(
      access(new URL("../../src/host/channel-registry.ts", import.meta.url)),
    ).rejects.toThrow()
    const sourceFiles = await Promise.all([
      "../../src/agent-tools/execution/tool-use-to-effect.ts",
      "../../src/host/layers.ts",
      "../../src/host/mcp-channel-metadata.ts",
    ].map(path => readFile(new URL(path, import.meta.url), "utf8")))
    expect(sourceFiles.join("\n")).not.toContain("ChannelRegistry")
    expect(sourceFiles.join("\n")).not.toContain("channel-registry")
  })
})
