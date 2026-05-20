import { DurableStreamTestServer } from "@durable-streams/server"
import { Chunk, Effect, Either, Option, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { HostId } from "@firegrid/protocol/launch"
import {
  ChannelRegistry,
  ChannelRegistryLive,
  FactoryEventsChannelTarget,
  FiregridRuntimeHostWithWorkflowLive,
  UnknownChannelTarget,
  makeCallableChannel,
  makeChannelRegistry,
  makeChannelTarget,
  makeEfferentChannel,
  makeFactoryEventsChannel,
} from "../../src/host/index.ts"

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
