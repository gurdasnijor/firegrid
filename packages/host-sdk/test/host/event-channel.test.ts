import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  eventChannelFromCollection,
  makeChannelRegistry,
  type EventChannel,
} from "../../src/host/index.ts"

const EventRowSchema = Schema.Struct({
  eventId: Schema.String.pipe(DurableTable.primaryKey),
  name: Schema.String,
  payload: Schema.Struct({
    note: Schema.String,
  }),
  emittedAt: Schema.String,
})

class EventChannelTestTable extends DurableTable("eventChannelTest", {
  events: EventRowSchema,
}) {}

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

const tableLayerOptions = (): DurableTableLayerOptions => {
  expect(baseUrl).toBeDefined()
  return {
    streamOptions: {
      url: `${baseUrl ?? ""}/event-channel-${crypto.randomUUID()}`,
      contentType: "application/json",
    },
  }
}

const runWithTable = <A, E>(
  effect: Effect.Effect<A, E, EventChannelTestTable>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          EventChannelTestTable.layer(tableLayerOptions()),
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  )

describe("event(name) channel", () => {
  it("firegrid-agent-body-plan.EVENT_CHANNEL.1 firegrid-agent-body-plan.EVENT_CHANNEL.2 firegrid-agent-body-plan.EVENT_CHANNEL.3 firegrid-agent-body-plan.EVENT_CHANNEL.4 firegrid-agent-body-plan.EVENT_CHANNEL.5 firegrid-agent-body-plan.SLICE_BOUNDARY.4 registers one opaque event target with read and write CallerFact-backed bindings", async () => {
    const program = Effect.gen(function* () {
      const table = yield* EventChannelTestTable
      const channel = eventChannelFromCollection({
        name: "plan.ready",
        schema: EventRowSchema,
        callerFactStream: "inv5.events",
        collection: table.events,
      })

      const registry = makeChannelRegistry([channel])
      const agentVisibleWaitInput = { channel: "event.plan.ready" }
      const agentVisibleSendInput = {
        channel: "event.plan.ready",
        payload: { note: "ready" },
      }
      const registered = yield* registry.require(agentVisibleWaitInput.channel)
      const event = registered as EventChannel<typeof EventRowSchema>

      expect(event.kind).toBe("event")
      expect(event.eventName).toBe("plan.ready")
      expect(event.direction).toBe("bidirectional")
      expect(event.directions).toEqual(["ingress", "egress"])
      expect(event.sourceClasses).toEqual(["static-source", "predicate-eligible"])
      expect(event.schema).toBe(EventRowSchema)

      const metadata = Option.getOrThrow(
        registry.getMetadata(agentVisibleWaitInput.channel),
      )
      expect(metadata.direction).toBe("bidirectional")
      if (metadata.direction !== "bidirectional") {
        return
      }
      expect(metadata.schema).toBe(EventRowSchema)
      expect(metadata.sourceClasses).toEqual(["static-source", "predicate-eligible"])
      expect(JSON.stringify(metadata)).not.toContain("inv5.events")
      expect(JSON.stringify(agentVisibleWaitInput)).not.toContain("inv5.events")
      expect(JSON.stringify(agentVisibleSendInput)).not.toContain("inv5.events")

      yield* table.events.insert({
        eventId: "event-other",
        name: "other.event",
        payload: { note: "ignore" },
        emittedAt: "2026-05-20T10:00:00.000Z",
      })
      yield* event.binding.append({
        eventId: "event-plan-ready",
        name: "plan.ready",
        payload: { note: "ready" },
        emittedAt: "2026-05-20T10:01:00.000Z",
      })

      const observed = yield* event.binding.stream.pipe(
        Stream.runHead,
      )

      expect(Option.getOrThrow(observed)).toEqual({
        eventId: "event-plan-ready",
        name: "plan.ready",
        payload: { note: "ready" },
        emittedAt: "2026-05-20T10:01:00.000Z",
      })
    }) as Effect.Effect<void, unknown, EventChannelTestTable>

    await runWithTable(program)
  })
})
