import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import { Cause, Effect, Exit, Schema, type Context } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  CompletionKey,
  DeliveryKey,
  DurableChannel,
  DurableDeliveryConflictError,
  DurableSubscriberId,
  DurableClaimId,
  EventPlane,
  OrderingScope,
  type DurableChannelDefinition,
  type DurableChannelFold,
  type DurableDeliveryRecord,
  type DurableTerminalRecord,
  type PlaneSnapshot,
} from "../event-plane/index.ts"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const DeliveryRow = Schema.Struct({
  rowId: Schema.String,
  channel: Schema.String,
  channelVersion: Schema.String,
  deliveryKey: Schema.String,
  completionKey: Schema.String,
  orderingScope: Schema.String,
  producerId: Schema.String,
  idempotencyKey: Schema.String,
  payloadFingerprint: Schema.String,
  acceptedAtMs: Schema.Number,
  body: Schema.String,
})

const TerminalRow = Schema.Struct({
  rowId: Schema.String,
  channel: Schema.String,
  deliveryKey: Schema.String,
  completionKey: Schema.String,
  kind: Schema.Literal(
    "completed",
    "cancelled",
    "terminal-failure",
    "dead-letter",
  ),
  value: Schema.String,
  recordedAtMs: Schema.Number,
  subscriberId: Schema.optional(Schema.String),
  claimId: Schema.optional(Schema.String),
})

const ClaimRow = Schema.Struct({
  rowId: Schema.String,
  channel: Schema.String,
  deliveryKey: Schema.String,
  orderingScope: Schema.String,
  claimId: Schema.String,
  subscriberId: Schema.String,
  attempt: Schema.Number,
  claimedAtMs: Schema.Number,
})

const RetryRow = Schema.Struct({
  rowId: Schema.String,
  channel: Schema.String,
  deliveryKey: Schema.String,
  claimId: Schema.String,
  attempt: Schema.Number,
  retryAtMs: Schema.Number,
  reason: Schema.String,
})

const ConflictRow = Schema.Struct({
  rowId: Schema.String,
  channel: Schema.String,
  deliveryKey: Schema.String,
  completionKey: Schema.String,
  idempotencyKey: Schema.String,
  reason: Schema.String,
  observedAtMs: Schema.Number,
  existingFingerprint: Schema.String,
  incomingFingerprint: Schema.String,
})

type DeliveryRow = Schema.Schema.Type<typeof DeliveryRow>
type TerminalRow = Schema.Schema.Type<typeof TerminalRow>
type ClaimRow = Schema.Schema.Type<typeof ClaimRow>
type RetryRow = Schema.Schema.Type<typeof RetryRow>
type ConflictRow = Schema.Schema.Type<typeof ConflictRow>

