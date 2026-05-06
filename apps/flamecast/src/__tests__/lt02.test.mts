import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  FiregridClient,
  FiregridClientLive,
} from "@firegrid/client"
import { run } from "@firegrid/runtime"
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { makeFlamecastRuntime } from "../runtime/handler.ts"
import {
  SessionEvents,
  SessionTurn,
  detailForSession,
  summarizeSessions,
} from "../shared/protocol.ts"

describe("LT-02 local Flamecast chassis", () => {
  it("flamecast-product-contract.LOWERING.3, firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2 - UI send plus runtime EventStream timeline completes two turns", async () => {
    const server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    const streamUrl = `${server.url}/flamecast/test-${crypto.randomUUID()}`
    await DurableStream.create({ url: streamUrl, contentType: "application/json" })
    const runtimeFiber = Effect.runFork(
      run({
        connection: { streamUrl },
        runtime: makeFlamecastRuntime({
          streamUrl,
          clientId: "flamecast-test-runtime",
        }),
      }),
    )
    try {
      const clientLayer = FiregridClientLive({
        streamUrl,
        clientId: "flamecast-test-ui",
      })
      const sessionId = `fc_session_${crypto.randomUUID()}`

      const eventsFiber = Effect.runFork(
        Effect.gen(function* () {
          const client = yield* FiregridClient
          return yield* client.events(SessionEvents).pipe(
            Stream.take(8),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          )
        }).pipe(Effect.provide(clientLayer)),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* FiregridClient
          yield* client.send(SessionTurn, {
            sessionId,
            turnId: `fc_turn_${crypto.randomUUID()}`,
            message: "draft local chassis",
            ordinal: 1,
          })
          yield* client.send(SessionTurn, {
            sessionId,
            turnId: `fc_turn_${crypto.randomUUID()}`,
            message: "send durable follow up",
            ordinal: 2,
          })
        }).pipe(Effect.provide(clientLayer)),
      )

      const events = await Effect.runPromise(Fiber.join(eventsFiber))
      expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(2)
      expect(summarizeSessions(events)).toMatchObject([
        { sessionId, status: "complete", turnCount: 2 },
      ])
      expect(detailForSession(events, sessionId)?.events).toHaveLength(8)
    } finally {
      await Effect.runPromise(Fiber.interrupt(runtimeFiber))
      await server.stop()
    }
  })
})
