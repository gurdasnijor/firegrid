import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import { Effect, Schema } from "effect"
import {
  CompletionKey,
  DeliveryKey,
  DurableChannel,
  EventPlane,
  OrderingScope,
  type DurableChannelDefinition,
  type DurableChannelFold,
  type DurableDeliveryEnvelope,
  type DurableDeliveryRecord,
  type DurableTerminalRecord,
  type PlaneSnapshot,
} from "../event-plane/index.ts"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

const { afterAll, beforeAll, describe, expect, it } = await import("vitest")
const run = Effect.runPromise

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
})

const ConflictRow = Schema.Struct({
  rowId: Schema.String,
  channel: Schema.String,
  deliveryKey: Schema.optional(Schema.String),
  completionKey: Schema.optional(Schema.String),
  reason: Schema.String,
  observedAtMs: Schema.Number,
})

type DeliveryRow = Schema.Schema.Type<typeof DeliveryRow>
type TerminalRow = Schema.Schema.Type<typeof TerminalRow>
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
    deadLetters: {
      type: "test.durable-channel.dead-letter",
      primaryKey: "rowId",
      schema: Schema.standardSchemaV1(TerminalRow),
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
  })

  const channel: DurableChannelDefinition<
    "test.channel",
    typeof plane.state,
    DeliveryInput
  > = DurableChannel.define({
    name: "test.channel",
    version: "v1",
    plane,
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
      completion: (record) =>
        plane.state.completions.insert({
          value: terminalRow(record, `completion:${record.completionKey}`),
        }),
      deadLetter: (record) =>
        plane.state.deadLetters.insert({
          value: terminalRow(record, `dead-letter:${record.completionKey}`),
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
      deadLetters: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.deadLetters.values()).map((row) =>
          terminalFromRow(row as TerminalRow),
        ),
      conflicts: (snapshot: PlaneSnapshot<typeof plane.state>) =>
        Array.from(snapshot.conflicts.values()).map((row) => {
          const conflict = row as ConflictRow
          return {
            channel: conflict.channel,
            ...(conflict.deliveryKey !== undefined
              ? { deliveryKey: DeliveryKey(conflict.deliveryKey) }
              : {}),
            ...(conflict.completionKey !== undefined
              ? { completionKey: CompletionKey(conflict.completionKey) }
              : {}),
            reason: conflict.reason,
            observedAtMs: conflict.observedAtMs,
          }
        }),
    },
  })

  return { plane, channel }
}

const terminalRow = (
  record: DurableTerminalRecord,
  rowId: string,
): TerminalRow => ({
  rowId,
  channel: record.channel,
  deliveryKey: record.deliveryKey,
  completionKey: record.completionKey,
  kind: record.kind,
  value: String(record.value),
  recordedAtMs: record.recordedAtMs,
})

const deliveryEnvelope = (input: {
  readonly id: string
  readonly acceptedAtMs: number
  readonly body?: string
  readonly scope?: string
  readonly idempotencyKey?: string
}): DurableDeliveryEnvelope => ({
  channel: "test.channel",
  channelVersion: "v1",
  deliveryKey: DeliveryKey(`delivery:${input.id}`),
  completionKey: CompletionKey(`completion:${input.id}`),
  orderingScope: OrderingScope(input.scope ?? "scope-a"),
  producerId: "producer-a",
  idempotencyKey: input.idempotencyKey ?? `idem:${input.id}`,
  payloadFingerprint: input.body ?? `payload:${input.id}`,
  acceptedAtMs: input.acceptedAtMs,
})

const terminalRecord = (input: {
  readonly id: string
  readonly kind: DurableTerminalRecord["kind"]
  readonly value: string
  readonly recordedAtMs: number
}): DurableTerminalRecord => ({
  channel: "test.channel",
  deliveryKey: DeliveryKey(`delivery:${input.id}`),
  completionKey: CompletionKey(`completion:${input.id}`),
  kind: input.kind,
  value: input.value,
  recordedAtMs: input.recordedAtMs,
})

const appendEvent = async (url: string, event: unknown): Promise<void> => {
  const stream = new DurableStream({ url, contentType: "application/json" })
  await stream.append(JSON.stringify(event))
}