const buildFixture = () => {
  const state = createStateSchema({
    deliveries: {
      type: "test.durable-channel.delivery",
      primaryKey: "rowId",
      schema: Schema.standardSchemaV1(DeliveryRow),
    },
    completions: {
      type: "test.durable-channel.completion",
      primaryKey: "rowId",
      schema: Schema.standardSchemaV1(TerminalRow),
    },
    claims: {
      type: "test.durable-channel.claim",
      primaryKey: "rowId",
      schema: Schema.standardSchemaV1(ClaimRow),
    },
    deadLetters: {
      type: "test.durable-channel.dead-letter",
      primaryKey: "rowId",
      schema: Schema.standardSchemaV1(TerminalRow),
    },
    retries: {
      type: "test.durable-channel.retry",
      primaryKey: "rowId",
      schema: Schema.standardSchemaV1(RetryRow),
    },
    conflicts: {
      type: "test.durable-channel.conflict",
      primaryKey: "rowId",
      schema: Schema.standardSchemaV1(ConflictRow),
    },
  })
  const plane = EventPlane.define({ name: "test.channel", state })

  type DeliveryInput = {
    readonly id: string
    readonly body: string
    readonly scope: string
  }

  const deliveryFromRow = (row: DeliveryRow): DurableDeliveryRecord => ({
    channel: row.channel,
    channelVersion: row.channelVersion,
    deliveryKey: DeliveryKey(row.deliveryKey),
    completionKey: CompletionKey(row.completionKey),
    orderingScope: OrderingScope(row.orderingScope),
    producerId: row.producerId,
    idempotencyKey: row.idempotencyKey,
    payloadFingerprint: row.payloadFingerprint,
    acceptedAtMs: row.acceptedAtMs,
  })

  const terminalFromRow = (row: TerminalRow): DurableTerminalRecord => ({
    channel: row.channel,
    deliveryKey: DeliveryKey(row.deliveryKey),
    completionKey: CompletionKey(row.completionKey),
    kind: row.kind,
    value: row.value,
    recordedAtMs: row.recordedAtMs,
    ...(row.subscriberId !== undefined
      ? { subscriberId: DurableSubscriberId(row.subscriberId) }
      : {}),
    ...(row.claimId !== undefined
      ? { claimId: DurableClaimId(row.claimId) }
      : {}),
  })

  const channel: DurableChannelDefinition<
    "test.channel",
    typeof plane.state,
    DeliveryInput
  > = DurableChannel.define({
    name: "test.channel",
    version: "v1",
    plane,
    dedupe: {
      retentionWindowMs: 86_400_000,
      afterRetentionWindow: "conflict",
    },
    derive: {
      deliveryKey: (input) => DeliveryKey(`delivery:${input.id}`),
      completionKey: (input) => CompletionKey(`completion:${input.id}`),
      orderingScope: (input) => OrderingScope(input.scope),
      payloadFingerprint: (input) => input.body,
    },
    events: {
      delivery: (input, envelope) =>
        plane.state.deliveries.insert({
          value: {
            rowId: envelope.deliveryKey,
            channel: envelope.channel,
            channelVersion: envelope.channelVersion,
            deliveryKey: envelope.deliveryKey,
            completionKey: envelope.completionKey,
            orderingScope: envelope.orderingScope,
            producerId: envelope.producerId,
            idempotencyKey: envelope.idempotencyKey,
            payloadFingerprint: envelope.payloadFingerprint,
            acceptedAtMs: envelope.acceptedAtMs,
            body: input.body,
          },
        }),
      claim: (record) =>
        plane.state.claims.insert({
          value: {
            rowId: record.claimId,
            channel: record.channel,
            deliveryKey: record.deliveryKey,
            orderingScope: record.orderingScope,
            claimId: record.claimId,
            subscriberId: record.subscriberId,
            attempt: record.attempt,
            claimedAtMs: record.claimedAtMs,
          },
        }),
      completion: (record) =>
        plane.state.completions.insert({
          value: {
            rowId: `completion:${record.completionKey}`,
            channel: record.channel,
            deliveryKey: record.deliveryKey,
            completionKey: record.completionKey,
            kind: record.kind,
            value: String(record.value),
            recordedAtMs: record.recordedAtMs,
            ...(record.subscriberId !== undefined
              ? { subscriberId: record.subscriberId }
              : {}),
            ...(record.claimId !== undefined
              ? { claimId: record.claimId }
              : {}),
          },
        }),
      deadLetter: (record) =>
        plane.state.deadLetters.insert({
          value: {
            rowId: `dead-letter:${record.completionKey}`,
            channel: record.channel,
            deliveryKey: record.deliveryKey,
            completionKey: record.completionKey,
            kind: record.kind,
            value: String(record.value),
            recordedAtMs: record.recordedAtMs,
            ...(record.subscriberId !== undefined
              ? { subscriberId: record.subscriberId }
              : {}),
            ...(record.claimId !== undefined
              ? { claimId: record.claimId }
              : {}),
          },
        }),
      retry: (record) =>
        plane.state.retries.insert({
          value: {
            rowId: `retry:${record.deliveryKey}:${record.attempt}`,
            channel: record.channel,
            deliveryKey: record.deliveryKey,
            claimId: record.claimId ?? "",
            attempt: record.attempt,
            retryAtMs: record.retryAtMs,
            reason: String(record.reason),
          },
        }),
      conflict: ({ envelope, existing, reason }) =>
        plane.state.conflicts.insert({
          value: {
            rowId: `conflict:${envelope.idempotencyKey}`,
            channel: envelope.channel,
            deliveryKey: envelope.deliveryKey,
            completionKey: envelope.completionKey,
            idempotencyKey: envelope.idempotencyKey,
            reason,
            observedAtMs: envelope.acceptedAtMs,
            existingFingerprint: existing.payloadFingerprint,
            incomingFingerprint: envelope.payloadFingerprint,
          },
        }),
    },
    select: {
      deliveries: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.deliveries.values()).map((row) =>
          deliveryFromRow(row as DeliveryRow),
        ),
      completions: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.completions.values()).map((row) =>
          terminalFromRow(row as TerminalRow),
        ),
      claims: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.claims.values()).map((row) => {
          const claim = row as ClaimRow
          return {
            channel: claim.channel,
            deliveryKey: DeliveryKey(claim.deliveryKey),
            orderingScope: OrderingScope(claim.orderingScope),
            claimId: DurableClaimId(claim.claimId),
            subscriberId: DurableSubscriberId(claim.subscriberId),
            attempt: claim.attempt,
            claimedAtMs: claim.claimedAtMs,
          }
        }),
      deadLetters: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.deadLetters.values()).map((row) =>
          terminalFromRow(row as TerminalRow),
        ),
      retries: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.retries.values()).map((row) => {
          const retry = row as RetryRow
          return {
            channel: retry.channel,
            deliveryKey: DeliveryKey(retry.deliveryKey),
            claimId: DurableClaimId(retry.claimId),
            attempt: retry.attempt,
            retryAtMs: retry.retryAtMs,
            reason: retry.reason,
          }
        }),
      conflicts: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.conflicts.values()).map((row) => {
          const conflict = row as ConflictRow
          return {
            channel: conflict.channel,
            deliveryKey: DeliveryKey(conflict.deliveryKey),
            completionKey: CompletionKey(conflict.completionKey),
            idempotencyKey: conflict.idempotencyKey,
            reason: conflict.reason,
            observedAtMs: conflict.observedAtMs,
            existingFingerprint: conflict.existingFingerprint,
            incomingFingerprint: conflict.incomingFingerprint,
          }
        }),
    },
  })

  return { plane, channel }
}

