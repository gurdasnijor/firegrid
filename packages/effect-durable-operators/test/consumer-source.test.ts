/**
 * Verifies:
 *  - effect-durable-operators.SOURCE.1
 *  - effect-durable-operators.SOURCE.2
 *  - effect-durable-operators.SOURCE.3
 *  - effect-durable-operators.SOURCE.4
 *  - effect-durable-operators.SOURCE.5
 *  - effect-durable-operators.TRACER_018.1
 *  - effect-durable-operators.TRACER_018.2
 *  - effect-durable-operators.TRACER_018.3
 */

import type {
  ChangeMessage,
  Message,
  Offset,
  Row,
  ShapeStreamInterface,
  SubsetParams,
} from "@electric-sql/client"
import { D2, MultiSet } from "@electric-sql/d2ts"
import { outputElectricMessages } from "@electric-sql/d2ts/electric"
import { DurableStream } from "effect-durable-streams"
import { Effect, Option, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "../src/index.ts"
import * as ElectricConsumerSource from "../src/electric.ts"
import { runtime, TestStreamServer } from "./harness.ts"

const server = new TestStreamServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const Order = Schema.Struct({
  type: Schema.Literal("order.created", "order.cancelled"),
  orderId: Schema.String,
  customer: Schema.String,
})
type Order = Schema.Schema.Type<typeof Order>

interface ElectricOrderRow extends Row {
  readonly id: string
  readonly status: "ready" | "ignored"
  readonly customer: string
}

const consumer = DurableConsumer.define({
  name: "consumer-source-orders",
  select: (order: Order) =>
    order.type === "order.created" ? Option.some(order) : Option.none(),
  key: order => order.orderId,
})

const decodeElectricOrder = (
  message: ChangeMessage<ElectricOrderRow>,
): Option.Option<Order> =>
  message.headers.operation === "delete" || message.value.status !== "ready"
    ? Option.none()
    : Option.some({
      type: "order.created",
      orderId: message.value.id,
      customer: message.value.customer,
    })

class ShapeFixture<T extends Row> implements ShapeStreamInterface<T> {
  readonly mode = "full"
  readonly isUpToDate = true
  readonly shapeHandle = "shape-fixture"
  readonly error = undefined

  constructor(
    private readonly messages: ReadonlyArray<ChangeMessage<T>>,
    readonly lastOffset: Offset,
  ) {}

  subscribe(
    callback: (messages: Message<T>[]) => void | Promise<void>,
  ): () => void {
    void callback([...this.messages])
    return () => {}
  }

  unsubscribeAll(): void {}
  isLoading(): boolean { return false }
  lastSyncedAt(): number { return Date.now() }
  lastSynced(): number { return 0 }
  isConnected(): boolean { return false }
  hasStarted(): boolean { return true }
  forceDisconnectAndRefresh(): Promise<void> { return Promise.resolve() }

  requestSnapshot(_params: SubsetParams): Promise<{
    readonly metadata: Awaited<ReturnType<ShapeStreamInterface<T>["requestSnapshot"]>>["metadata"]
    readonly data: Array<Message<T>>
  }> {
    return Promise.resolve({
      metadata: {
        snapshot_mark: 1,
        database_lsn: "1",
        xmin: "1",
        xmax: "2",
        xip_list: [],
      },
      data: [...this.messages],
    })
  }

  fetchSnapshot(_params: SubsetParams): Promise<{
    readonly metadata: Awaited<ReturnType<ShapeStreamInterface<T>["fetchSnapshot"]>>["metadata"]
    readonly data: Array<ChangeMessage<T>>
  }> {
    return Promise.resolve({
      metadata: {
        snapshot_mark: 1,
        database_lsn: "1",
        xmin: "1",
        xmax: "2",
        xip_list: [],
      },
      data: [...this.messages],
    })
  }
}

const d2tsElectricMessages = (
  rows: ReadonlyArray<ElectricOrderRow>,
): ReadonlyArray<ChangeMessage<ElectricOrderRow>> => {
  const graph = new D2({ initialFrontier: 0 })
  const input = graph.newInput<[key: string, value: ElectricOrderRow]>()
  const output: Array<ChangeMessage<Row<ElectricOrderRow>>> = []
  input.pipe(outputElectricMessages((messages) => {
    output.push(...messages)
  }))
  graph.finalize()
  input.sendData(
    1,
    new MultiSet(rows.map(row => [[row.id, row], 1])),
  )
  input.sendFrontier(2)
  graph.run()
  return output.map(message => ({
    key: message.key,
    value: message.value as ElectricOrderRow,
    headers: message.headers,
  }))
}

describe("ConsumerSource", () => {
  it("effect-durable-operators.SOURCE.1 effect-durable-operators.SOURCE.2 effect-durable-operators.TRACER_018.1 runs DurableConsumer through fromDurableStream", async () => {
    const ordersUrl = server.url("source-ds-orders")
    const checkpointsUrl = server.url("source-ds-checkpoints")

    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
        yield* DurableStream.define({
          endpoint: { url: checkpointsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const orders = DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        })
        yield* orders.append({ type: "order.created", orderId: "ds-1", customer: "alice" })
        yield* orders.append({ type: "order.cancelled", orderId: "ds-2", customer: "bob" })
      }),
    )

    const processed = await runtime(
      DurableConsumer.run({
        source: ConsumerSource.fromDurableStream(DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        })),
        checkpoint: { subscriberId: "source-ds.v1" },
        definition: consumer,
        policy: ClaimPolicy.AtLeastOnce(),
        process: () => Effect.void,
        live: false,
      }).pipe(
        Effect.provide(ConsumerCheckpointStoreLive({
          streamOptions: {
            endpoint: { url: checkpointsUrl },
            producerId: "source-ds-cp",
          },
        })),
      ),
    )

    expect(processed.processed).toBe(1)
  })

  it("effect-durable-operators.SOURCE.3 effect-durable-operators.SOURCE.5 effect-durable-operators.TRACER_018.2 consumes Electric/D2TS source facts through the same ConsumerSource API", async () => {
    const checkpointsUrl = server.url("source-electric-checkpoints")
    const messages = d2tsElectricMessages([
      { id: "el-1", status: "ready", customer: "ada" },
      { id: "el-2", status: "ignored", customer: "grace" },
      { id: "el-3", status: "ready", customer: "linus" },
    ])
    const shape = new ShapeFixture(messages, "7_0")

    await runtime(
      DurableStream.define({
        endpoint: { url: checkpointsUrl },
        schema: Schema.Unknown,
      }).create({ contentType: "application/json" }),
    )

    const calls = await runtime(
      Effect.gen(function* () {
        const seen = yield* Effect.sync((): Array<string> => [])
        const result = yield* DurableConsumer.run({
          source: ElectricConsumerSource.fromElectricShapeStream({
            stream: shape,
            decode: decodeElectricOrder,
          }),
          checkpoint: { subscriberId: "source-electric.v1" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: order => Effect.sync(() => {
            seen.push(order.orderId)
          }),
          live: false,
        }).pipe(
          Effect.provide(ConsumerCheckpointStoreLive({
            streamOptions: {
              endpoint: { url: checkpointsUrl },
              producerId: "source-electric-cp",
            },
          })),
        )
        return { result, seen }
      }),
    )

    expect(calls.result.processed).toBe(2)
    expect(calls.seen).toEqual(["el-1", "el-3"])
  })

  it("effect-durable-operators.SOURCE.4 effect-durable-operators.TRACER_018.3 replays Electric-shaped source without treating source offsets as processing checkpoints", async () => {
    const checkpointsUrl = server.url("source-electric-separation-checkpoints")
    const messages = d2tsElectricMessages([
      { id: "sep-1", status: "ready", customer: "ada" },
      { id: "sep-2", status: "ready", customer: "grace" },
    ])

    await runtime(
      DurableStream.define({
        endpoint: { url: checkpointsUrl },
        schema: Schema.Unknown,
      }).create({ contentType: "application/json" }),
    )

    const runOnce = (offset: Offset) =>
      DurableConsumer.run({
        source: ElectricConsumerSource.fromElectricShapeStream({
          stream: new ShapeFixture(messages, offset),
          decode: decodeElectricOrder,
        }),
        checkpoint: { subscriberId: "source-electric-separation.v1" },
        definition: consumer,
        policy: ClaimPolicy.AtLeastOnce(),
        process: () => Effect.void,
        live: false,
      }).pipe(
        Effect.provide(ConsumerCheckpointStoreLive({
          streamOptions: {
            endpoint: { url: checkpointsUrl },
            producerId: `source-electric-separation-cp:${offset}`,
          },
        })),
      )

    const first = await runtime(runOnce("10_0"))
    const second = await runtime(runOnce("999_0"))

    expect(first.processed).toBe(2)
    expect(second.processed).toBe(0)
  })

  it("effect-durable-operators.SOURCE.5 adapts D2TS-emitted Electric change messages without owning checkpoints", async () => {
    const messages = d2tsElectricMessages([
      { id: "d2ts-1", status: "ready", customer: "ada" },
      { id: "d2ts-2", status: "ready", customer: "grace" },
    ])

    const rows = await Effect.runPromise(
      ElectricConsumerSource.fromElectricChangeMessages({
        messages: Stream.fromIterable(messages),
        decode: decodeElectricOrder,
      }).read({ live: false }).pipe(Stream.runCollect),
    )

    expect(Array.from(rows).map(row => row.orderId)).toEqual(["d2ts-1", "d2ts-2"])
  })
})