const snapshotFold = async (
  url: string,
  fixture: ReturnType<typeof buildFixture>,
): Promise<DurableChannelFold> =>
  run(
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
  it("defines a product-neutral channel descriptor over caller-owned EventPlane rows", () => {
    const { channel } = buildFixture()
    const input = { id: "a", body: "payload", scope: "scope-a" }

    expect(channel.name).toBe("test.channel")
    expect(channel.version).toBe("v1")
    expect(channel.derive.deliveryKey(input)).toBe("delivery:a")
    expect(channel.derive.completionKey(input)).toBe("completion:a")
    expect(channel.derive.orderingScope(input)).toBe("scope-a")
    expect(channel.derive.payloadFingerprint(input)).toBe("payload")
  })
})

describe("firegrid-durable-subscriber-webhooks.DELIVERY_PROJECTION.1, .2, .3", () => {
  it("folds deliveries into pending and idempotency-key indexes without producer semantics", async () => {
    const url = freshStreamUrl("durable-channel-fold-deliveries")
    await DurableStream.create({ url, contentType: "application/json" })
    const fixture = buildFixture()
    const first = deliveryEnvelope({
      id: "a",
      acceptedAtMs: 2,
      idempotencyKey: "idem-a",
    })
    const second = deliveryEnvelope({
      id: "b",
      acceptedAtMs: 1,
      idempotencyKey: "idem-b",
    })

    await appendEvent(
      url,
      fixture.channel.events.delivery(
        { id: "a", body: "payload:a", scope: "scope-a" },
        first,
      ),
    )
    await appendEvent(
      url,
      fixture.channel.events.delivery(
        { id: "b", body: "payload:b", scope: "scope-a" },
        second,
      ),
    )

    const fold = await snapshotFold(url, fixture)

    expect(fold.deliveriesByKey.get(DeliveryKey("delivery:a"))).toEqual(first)
    expect(fold.deliveriesByIdempotencyKey.get("idem-b")).toEqual(second)
    expect(fold.pendingDeliveries.map((delivery) => delivery.deliveryKey))
      .toEqual([DeliveryKey("delivery:b"), DeliveryKey("delivery:a")])
  })

  it("selects the earliest terminal by durable timestamp and reports later conflicts", async () => {
    const url = freshStreamUrl("durable-channel-fold-terminals")
    await DurableStream.create({ url, contentType: "application/json" })
    const fixture = buildFixture()
    const delivery = deliveryEnvelope({ id: "c", acceptedAtMs: 1 })
    const completed = terminalRecord({
      id: "c",
      kind: "completed",
      value: "ok",
      recordedAtMs: 5,
    })
    const deadLetter = terminalRecord({
      id: "c",
      kind: "dead-letter",
      value: "failed",
      recordedAtMs: 3,
    })

    await appendEvent(
      url,
      fixture.channel.events.delivery(
        { id: "c", body: "payload:c", scope: "scope-c" },
        delivery,
      ),
    )
    await appendEvent(url, fixture.channel.events.completion?.(completed))
    await appendEvent(url, fixture.channel.events.deadLetter?.(deadLetter))

    const fold = await snapshotFold(url, fixture)

    expect(fold.terminalByCompletionKey.get(CompletionKey("completion:c"))?.kind)
      .toBe("dead-letter")
    expect(fold.pendingDeliveries).toHaveLength(0)
    expect(fold.deadLetters).toHaveLength(1)
    expect(fold.conflictingTerminals).toHaveLength(1)
    expect(fold.conflictingTerminals[0]?.reason)
      .toBe("terminal-conflict:dead-letter:completed")
  })

  it("materializes a completion query for projection-match callers", async () => {
    const url = freshStreamUrl("durable-channel-completion-query")
    await DurableStream.create({ url, contentType: "application/json" })
    const fixture = buildFixture()
    const delivery = deliveryEnvelope({ id: "d", acceptedAtMs: 1 })
    const completed = terminalRecord({
      id: "d",
      kind: "completed",
      value: "done",
      recordedAtMs: 2,
    })

    await appendEvent(
      url,
      fixture.channel.events.delivery(
        { id: "d", body: "payload:d", scope: "scope-d" },
        delivery,
      ),
    )
    await appendEvent(url, fixture.channel.events.completion?.(completed))

    const terminal = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* fixture.plane.Projection
          return yield* projection.snapshot(
            DurableChannel.completionQuery({
              channel: fixture.channel,
              completionKey: CompletionKey("completion:d"),
            }),
          )
        }),
      ).pipe(
        Effect.provide(EventPlane.layer(fixture.plane, { streamUrl: url })),
      ),
    )

    expect(terminal?.kind).toBe("completed")
    expect(terminal?.value).toBe("done")
  })
})