const snapshotFold = async (
  url: string,
  fixture: ReturnType<typeof buildFixture>,
): Promise<DurableChannelFold> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.plane.Projection
        return yield* projection.snapshot(
          DurableChannel.foldQuery(fixture.channel),
        )
      }),
    ).pipe(Effect.provide(EventPlane.layer(fixture.plane, { streamUrl: url }))),
  )

describe("firegrid-durable-subscriber-webhooks.CHANNEL_DESCRIPTOR.1, .2, .3, .4, .5", () => {
  it("defines a product-neutral delivery channel descriptor with branded key derivation and caller-owned rows", () => {
    const { channel } = buildFixture()
    const input = { id: "a", body: "payload", scope: "scope-a" }

    expect(channel.name).toBe("test.channel")
    expect(channel.version).toBe("v1")
    expect(channel.derive.deliveryKey(input)).toBe("delivery:a")
    expect(channel.derive.completionKey(input)).toBe("completion:a")
    expect(channel.derive.orderingScope(input)).toBe("scope-a")
    expect(channel.dedupe.afterRetentionWindow).toBe("conflict")
  })
})

describe("firegrid-durable-subscriber-webhooks.DELIVERY_PRODUCER.1, .2, .3, .4, .5", () => {
  it("accepts first append, dedupes same-payload idempotency, and records conflict evidence for different payload", async () => {
    const url = freshStreamUrl("durable-channel-producer")
    await DurableStream.create({ url, contentType: "application/json" })
    const fixture = buildFixture()

    const append = (body: string) =>
      Effect.gen(function* () {
        const producer = yield* fixture.plane.Producer
        const projection = yield* fixture.plane.Projection
        return yield* DurableChannel.appendDelivery(
          fixture.channel,
          { producer, projection },
          {
            input: { id: "a", body, scope: "scope-a" },
            metadata: {
              producerId: "producer-a",
              idempotencyKey: "idem-a",
              correlationId: "corr-a",
              causationId: "cause-a",
            },
          },
        )
      }).pipe(Effect.provide(EventPlane.layer(fixture.plane, { streamUrl: url })))

    const first = await Effect.runPromise(Effect.scoped(append("same")))
    const duplicate = await Effect.runPromise(Effect.scoped(append("same")))
    const conflictExit = await Effect.runPromise(
      Effect.exit(Effect.scoped(append("different"))),
    )

    expect(first.kind).toBe("accepted")
    expect(duplicate.kind).toBe("duplicate")
    expect(Exit.isFailure(conflictExit)).toBe(true)
    if (Exit.isFailure(conflictExit)) {
      const err = Cause.failureOption(conflictExit.cause)
      expect(err._tag).toBe("Some")
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(DurableDeliveryConflictError)
      }
    }

    const fold = await snapshotFold(url, fixture)
    expect(fold.deliveriesByKey.size).toBe(1)
    expect(fold.conflicts).toHaveLength(1)
    expect(fold.conflicts[0]?.reason).toBe("idempotency-payload-conflict")
  })
})

