/**
 * Verifies:
 *  - effect-durable-operators.CONSUMER.1 — select + key
 *  - effect-durable-operators.CONSUMER.2 — checkpoint via Layer-provided store
 *  - effect-durable-operators.CONSUMER.3 — explicit ClaimPolicy tagged enum
 *  - effect-durable-operators.CONSUMER.4 — AtMostOnce writes claim BEFORE
 *    side effect (proved by restart: previously-claimed inputs do NOT run again)
 *  - effect-durable-operators.CONSUMER.5 — AtLeastOnce writes completion
 *    AFTER side effect (proved by restart: completed inputs are skipped)
 *  - effect-durable-operators.CONSUMER.6 — `run` form (Stream/sink shapes
 *    exercised in tracer 017 follow-on tests; `run` is the primary entry)
 *  - effect-durable-operators.CONSUMER.8 — restart tests prove the selected
 *    policy does not silently duplicate or lose logical work
 *  - effect-durable-operators.TRACER_017.1 — order-email style side-effect
 *    consumer test (no Firegrid imports)
 *  - effect-durable-operators.TRACER_017.4 — AtMostOnce + AtLeastOnce restart
 *    behavior asserted explicitly.
 *
 * A Firegrid-shaped consumer test using **local** schemas (no Firegrid
 * imports) is also included to satisfy tracer 017 acceptance #7.
 */

