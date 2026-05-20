import { DurableStreamTestServer } from "@durable-streams/server"
import { Chunk, Effect, Either, Fiber, Option, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  RuntimeControlPlaneTable,
  type HostId,
} from "@firegrid/protocol/launch"
import {
  ChannelRegistry,
  ChannelRegistryLive,
  FactoryEventsChannelTarget,
  FiregridRuntimeHostWithWorkflowLive,
  SessionSelfCheckpointChannelTarget,
  SessionSelfLifecycleChannelTarget,
  UnknownChannelTarget,
  makeCallableChannel,
  makeChannelRegistry,
  makeChannelTarget,
  makeEfferentChannel,
  makeFactoryEventsChannel,
  type SessionSelfCheckpointEvent,
  type SessionSelfLifecycleEvent,
} from "../../src/host/index.ts"
import {
  RuntimeContextEngineRegistry,
} from "../../src/host/runtime-context-engine-registry.ts"

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

describe("ChannelRegistry", () => {
  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.1 decodes ChannelTarget as an opaque non-empty string token", () => {
    const target = makeChannelTarget("factory.events")

    expect(target).toBe("factory.events")
    expect(() => makeChannelTarget("")).toThrow()
  })

  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.2 firegrid-agent-body-plan.CHANNEL_REGISTRY.3 firegrid-agent-body-plan.CHANNEL_REGISTRY.4 registers direction, schema metadata, and hidden bindings", async () => {
    const factoryEvent = {
      eventType: "factory.run.approved",
      payload: { approved: true },
    }
    const emitted: Array<Schema.Schema.Type<typeof NotifySchema>> = []
    const registry = makeChannelRegistry([
      makeFactoryEventsChannel({
        schema: FactoryEventRowSchema,
        stream: Stream.succeed(factoryEvent),
      }),
      makeEfferentChannel({
        target: "notification.operator",
        schema: NotifySchema,
        append: payload =>
          Effect.sync(() => {
            emitted.push(payload)
          }),
      }),
      makeCallableChannel({
        target: "approval.operator",
        requestSchema: ApprovalRequestSchema,
        responseSchema: ApprovalResponseSchema,
        call: request => Effect.succeed({ approved: request.prompt.length > 0 }),
      }),
    ])

    const metadata = registry.metadata()
    expect(metadata.map(entry => entry.direction)).toEqual([
      "afferent",
      "efferent",
      "call",
    ])
    for (const entry of metadata) {
      expect("binding" in entry).toBe(false)
    }

    const factoryRegistration = await Effect.runPromise(
      registry.require(FactoryEventsChannelTarget),
    )
    expect(factoryRegistration.direction).toBe("afferent")
    if (factoryRegistration.direction !== "afferent") {
      return
    }
    const rows = await Effect.runPromise(
      Stream.runCollect(factoryRegistration.binding.stream).pipe(
        Effect.map(Chunk.toReadonlyArray),
      ),
    )
    expect(rows).toEqual([factoryEvent])

    const notify = await Effect.runPromise(
      registry.require("notification.operator"),
    )
    expect(notify.direction).toBe("efferent")
    if (notify.direction !== "efferent") {
      return
    }
    await Effect.runPromise(notify.binding.append({ message: "ready" }))
    expect(emitted).toEqual([{ message: "ready" }])

    const approval = await Effect.runPromise(
      registry.require("approval.operator"),
    )
    expect(approval.direction).toBe("call")
    if (approval.direction !== "call") {
      return
    }
    await expect(
      Effect.runPromise(approval.binding.call({ prompt: "Ship?" })),
    ).resolves.toEqual({ approved: true })

    const missing = await Effect.runPromise(Effect.either(registry.require("missing")))
    expect(Either.isLeft(missing)).toBe(true)
    if (Either.isLeft(missing)) {
      expect(missing.left).toBeInstanceOf(UnknownChannelTarget)
    }
  })

  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.5 composes factory.events through the host layer without CallerFact or stream metadata", async () => {
    expect(baseUrl).toBeDefined()
    const durableStreamsBaseUrl = baseUrl ?? ""
    const channel = makeFactoryEventsChannel({
      schema: FactoryEventRowSchema,
      stream: Stream.empty,
    })
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const namespace = `channel-registry-${crypto.randomUUID()}`

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ChannelRegistry
        const metadata = Option.getOrThrow(
          registry.getMetadata(FactoryEventsChannelTarget),
        )
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
          channels: [channel],
        })),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({
      direction: "afferent",
      target: "factory.events",
    })
    expect(result.text).not.toContain("CallerFact")
    expect(result.text).not.toContain("stream")
  })

  it("firegrid-agent-body-plan.SESSION_SELF.1 firegrid-agent-body-plan.SESSION_SELF.2 firegrid-agent-body-plan.SESSION_SELF.3 registers session.self lifecycle and checkpoint channels without substrate metadata", async () => {
    expect(baseUrl).toBeDefined()
    const durableStreamsBaseUrl = baseUrl ?? ""
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const namespace = `session-self-channel-${crypto.randomUUID()}`
    const contextId = `ctx_${crypto.randomUUID()}`
    const streamPrefix = makeHostStreamPrefix({ namespace, hostId })

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* RuntimeControlPlaneTable
        const registry = yield* ChannelRegistry
        const engineRegistry = yield* RuntimeContextEngineRegistry
        const lifecycleMetadata = Option.getOrThrow(
          registry.getMetadata(SessionSelfLifecycleChannelTarget),
        )
        const checkpointMetadata = Option.getOrThrow(
          registry.getMetadata(SessionSelfCheckpointChannelTarget),
        )
        const lifecycle = yield* registry.require(SessionSelfLifecycleChannelTarget)
        const checkpoint = yield* registry.require(SessionSelfCheckpointChannelTarget)
        if (lifecycle.direction !== "afferent" || checkpoint.direction !== "afferent") {
          return yield* Effect.fail(new Error("session.self channels must be afferent"))
        }
        const lifecycleStream = lifecycle.binding.stream as Stream.Stream<
          SessionSelfLifecycleEvent,
          unknown,
          never
        >
        const checkpointStream = checkpoint.binding.stream as Stream.Stream<
          SessionSelfCheckpointEvent,
          unknown,
          never
        >
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
        const handle = yield* engineRegistry.claimActive(context)
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
          executionId: `session-self-checkpoint:${contextId}`,
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

    expect(observed.lifecycleDirection).toBe("afferent")
    expect(observed.checkpointDirection).toBe("afferent")
    expect(observed.lifecycleEvent).toMatchObject({
      channel: "session.self.lifecycle",
      event: {
        contextId,
        status: "started",
      },
    })
    expect(observed.checkpointEvent).toMatchObject({
      _tag: "Execution",
      channel: "session.self.checkpoint",
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

  it("firegrid-agent-body-plan.SLICE_BOUNDARY.1 provides the registry as an additive host layer", async () => {
    const channel = makeFactoryEventsChannel({
      schema: FactoryEventRowSchema,
      stream: Stream.empty,
    })

    const registry = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* ChannelRegistry
      }).pipe(
        Effect.provide(ChannelRegistryLive([channel])),
      ),
    )

    expect(Option.isSome(registry.get("factory.events"))).toBe(true)
  })
})