describe("firegrid-durable-subscriber-webhooks.DELIVERY_PROJECTION.1, .2, .3", () => {
  it("folds completion and dead-letter terminals with deterministic first-terminal-wins", async () => {
    const url = freshStreamUrl("durable-channel-fold")
    await DurableStream.create({ url, contentType: "application/json" })
    const fixture = buildFixture()
    const stream = new DurableStream({ url, contentType: "application/json" })
    const delivery = fixture.channel.events.delivery(
      { id: "b", body: "payload", scope: "scope-b" },
      {
        channel: "test.channel",
        channelVersion: "v1",
        deliveryKey: DeliveryKey("delivery:b"),
        completionKey: CompletionKey("completion:b"),
        orderingScope: OrderingScope("scope-b"),
        producerId: "producer-b",
        idempotencyKey: "idem-b",
        payloadFingerprint: "payload",
        acceptedAtMs: 1,
      },
    )
    const completed = fixture.plane.state.completions.insert({
      value: {
        rowId: "terminal:1",
        channel: "test.channel",
        deliveryKey: "delivery:b",
        completionKey: "completion:b",
        kind: "completed",
        value: "ok",
        recordedAtMs: 2,
      },
    })
    const deadLetter = fixture.plane.state.deadLetters.insert({
      value: {
        rowId: "terminal:2",
        channel: "test.channel",
        deliveryKey: "delivery:b",
        completionKey: "completion:b",
        kind: "dead-letter",
        value: "failed",
        recordedAtMs: 3,
      },
    })
    await stream.append(JSON.stringify(delivery))
    await stream.append(JSON.stringify(completed))
    await stream.append(JSON.stringify(deadLetter))

    const first = await snapshotFold(url, fixture)
    const second = await snapshotFold(url, fixture)

    expect(first.terminalByCompletionKey.get(CompletionKey("completion:b"))?.kind)
      .toBe("completed")
    expect(first.pendingDeliveries).toHaveLength(0)
    expect(first.deadLetters).toHaveLength(1)
    expect(first.conflictingTerminals).toHaveLength(1)
    expect(second.terminalByCompletionKey.get(CompletionKey("completion:b"))?.kind)
      .toBe("completed")
    expect(second.conflictingTerminals).toEqual(first.conflictingTerminals)
  })
})