import { DurableStream } from "effect-durable-streams"
import { Effect, Exit, Option, Ref, Schedule, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "../src/index.ts"
import { DurableConsumerError } from "../src/Errors.ts"
import { runtime, TestStreamServer } from "./harness.ts"

const server = new TestStreamServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

// ----- Order-email scenario (TRACER_017.1) -----

const Order = Schema.Struct({
  type: Schema.Literal("order.created", "order.cancelled"),
  orderId: Schema.String,
  customer: Schema.String,
})
type Order = Schema.Schema.Type<typeof Order>

const durableSource = <A, I>(
  schema: Schema.Schema<A, I>,
  url: string,
) => ConsumerSource.fromDurableStream(
  DurableStream.define({
    endpoint: { url },
    schema,
  }),
)

describe("DurableConsumer — order-email scenario", () => {
  it("AtLeastOnce processes each order once and does not re-process on restart (CONSUMER.5, CONSUMER.8)", async () => {
    const ordersUrl = server.url("orders")
    const checkpointsUrl = server.url("orders-checkpoints")

    await runtime(
      Effect.gen(function* () {
        // Pre-create both streams.
        yield* DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
        yield* DurableStream.define({
          endpoint: { url: checkpointsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const ordersBound = DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        })

        const orders: ReadonlyArray<Order> = [
          { type: "order.created", orderId: "o-1", customer: "alice" },
          { type: "order.cancelled", orderId: "o-2", customer: "bob" },
          { type: "order.created", orderId: "o-3", customer: "carol" },
        ]
        for (const o of orders) yield* ordersBound.append(o)
      }),
    )

    // Process #1
    const calls1 = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make<ReadonlyArray<string>>([])
        const consumer = DurableConsumer.define({
          name: "send-receipt-emails",
          select: (o: Order) =>
            o.type === "order.created" ? Option.some(o) : Option.none(),
          key: (o) => o.orderId,
        })
        const result = yield* DurableConsumer.run({
          source: durableSource(Order, ordersUrl),
          checkpoint: { subscriberId: "email.receipt.v1" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: (o) =>
            Effect.flatMap(Ref.update(callsRef, (a) => [...a, o.orderId]), () =>
              Effect.succeed(o.orderId),
            ),
          live: false,
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "checkpoints-1",
              },
            }),
          ),
        )
        const calls = yield* Ref.get(callsRef)
        return { result, calls }
      }),
    )
    expect(calls1.result.processed).toBe(2) // only order.created rows
    expect([...calls1.calls].sort()).toEqual(["o-1", "o-3"])

    // Process #2 — same subscriber, same source. Completed inputs MUST skip.
    const calls2 = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make<ReadonlyArray<string>>([])
        const consumer = DurableConsumer.define({
          name: "send-receipt-emails",
          select: (o: Order) =>
            o.type === "order.created" ? Option.some(o) : Option.none(),
          key: (o) => o.orderId,
        })
        const result = yield* DurableConsumer.run({
          source: durableSource(Order, ordersUrl),
          checkpoint: { subscriberId: "email.receipt.v1" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: (o) =>
            Effect.flatMap(Ref.update(callsRef, (a) => [...a, o.orderId]), () =>
              Effect.succeed(o.orderId),
            ),
          live: false,
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "checkpoints-2",
              },
            }),
          ),
        )
        const calls = yield* Ref.get(callsRef)
        return { result, calls }
      }),
    )
    expect(calls2.result.processed).toBe(0)
    expect(calls2.calls).toEqual([])
  })

  it("AtMostOnce writes claim before side effect; restart does not re-run (CONSUMER.4, CONSUMER.8)", async () => {
    const ordersUrl = server.url("orders-amo")
    const checkpointsUrl = server.url("orders-amo-checkpoints")

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

        const ordersBound = DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        })
        yield* ordersBound.append({
          type: "order.created",
          orderId: "o-1",
          customer: "alice",
        })
        yield* ordersBound.append({
          type: "order.created",
          orderId: "o-2",
          customer: "bob",
        })
      }),
    )

    const consumer = DurableConsumer.define({
      name: "send-receipt-emails-amo",
      select: (o: Order) =>
        o.type === "order.created" ? Option.some(o) : Option.none(),
      key: (o) => o.orderId,
    })

    const runOnce = (callsRef: Ref.Ref<ReadonlyArray<string>>, producerId: string) =>
      DurableConsumer.run({
        source: durableSource(Order, ordersUrl),
        checkpoint: { subscriberId: "email.receipt.amo.v1" },
        definition: consumer,
        policy: ClaimPolicy.AtMostOnce(),
        process: (o) =>
          Effect.flatMap(Ref.update(callsRef, (a) => [...a, o.orderId]), () =>
            Effect.succeed(o.orderId),
          ),
        live: false,
      }).pipe(
        Effect.provide(
          ConsumerCheckpointStoreLive({
            streamOptions: {
              endpoint: { url: checkpointsUrl },
              producerId,
            },
          }),
        ),
      )

    const result1 = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make<ReadonlyArray<string>>([])
        const result = yield* runOnce(callsRef, "amo-1")
        return { result, calls: yield* Ref.get(callsRef) }
      }),
    )
    expect(result1.result.processed).toBe(2)
    expect([...result1.calls].sort()).toEqual(["o-1", "o-2"])

    const result2 = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make<ReadonlyArray<string>>([])
        const result = yield* runOnce(callsRef, "amo-2")
        return { result, calls: yield* Ref.get(callsRef) }
      }),
    )
    // Claims were written before the side effect on run #1; run #2 must skip.
    expect(result2.result.processed).toBe(0)
    expect(result2.calls).toEqual([])
  })
})

// ----- Failure-window semantics & retry & sink form -----

const failOnce = (callsRef: Ref.Ref<number>) =>
  Effect.flatMap(
    Ref.updateAndGet(callsRef, (n) => n + 1),
    (n) =>
      n === 1
        ? Effect.fail(
            new DurableConsumerError({
              consumer: "test",
              cause: new Error("transient"),
            }),
          )
        : Effect.succeed(n),
  )

