/**
 * Package-level tests for the two convenience helpers:
 *   - DurableConsumer.forEach (CONSUMER.9)
 *   - ConsumerSource.findFirst (SOURCE.6)
 *   - ConsumerSource.fromDurableStream cursor option (SOURCE.7)
 *
 * Neutral examples; no Firegrid imports.
 */

import { DurableStream } from "effect-durable-streams"
import { Effect, Option, Ref, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "../src/index.ts"
import { runtime, TestStreamServer } from "./harness.ts"

const server = new TestStreamServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const Item = Schema.Struct({
  sequence: Schema.Number,
  text: Schema.String,
})
type Item = Schema.Schema.Type<typeof Item>

const seed = (url: string, items: ReadonlyArray<Item>) =>
  Effect.gen(function* () {
    yield* DurableStream.define({
      endpoint: { url },
      schema: Schema.Unknown,
    }).create({ contentType: "application/json" })
    const bound = DurableStream.define({ endpoint: { url }, schema: Item })
    const offsets: Array<string> = []
    for (const it of items) {
      const { offset } = yield* bound.append(it)
      offsets.push(offset)
    }
    return offsets
  })

describe("ConsumerSource.findFirst", () => {
  it("returns Some on the first row the predicate maps to Some, snapshot-only by default", async () => {
    const url = server.url("findfirst-some")
    const observed = await runtime(
      Effect.gen(function* () {
        yield* seed(url, [
          { sequence: 0, text: "alpha" },
          { sequence: 1, text: "beta" },
          { sequence: 2, text: "gamma" },
        ])
        const source = ConsumerSource.fromDurableStream(
          DurableStream.define({ endpoint: { url }, schema: Item }),
        )
        return yield* ConsumerSource.findFirst(source, (row) =>
          row.text === "beta" ? Option.some(row.sequence) : Option.none(),
        )
      }),
    )
    expect(Option.getOrNull(observed)).toBe(1)
  })

  it("returns None when the snapshot closes without producing a matching row", async () => {
    const url = server.url("findfirst-none")
    const observed = await runtime(
      Effect.gen(function* () {
        yield* seed(url, [
          { sequence: 0, text: "alpha" },
          { sequence: 1, text: "beta" },
        ])
        const source = ConsumerSource.fromDurableStream(
          DurableStream.define({ endpoint: { url }, schema: Item }),
        )
        return yield* ConsumerSource.findFirst(source, (row) =>
          row.text === "never" ? Option.some(row.sequence) : Option.none(),
        )
      }),
    )
    expect(Option.isNone(observed)).toBe(true)
  })

  it("fromDurableStream({ cursor }) skips rows at/before the cursor (SOURCE.7)", async () => {
    const url = server.url("findfirst-cursor")
    const offsets = await runtime(seed(url, [
      { sequence: 0, text: "before" },
      { sequence: 1, text: "after-a" },
      { sequence: 2, text: "after-b" },
    ]))
    const cursor = offsets[0]
    if (cursor === undefined) throw new Error("expected an offset")

    const observed = await runtime(
      Effect.gen(function* () {
        const cursored = ConsumerSource.fromDurableStream(
          DurableStream.define({ endpoint: { url }, schema: Item }),
          { cursor },
        )
        const noBefore = yield* ConsumerSource.findFirst(cursored, (row) =>
          row.text === "before" ? Option.some(row.sequence) : Option.none(),
        )
        const afterA = yield* ConsumerSource.findFirst(cursored, (row) =>
          row.text === "after-a" ? Option.some(row.sequence) : Option.none(),
        )
        return { noBefore, afterA }
      }),
    )
    expect(Option.isNone(observed.noBefore)).toBe(true)
    expect(Option.getOrNull(observed.afterA)).toBe(1)
  })
})

describe("DurableConsumer.forEach", () => {
  it("processes each selected input once with default AtMostOnce policy (CONSUMER.9)", async () => {
    const itemsUrl = server.url("foreach-items")
    const checkpointsUrl = server.url("foreach-checkpoints")

    const items: ReadonlyArray<Item> = [
      { sequence: 0, text: "skip" },
      { sequence: 1, text: "keep" },
      { sequence: 2, text: "keep" },
    ]
    await runtime(
      Effect.gen(function* () {
        yield* seed(itemsUrl, items)
        yield* DurableStream.define({
          endpoint: { url: checkpointsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
      }),
    )

    const calls1 = await runtime(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<number>>([])
        const result = yield* DurableConsumer.forEach({
          name: "foreach-keep",
          source: ConsumerSource.fromDurableStream(
            DurableStream.define({ endpoint: { url: itemsUrl }, schema: Item }),
          ),
          checkpoint: { subscriberId: "foreach-v1" },
          select: (it: Item) =>
            it.text === "keep" ? Option.some(it) : Option.none(),
          key: (it: Item) => `${it.sequence}`,
          live: false,
          process: (it: Item) =>
            Ref.update(seen, (arr) => [...arr, it.sequence]),
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "foreach-cp-1",
              },
            }),
          ),
        )
        return { result, seen: yield* Ref.get(seen) }
      }),
    )
    expect(calls1.result.processed).toBe(2)
    expect([...calls1.seen].sort()).toEqual([1, 2])

    // Same subscriber, same source. AtMostOnce default means
    // previously-claimed keys do not re-process.
    const calls2 = await runtime(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<number>>([])
        const result = yield* DurableConsumer.forEach({
          name: "foreach-keep",
          source: ConsumerSource.fromDurableStream(
            DurableStream.define({ endpoint: { url: itemsUrl }, schema: Item }),
          ),
          checkpoint: { subscriberId: "foreach-v1" },
          select: (it: Item) =>
            it.text === "keep" ? Option.some(it) : Option.none(),
          key: (it: Item) => `${it.sequence}`,
          live: false,
          process: (it: Item) =>
            Ref.update(seen, (arr) => [...arr, it.sequence]),
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "foreach-cp-2",
              },
            }),
          ),
        )
        return { result, seen: yield* Ref.get(seen) }
      }),
    )
    expect(calls2.result.processed).toBe(0)
    expect(calls2.seen).toEqual([])
  })

  it("explicit policy override (AtLeastOnce) reaches the process callback", async () => {
    const itemsUrl = server.url("foreach-alo-items")
    const checkpointsUrl = server.url("foreach-alo-checkpoints")
    await runtime(
      Effect.gen(function* () {
        yield* seed(itemsUrl, [{ sequence: 0, text: "x" }])
        yield* DurableStream.define({
          endpoint: { url: checkpointsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
      }),
    )
    const observed = await runtime(
      Effect.gen(function* () {
        const seen = yield* Ref.make(0)
        yield* DurableConsumer.forEach({
          name: "foreach-alo",
          source: ConsumerSource.fromDurableStream(
            DurableStream.define({ endpoint: { url: itemsUrl }, schema: Item }),
          ),
          checkpoint: { subscriberId: "foreach-alo-v1" },
          policy: ClaimPolicy.AtLeastOnce(),
          select: (it: Item) => Option.some(it),
          key: (it: Item) => `${it.sequence}`,
          live: false,
          process: () => Ref.update(seen, (n) => n + 1),
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "foreach-alo-cp",
              },
            }),
          ),
        )
        return yield* Ref.get(seen)
      }),
    )
    expect(observed).toBe(1)
  })
})
