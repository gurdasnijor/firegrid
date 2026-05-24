import {
  makeBidirectionalChannel,
  makeCallableChannel,
} from "@firegrid/protocol/channels"
import { Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TestStreamServer } from "../../effect-durable-operators/test/harness.ts"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  type ClientOptions,
} from "../src/firegrid.ts"

const BoardRowSchema = Schema.Struct({
  id: Schema.String,
  group: Schema.String,
  kind: Schema.String,
  nested: Schema.Struct({
    status: Schema.String,
  }),
})

type BoardRow = typeof BoardRowSchema.Type

const EchoRequestSchema = Schema.Struct({
  value: Schema.String,
})

const EchoResponseSchema = Schema.Struct({
  echoed: Schema.String,
})

let server: TestStreamServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new TestStreamServer()
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const configuredClientLayer = (
  channels: ClientOptions["channels"],
) => {
  if (baseUrl === undefined) throw new Error("server not started")
  return FiregridStandaloneLive.pipe(
    Layer.provide(
      Layer.succeed(FiregridConfig, {
        durableStreamsBaseUrl: baseUrl,
        namespace: `client-channels-${crypto.randomUUID()}`,
        ...(channels === undefined ? {} : { channels }),
      }),
    ),
  )
}

describe("Firegrid custom channel facade", () => {
  it("agent-coordination-patterns-experiment.BOARD.4 sends, waits, races, and calls registered app channels through the client", async () => {
    const effect = Effect.gen(function*() {
      const primaryQueue = yield* Queue.unbounded<BoardRow>()
      const secondaryQueue = yield* Queue.unbounded<BoardRow>()
      const primaryChannel = makeBidirectionalChannel({
        target: "test.board.primary",
        schema: BoardRowSchema,
        sourceClasses: ["static-source", "predicate-eligible"],
        stream: Stream.fromQueue(primaryQueue),
        append: row => Queue.offer(primaryQueue, row).pipe(Effect.asVoid),
      })
      const secondaryChannel = makeBidirectionalChannel({
        target: "test.board.secondary",
        schema: BoardRowSchema,
        sourceClasses: ["static-source", "predicate-eligible"],
        stream: Stream.fromQueue(secondaryQueue),
        append: row => Queue.offer(secondaryQueue, row).pipe(Effect.asVoid),
      })
      const echoChannel = makeCallableChannel({
        target: "test.echo",
        requestSchema: EchoRequestSchema,
        responseSchema: EchoResponseSchema,
        call: request => Effect.succeed({ echoed: request.value }),
      })

      return yield* Effect.gen(function*() {
        const firegrid = yield* Firegrid

        expect(firegrid.channels.metadata.map(route => route.target)).toEqual([
          "test.board.primary",
          "test.board.secondary",
          "test.echo",
        ])

        yield* firegrid.channels.send("test.board.primary", {
          id: "row-1",
          group: "alpha",
          kind: "finding",
          nested: { status: "done" },
        })
        const matched = yield* firegrid.channels.waitFor("test.board.primary", {
          match: { group: "alpha", "nested.status": "done" },
          timeoutMs: 1_000,
        })
        expect(matched).toEqual({
          matched: true,
          event: {
            id: "row-1",
            group: "alpha",
            kind: "finding",
            nested: { status: "done" },
          },
        })

        const anyFiber = yield* firegrid.channels.waitForAny(
          [
            {
              target: "test.board.primary",
              match: { kind: "final" },
            },
            {
              target: "test.board.secondary",
              match: { kind: "final" },
            },
          ],
          { timeoutMs: 1_000 },
        ).pipe(Effect.fork)
        yield* firegrid.channels.send("test.board.secondary", {
          id: "row-2",
          group: "beta",
          kind: "final",
          nested: { status: "accepted" },
        })
        const any = yield* Fiber.join(anyFiber)
        expect(any).toEqual({
          matched: true,
          winnerIndex: 1,
          target: "test.board.secondary",
          event: {
            id: "row-2",
            group: "beta",
            kind: "final",
            nested: { status: "accepted" },
          },
        })

        const echoed = yield* firegrid.channels.call("test.echo", {
          value: "hello",
        })
        expect(echoed).toEqual({ echoed: "hello" })
      }).pipe(
        Effect.provide(
          configuredClientLayer([
            primaryChannel,
            secondaryChannel,
            echoChannel,
          ]),
        ),
      )
    })

    await Effect.runPromise(Effect.scoped(effect))
  })
})