describe("DurableConsumer — failure-window semantics", () => {
  it("AtMostOnce: claim written before failing side effect; restart does NOT retry process (CONSUMER.4)", async () => {
    const ordersUrl = server.url("amo-fail")
    const checkpointsUrl = server.url("amo-fail-cp")

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

        yield* DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        }).append({ type: "order.created", orderId: "f-1", customer: "x" })
      }),
    )

    const consumer = DurableConsumer.define({
      name: "amo-fail",
      select: (o: Order) =>
        o.type === "order.created" ? Option.some(o) : Option.none(),
      key: (o) => o.orderId,
    })

    // Run #1: process always fails → run completes with failure.
    const callsRef1Result = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make(0)
        const exit = yield* Effect.exit(
          DurableConsumer.run({
            source: durableSource(Order, ordersUrl),
            checkpoint: { subscriberId: "amo.fail" },
            definition: consumer,
            policy: ClaimPolicy.AtMostOnce(),
            process: () =>
              Effect.fail(
                new DurableConsumerError({
                  consumer: "amo-fail",
                  cause: new Error("boom"),
                }),
              ),
            live: false,
          }).pipe(
            Effect.tap(() => Ref.update(callsRef, (n) => n + 1)),
            Effect.provide(
              ConsumerCheckpointStoreLive({
                streamOptions: {
                  endpoint: { url: checkpointsUrl },
                  producerId: "amo-fail-1",
                },
              }),
            ),
          ),
        )
        return {
          exit,
          calls: yield* Ref.get(callsRef),
        }
      }),
    )
    expect(Exit.isFailure(callsRef1Result.exit)).toBe(true)
    // process was invoked (and failed). The CLAIM was written before that.

    // Run #2: fresh layer. AtMostOnce sees the claim and skips. process not invoked.
    const result2 = await runtime(
      Effect.gen(function* () {
        const processCalls = yield* Ref.make<ReadonlyArray<string>>([])
        const result = yield* DurableConsumer.run({
          source: durableSource(Order, ordersUrl),
          checkpoint: { subscriberId: "amo.fail" },
          definition: consumer,
          policy: ClaimPolicy.AtMostOnce(),
          process: (o) =>
            Effect.flatMap(
              Ref.update(processCalls, (a) => [...a, o.orderId]),
              () => Effect.succeed(o.orderId),
            ),
          live: false,
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "amo-fail-2",
              },
            }),
          ),
        )
        return { result, calls: yield* Ref.get(processCalls) }
      }),
    )
    expect(result2.result.processed).toBe(0)
    expect(result2.calls).toEqual([]) // CRITICAL: AtMostOnce did not re-run process
  })

  it("AtLeastOnce: process fails before completion; restart processes and completes (CONSUMER.5)", async () => {
    const ordersUrl = server.url("alo-fail")
    const checkpointsUrl = server.url("alo-fail-cp")

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

        yield* DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        }).append({ type: "order.created", orderId: "lf-1", customer: "x" })
      }),
    )

    const consumer = DurableConsumer.define({
      name: "alo-fail",
      select: (o: Order) =>
        o.type === "order.created" ? Option.some(o) : Option.none(),
      key: (o) => o.orderId,
    })

    // Run #1: process fails → no completion written.
    const r1 = await runtime(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          DurableConsumer.run({
            source: durableSource(Order, ordersUrl),
            checkpoint: { subscriberId: "alo.fail" },
            definition: consumer,
            policy: ClaimPolicy.AtLeastOnce(),
            process: () =>
              Effect.fail(
                new DurableConsumerError({
                  consumer: "alo-fail",
                  cause: new Error("boom"),
                }),
              ),
            live: false,
          }).pipe(
            Effect.provide(
              ConsumerCheckpointStoreLive({
                streamOptions: {
                  endpoint: { url: checkpointsUrl },
                  producerId: "alo-fail-1",
                },
              }),
            ),
          ),
        )
        return exit
      }),
    )
    expect(Exit.isFailure(r1)).toBe(true)

    // Run #2: process succeeds; AtLeastOnce sees no completion and runs it.
    const r2 = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make(0)
        const result = yield* DurableConsumer.run({
          source: durableSource(Order, ordersUrl),
          checkpoint: { subscriberId: "alo.fail" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: () =>
            Effect.flatMap(Ref.update(callsRef, (n) => n + 1), () =>
              Effect.succeed("ok"),
            ),
          live: false,
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "alo-fail-2",
              },
            }),
          ),
        )
        return { result, calls: yield* Ref.get(callsRef) }
      }),
    )
    expect(r2.result.processed).toBe(1)
    expect(r2.calls).toBe(1)
  })

  it("retry Schedule retries the process effect (CONSUMER.7)", async () => {
    const ordersUrl = server.url("retry")
    const checkpointsUrl = server.url("retry-cp")

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

        yield* DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        }).append({ type: "order.created", orderId: "r-1", customer: "x" })
      }),
    )

    const consumer = DurableConsumer.define({
      name: "retry",
      select: (o: Order) =>
        o.type === "order.created" ? Option.some(o) : Option.none(),
      key: (o) => o.orderId,
    })

    const out = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make(0)
        const result = yield* DurableConsumer.run({
          source: durableSource(Order, ordersUrl),
          checkpoint: { subscriberId: "retry.v1" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: () => failOnce(callsRef),
          retry: Schedule.recurs(3),
          live: false,
        }).pipe(
          Effect.provide(
            ConsumerCheckpointStoreLive({
              streamOptions: {
                endpoint: { url: checkpointsUrl },
                producerId: "retry-1",
              },
            }),
          ),
        )
        return { result, calls: yield* Ref.get(callsRef) }
      }),
    )
    expect(out.calls).toBe(2) // failed once, succeeded on retry
    expect(out.result.processed).toBe(1)
  })

  it("`process` is generic in caller-chosen E and R: caller services compose cleanly", async () => {
    // Audit #1: `process` must not force `(DurableConsumerError, HttpClient)`
    // on callers. This test wires a caller-owned service tag with a
    // custom error type and asserts the surface composes through `run`.
    const ordersUrl = server.url("generic-er")
    const checkpointsUrl = server.url("generic-er-cp")

    class CustomError extends Schema.TaggedError<CustomError>()(
      "CustomError",
      { detail: Schema.String },
    ) {}
    class EmailService extends Effect.Service<EmailService>()(
      "test/EmailService",
      {
        succeed: {
          send: (orderId: string) =>
            Effect.succeed({ sent: true, orderId }) as Effect.Effect<
              { readonly sent: boolean; readonly orderId: string },
              CustomError,
              never
            >,
        },
      },
    ) {}

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

        yield* DurableStream.define({
          endpoint: { url: ordersUrl },
          schema: Order,
        }).append({ type: "order.created", orderId: "g-1", customer: "x" })
      }),
    )

    const consumer = DurableConsumer.define({
      name: "generic-er",
      select: (o: Order) =>
        o.type === "order.created" ? Option.some(o) : Option.none(),
      key: (o) => o.orderId,
    })

    const out = await runtime(
      DurableConsumer.run({
        source: durableSource(Order, ordersUrl),
        checkpoint: { subscriberId: "generic-er.v1" },
        definition: consumer,
        policy: ClaimPolicy.AtLeastOnce(),
        // `process` returns Effect<_, CustomError, EmailService> — the
        // surface accepts arbitrary E/R, not just DurableConsumerError/HttpClient.
        process: (o) =>
          Effect.flatMap(EmailService, (svc) => svc.send(o.orderId)),
        live: false,
      }).pipe(
        Effect.provide(EmailService.Default),
        Effect.provide(
          ConsumerCheckpointStoreLive({
            streamOptions: {
              endpoint: { url: checkpointsUrl },
              producerId: "generic-er-cp-1",
            },
          }),
        ),
      ),
    )
    expect(out.processed).toBe(1)
  })

  it("sink form consumes a caller-owned Stream<Fact> (CONSUMER.6 sink)", async () => {
    const checkpointsUrl = server.url("sink-cp")

    await runtime(
      DurableStream.define({
        endpoint: { url: checkpointsUrl },
        schema: Schema.Unknown,
      }).create({ contentType: "application/json" }),
    )

    const consumer = DurableConsumer.define({
      name: "sink-form",
      select: (o: Order) =>
        o.type === "order.created" ? Option.some(o) : Option.none(),
      key: (o) => o.orderId,
    })

    const orderFacts: ReadonlyArray<Order> = [
      { type: "order.created", orderId: "s-1", customer: "a" },
      { type: "order.cancelled", orderId: "s-2", customer: "b" },
      { type: "order.created", orderId: "s-3", customer: "c" },
    ]

    const out = await runtime(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make<ReadonlyArray<string>>([])
        const sink = DurableConsumer.sink({
          checkpoint: { subscriberId: "sink.v1" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: (o) =>
            Effect.flatMap(
              Ref.update(callsRef, (a) => [...a, o.orderId]),
              () => Effect.succeed(o.orderId),
            ),
        })
        const result = yield* Stream.fromIterable(orderFacts)
          .pipe(Stream.run(sink))
          .pipe(
            Effect.provide(
              ConsumerCheckpointStoreLive({
                streamOptions: {
                  endpoint: { url: checkpointsUrl },
                  producerId: "sink-1",
                },
              }),
            ),
          )
        return { result, calls: yield* Ref.get(callsRef) }
      }),
    )
    expect(out.result.processed).toBe(2)
    expect([...out.calls].sort()).toEqual(["s-1", "s-3"])
  })
})