describe("firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.2, .3, .4, .5", () => {
  it("claims a delivery before outcome append and records terminal or retry rows through caller-owned events", async () => {
    const url = freshStreamUrl("durable-channel-claim-outcome")
    await DurableStream.create({ url, contentType: "application/json" })
    const fixture = buildFixture()
    type PlaneRequirements =
      | Context.Tag.Identifier<typeof fixture.plane.Producer>
      | Context.Tag.Identifier<typeof fixture.plane.Projection>

    const runWithPlane = <A, E>(
      effect: Effect.Effect<A, E, PlaneRequirements>,
    ): Promise<A> =>
      Effect.runPromise(
        Effect.scoped(
          effect.pipe(
            Effect.provide(
              EventPlane.layer(fixture.plane, { streamUrl: url }),
            ),
          ),
        ),
      )

    await runWithPlane(
      Effect.gen(function* () {
        const producer = yield* fixture.plane.Producer
        const projection = yield* fixture.plane.Projection
        yield* DurableChannel.appendDelivery(
          fixture.channel,
          { producer, projection },
          {
            input: { id: "claim-1", body: "payload", scope: "scope-claim" },
            metadata: {
              producerId: "producer-claim",
              idempotencyKey: "idem-claim",
            },
          },
        )
      }),
    )

    const claimed = await runWithPlane(
      Effect.gen(function* () {
        const producer = yield* fixture.plane.Producer
        const projection = yield* fixture.plane.Projection
        return yield* DurableChannel.claimDelivery(
          fixture.channel,
          { producer, projection },
          {
            deliveryKey: DeliveryKey("delivery:claim-1"),
            subscriberId: DurableSubscriberId("subscriber-a"),
            claimId: DurableClaimId("claim-a"),
            attempt: 1,
          },
        )
      }),
    )
    expect(claimed.kind).toBe("claimed")

    const retry = await runWithPlane(
      Effect.gen(function* () {
        const producer = yield* fixture.plane.Producer
        const projection = yield* fixture.plane.Projection
        return yield* DurableChannel.recordOutcome(
          fixture.channel,
          { producer, projection },
          {
            kind: "retry",
            deliveryKey: DeliveryKey("delivery:claim-1"),
            subscriberId: DurableSubscriberId("subscriber-a"),
            claimId: DurableClaimId("claim-a"),
            attempt: 1,
            retryAtMs: 123,
            reason: "temporary",
          },
        )
      }),
    )
    expect(retry.kind).toBe("recorded-retry")

    const completed = await runWithPlane(
      Effect.gen(function* () {
        const producer = yield* fixture.plane.Producer
        const projection = yield* fixture.plane.Projection
        return yield* DurableChannel.recordOutcome(
          fixture.channel,
          { producer, projection },
          {
            kind: "completed",
            deliveryKey: DeliveryKey("delivery:claim-1"),
            subscriberId: DurableSubscriberId("subscriber-a"),
            claimId: DurableClaimId("claim-a"),
            value: "done",
          },
        )
      }),
    )
    expect(completed.kind).toBe("recorded-terminal")

    const fold = await snapshotFold(url, fixture)
    expect(fold.claimWinnerByDeliveryKey.get(DeliveryKey("delivery:claim-1"))?.claimId)
      .toBe("claim-a")
    expect(fold.retriesByDeliveryKey.get(DeliveryKey("delivery:claim-1")))
      .toHaveLength(1)
    expect(fold.terminalByDeliveryKey.get(DeliveryKey("delivery:claim-1"))?.kind)
      .toBe("completed")
  })

  it("orders claim eligibility by ordering scope and reports later same-scope deliveries as not claimable", async () => {
    const url = freshStreamUrl("durable-channel-ordering-scope")
    await DurableStream.create({ url, contentType: "application/json" })
    const fixture = buildFixture()

    const append = (id: string) =>
      Effect.gen(function* () {
        const producer = yield* fixture.plane.Producer
        const projection = yield* fixture.plane.Projection
        yield* DurableChannel.appendDelivery(
          fixture.channel,
          { producer, projection },
          {
            input: { id, body: `payload-${id}`, scope: "same-scope" },
            metadata: {
              producerId: "producer-order",
              idempotencyKey: `idem-${id}`,
            },
          },
        )
      }).pipe(
        Effect.provide(EventPlane.layer(fixture.plane, { streamUrl: url })),
        Effect.scoped,
      )

    await Effect.runPromise(append("first"))
    await Effect.runPromise(append("second"))

    const secondClaim = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const producer = yield* fixture.plane.Producer
          const projection = yield* fixture.plane.Projection
          return yield* DurableChannel.claimDelivery(
            fixture.channel,
            { producer, projection },
            {
              deliveryKey: DeliveryKey("delivery:second"),
              subscriberId: DurableSubscriberId("subscriber-order"),
              claimId: DurableClaimId("claim-second"),
              attempt: 1,
            },
          )
        }).pipe(
          Effect.provide(EventPlane.layer(fixture.plane, { streamUrl: url })),
        ),
      ),
    )

    expect(secondClaim.kind).toBe("not-claimable")
    const fold = await snapshotFold(url, fixture)
    expect(fold.claimableDeliveries.map((delivery) => delivery.deliveryKey))
      .toEqual([DeliveryKey("delivery:first")])
  })
})