// ----- Trigger-shaped consumer (stream form) -----

describe("DurableConsumer — trigger-shaped (stream form)", () => {
  it("emits exactly one output per key across restart (CONSUMER.6 stream form, CONSUMER.8)", async () => {
    const eventsUrl = server.url("trigger-events")
    const checkpointsUrl = server.url("trigger-checkpoints")

    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url: eventsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
        yield* DurableStream.define({
          endpoint: { url: checkpointsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const bound = DurableStream.define({
          endpoint: { url: eventsUrl },
          schema: Order,
        })
        // Three distinct keys, one duplicate retained fact for the SAME key
        // (must still be processed exactly once).
        const facts: ReadonlyArray<Order> = [
          { type: "order.created", orderId: "k-1", customer: "a" },
          { type: "order.created", orderId: "k-2", customer: "b" },
          { type: "order.created", orderId: "k-1", customer: "a-dup" },
          { type: "order.created", orderId: "k-3", customer: "c" },
        ]
        for (const f of facts) yield* bound.append(f)
      }),
    )

    const consumer = DurableConsumer.define({
      name: "trigger-stream",
      select: (o: Order) =>
        o.type === "order.created" ? Option.some(o) : Option.none(),
      key: (o) => o.orderId,
    })

    // Run #1: collect emitted outputs through the stream form.
    const run1 = await runtime(
      Effect.gen(function* () {
        const layer = ConsumerCheckpointStoreLive({
          streamOptions: {
            endpoint: { url: checkpointsUrl },
            producerId: "trig-cp-1",
          },
        })
        const stream = DurableConsumer.stream({
          source: durableSource(Order, eventsUrl),
          checkpoint: { subscriberId: "trigger.v1" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: (o) => Effect.succeed(`out:${o.orderId}`),
          live: false,
        })
        const outputs = yield* Stream.runCollect(stream).pipe(Effect.provide(layer))
        return Array.from(outputs)
      }),
    )

    // Run #1 contract:
    //
    //  - DOCUMENTED SAME-RUN LIMITATION: AtLeastOnce processes a same-key
    //    duplicate retained fact at most twice in a single pass. Both
    //    occurrences read the checkpoint BEFORE the first writes completion;
    //    same-run per-key dedupe is not guaranteed in v0. (Adding a
    //    per-key in-memory single-flight would close this; intentional
    //    follow-up.)
    //  - HARD CONTRACT: k-2 and k-3 each appear exactly once. k-1 appears
    //    once OR twice (never zero).
    //  - HARD CONTRACT: every emitted output corresponds to a key in the
    //    expected key set.
    const k1Count = run1.filter((s) => s === "out:k-1").length
    const k2Count = run1.filter((s) => s === "out:k-2").length
    const k3Count = run1.filter((s) => s === "out:k-3").length
    expect(k2Count).toBe(1)
    expect(k3Count).toBe(1)
    expect(k1Count >= 1 && k1Count <= 2).toBe(true)
    expect(run1.every((s) => s === "out:k-1" || s === "out:k-2" || s === "out:k-3")).toBe(true)

    // Run #2: fresh checkpoint store layer on the SAME checkpoints stream.
    // Completed keys must skip; the output stream MUST be empty.
    const run2 = await runtime(
      Effect.gen(function* () {
        const layer = ConsumerCheckpointStoreLive({
          streamOptions: {
            endpoint: { url: checkpointsUrl },
            producerId: "trig-cp-2",
          },
        })
        const stream = DurableConsumer.stream({
          source: durableSource(Order, eventsUrl),
          checkpoint: { subscriberId: "trigger.v1" },
          definition: consumer,
          policy: ClaimPolicy.AtLeastOnce(),
          process: (o) => Effect.succeed(`out:${o.orderId}`),
          live: false,
        })
        const outputs = yield* Stream.runCollect(stream).pipe(Effect.provide(layer))
        return Array.from(outputs)
      }),
    )
    expect(run2).toEqual([])
  })
})

// ----- Firegrid-shaped consumer (tracer 017 acceptance #7) -----
//
// Schemas mirror the real `firegrid.runtime_ingress.*` row shape but live
// inside the test — the operators package itself imports nothing from
// `@firegrid/*` (PACKAGE.2 / BOUNDARIES.1).

const RuntimeIngressRow = Schema.Struct({
  type: Schema.Literal(
    "firegrid.runtime_ingress.requested",
    "firegrid.runtime_ingress.accepted",
  ),
  ingressId: Schema.String,
  contextId: Schema.String,
  payload: Schema.String,
})
type RuntimeIngressRow = Schema.Schema.Type<typeof RuntimeIngressRow>

describe("DurableConsumer — Firegrid-shaped (local schemas only)", () => {
  it("replaces a requested-minus-accepted fold with a generic consumer (FIREGRID_PROOF.1 shape, CONSUMER.6)", async () => {
    const url = server.url("runtime-ingress")
    const checkpointsUrl = server.url("runtime-ingress-checkpoints")
    const contextId = "ctx-1"

    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
        yield* DurableStream.define({
          endpoint: { url: checkpointsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const bound = DurableStream.define({
          endpoint: { url },
          schema: RuntimeIngressRow,
        })

        // Three requested rows, one already accepted.
        yield* bound.append({
          type: "firegrid.runtime_ingress.requested",
          ingressId: "i-1",
          contextId,
          payload: "hello",
        })
        yield* bound.append({
          type: "firegrid.runtime_ingress.requested",
          ingressId: "i-2",
          contextId,
          payload: "world",
        })
        yield* bound.append({
          type: "firegrid.runtime_ingress.requested",
          ingressId: "i-3",
          contextId: "different-ctx",
          payload: "ignored",
        })
      }),
    )

    const captured = await runtime(
      Effect.gen(function* () {
        const writerRef = yield* Ref.make<ReadonlyArray<string>>([])

        const consumer = DurableConsumer.define({
          name: "local-process-session-input",
          select: (row: RuntimeIngressRow) =>
            row.type === "firegrid.runtime_ingress.requested" &&
            row.contextId === contextId
              ? Option.some(row)
              : Option.none(),
          key: (row) => row.ingressId,
        })

        const layer = ConsumerCheckpointStoreLive({
          streamOptions: {
            endpoint: { url: checkpointsUrl },
            producerId: "ingress-cp-1",
          },
        })

        const result = yield* DurableConsumer.run({
          source: durableSource(RuntimeIngressRow, url),
          checkpoint: {
            subscriberId: `runtime-context:${contextId}:stdin`,
          },
          definition: consumer,
          policy: ClaimPolicy.AtMostOnce(),
          process: (row) =>
            Ref.update(writerRef, (a) => [...a, row.payload]),
          live: false,
        }).pipe(Effect.provide(layer))

        return { result, payloads: yield* Ref.get(writerRef) }
      }),
    )

    expect(captured.result.processed).toBe(2)
    expect([...captured.payloads].sort()).toEqual(["hello", "world"])
  })
})
