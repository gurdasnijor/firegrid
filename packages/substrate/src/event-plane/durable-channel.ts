import type { ChangeEvent, StreamStateDefinition } from "@durable-streams/state"
import { Effect, Schema } from "effect"
import type { EventPlaneDefinition } from "./define.ts"
import type { PlaneProducer, ProducerMetadata } from "./producer.ts"
import type {
  PlaneProjection,
  PlaneProjectionQuery,
  PlaneSnapshot,
} from "./projection.ts"

export type DeliveryKey = string & { readonly DeliveryKey: unique symbol }
export type CompletionKey = string & { readonly CompletionKey: unique symbol }
export type OrderingScope = string & { readonly OrderingScope: unique symbol }
export type DurableSubscriberId = string & {
  readonly DurableSubscriberId: unique symbol
}
export type DurableClaimId = string & { readonly DurableClaimId: unique symbol }

export const DeliveryKey = (value: string): DeliveryKey => value as DeliveryKey
export const CompletionKey = (value: string): CompletionKey =>
  value as CompletionKey
export const OrderingScope = (value: string): OrderingScope =>
  value as OrderingScope
export const DurableSubscriberId = (value: string): DurableSubscriberId =>
  value as DurableSubscriberId
export const DurableClaimId = (value: string): DurableClaimId =>
  value as DurableClaimId

export type DuplicateExpiryBehavior = "accept-new" | "conflict"

export interface DurableChannelDedupePolicy {
  readonly retentionWindowMs: number
  readonly afterRetentionWindow: DuplicateExpiryBehavior
}

export interface DurableDeliveryMetadata {
  readonly producerId: string
  readonly idempotencyKey: string
  readonly correlationId?: string
  readonly causationId?: string
  readonly trace?: Readonly<Record<string, string>>
}

export interface DurableDeliveryEnvelope {
  readonly channel: string
  readonly channelVersion: string
  readonly deliveryKey: DeliveryKey
  readonly completionKey: CompletionKey
  readonly orderingScope: OrderingScope
  readonly producerId: string
  readonly idempotencyKey: string
  readonly payloadFingerprint: string
  readonly acceptedAtMs: number
  readonly correlationId?: string
  readonly causationId?: string
  readonly trace?: Readonly<Record<string, string>>
}

export type DurableDeliveryRecord = DurableDeliveryEnvelope

export interface DurableClaimRecord {
  readonly channel: string
  readonly deliveryKey: DeliveryKey
  readonly orderingScope: OrderingScope
  readonly claimId: DurableClaimId
  readonly subscriberId: DurableSubscriberId
  readonly attempt: number
  readonly claimedAtMs: number
  readonly sourceCursor?: string
  readonly leaseExpiresAtMs?: number
  readonly heartbeatAtMs?: number
  readonly fencingToken?: string
  readonly correlationId?: string
  readonly causationId?: string
  readonly trace?: Readonly<Record<string, string>>
}

export type DurableTerminalKind =
  | "completed"
  | "cancelled"
  | "terminal-failure"
  | "dead-letter"

export interface DurableTerminalRecord {
  readonly channel: string
  readonly deliveryKey: DeliveryKey
  readonly completionKey: CompletionKey
  readonly kind: DurableTerminalKind
  readonly value: unknown
  readonly recordedAtMs: number
  readonly subscriberId?: DurableSubscriberId
  readonly claimId?: DurableClaimId
  readonly correlationId?: string
  readonly causationId?: string
  readonly trace?: Readonly<Record<string, string>>
}

export interface DurableConflictRecord {
  readonly channel: string
  readonly deliveryKey?: DeliveryKey
  readonly completionKey?: CompletionKey
  readonly idempotencyKey?: string
  readonly reason: string
  readonly observedAtMs: number
  readonly existingFingerprint?: string
  readonly incomingFingerprint?: string
}

export interface DurableRetryRecord {
  readonly channel: string
  readonly deliveryKey: DeliveryKey
  readonly claimId?: DurableClaimId
  readonly attempt: number
  readonly retryAtMs: number
  readonly reason: unknown
}

export interface DurableCursorAckRecord {
  readonly channel: string
  readonly subscriberId: DurableSubscriberId
  readonly sourceCursor: string
  readonly acknowledgedAtMs: number
}

export interface DurableChannelSelectors<S extends StreamStateDefinition> {
  readonly deliveries: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableDeliveryRecord>
  readonly claims?: (snapshot: PlaneSnapshot<S>) => Iterable<DurableClaimRecord>
  readonly completions: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableTerminalRecord>
  readonly terminalFailures?: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableTerminalRecord>
  readonly deadLetters: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableTerminalRecord>
  readonly retries?: (snapshot: PlaneSnapshot<S>) => Iterable<DurableRetryRecord>
  readonly conflicts: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableConflictRecord>
  readonly cursorAcks?: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableCursorAckRecord>
}

export interface DurableChannelEvents<DeliveryInput> {
  readonly delivery: (
    input: DeliveryInput,
    envelope: DurableDeliveryEnvelope,
  ) => ChangeEvent
  readonly claim?: (record: DurableClaimRecord) => ChangeEvent
  readonly completion?: (record: DurableTerminalRecord) => ChangeEvent
  readonly terminalFailure?: (record: DurableTerminalRecord) => ChangeEvent
  readonly deadLetter?: (record: DurableTerminalRecord) => ChangeEvent
  readonly retry?: (record: DurableRetryRecord) => ChangeEvent
  readonly cursorAck?: (record: DurableCursorAckRecord) => ChangeEvent
  readonly conflict: (input: {
    readonly incoming: DeliveryInput
    readonly envelope: DurableDeliveryEnvelope
    readonly existing: DurableDeliveryRecord
    readonly reason: "idempotency-payload-conflict"
  }) => ChangeEvent
}

export interface DurableChannelDefinition<
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
> {
  readonly name: Name
  readonly version: string
  readonly plane: EventPlaneDefinition<Name, S>
  readonly dedupe: DurableChannelDedupePolicy
  readonly derive: {
    readonly deliveryKey: (input: DeliveryInput) => DeliveryKey
    readonly completionKey: (input: DeliveryInput) => CompletionKey
    readonly orderingScope: (input: DeliveryInput) => OrderingScope
    readonly payloadFingerprint: (input: DeliveryInput) => string
  }
  readonly events: DurableChannelEvents<DeliveryInput>
  readonly select: DurableChannelSelectors<S>
}

export interface DurableChannelServices<S extends StreamStateDefinition> {
  readonly producer: PlaneProducer
  readonly projection: PlaneProjection<S>
}

export const defineDurableChannel = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  definition: DurableChannelDefinition<Name, S, DeliveryInput>,
): DurableChannelDefinition<Name, S, DeliveryInput> => definition

export interface DurableChannelFold {
  readonly deliveriesByKey: ReadonlyMap<DeliveryKey, DurableDeliveryRecord>
  readonly deliveriesByIdempotencyKey: ReadonlyMap<
    string,
    DurableDeliveryRecord
  >
  readonly claimsByDeliveryKey: ReadonlyMap<
    DeliveryKey,
    ReadonlyArray<DurableClaimRecord>
  >
  readonly claimWinnerByDeliveryKey: ReadonlyMap<
    DeliveryKey,
    DurableClaimRecord
  >
  readonly terminalByCompletionKey: ReadonlyMap<
    CompletionKey,
    DurableTerminalRecord
  >
  readonly terminalByDeliveryKey: ReadonlyMap<DeliveryKey, DurableTerminalRecord>
  readonly duplicateTerminals: ReadonlyArray<DurableTerminalRecord>
  readonly conflictingTerminals: ReadonlyArray<DurableConflictRecord>
  readonly conflicts: ReadonlyArray<DurableConflictRecord>
  readonly retriesByDeliveryKey: ReadonlyMap<
    DeliveryKey,
    ReadonlyArray<DurableRetryRecord>
  >
  readonly cursorAcksBySubscriber: ReadonlyMap<
    DurableSubscriberId,
    DurableCursorAckRecord
  >
  readonly pendingDeliveries: ReadonlyArray<DurableDeliveryRecord>
  readonly claimableDeliveries: ReadonlyArray<DurableDeliveryRecord>
  readonly deadLetters: ReadonlyArray<DurableTerminalRecord>
}

const appendGrouped = <K, V>(
  map: Map<K, ReadonlyArray<V>>,
  key: K,
  value: V,
) => {
  map.set(key, [...(map.get(key) ?? []), value])
}

const sameTerminal = (
  left: DurableTerminalRecord,
  right: DurableTerminalRecord,
): boolean =>
  left.kind === right.kind
    && JSON.stringify(left.value) === JSON.stringify(right.value)

const terminalConflict = (
  first: DurableTerminalRecord,
  later: DurableTerminalRecord,
): DurableConflictRecord => ({
  channel: first.channel,
  deliveryKey: first.deliveryKey,
  completionKey: first.completionKey,
  reason: `terminal-conflict:${first.kind}:${later.kind}`,
  observedAtMs: later.recordedAtMs,
})

// firegrid-durable-subscriber-webhooks.DELIVERY_PROJECTION.1
// firegrid-durable-subscriber-webhooks.DELIVERY_PROJECTION.2
// firegrid-durable-subscriber-webhooks.DELIVERY_PROJECTION.3
export const foldDurableChannel = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  snapshot: PlaneSnapshot<S>,
): DurableChannelFold => {
  const deliveriesByKey = new Map<DeliveryKey, DurableDeliveryRecord>()
  const deliveriesByIdempotencyKey = new Map<string, DurableDeliveryRecord>()
  const claimsByDeliveryKey = new Map<
    DeliveryKey,
    ReadonlyArray<DurableClaimRecord>
  >()
  const terminalByCompletionKey = new Map<CompletionKey, DurableTerminalRecord>()
  const terminalByDeliveryKey = new Map<DeliveryKey, DurableTerminalRecord>()
  const duplicateTerminals: DurableTerminalRecord[] = []
  const conflictingTerminals: DurableConflictRecord[] = []
  const retriesByDeliveryKey = new Map<
    DeliveryKey,
    ReadonlyArray<DurableRetryRecord>
  >()
  const cursorAcksBySubscriber = new Map<
    DurableSubscriberId,
    DurableCursorAckRecord
  >()
  const deadLetters: DurableTerminalRecord[] = []

  Array.from(channel.select.deliveries(snapshot)).forEach((delivery) => {
    if (!deliveriesByKey.has(delivery.deliveryKey)) {
      deliveriesByKey.set(delivery.deliveryKey, delivery)
    }
    if (!deliveriesByIdempotencyKey.has(delivery.idempotencyKey)) {
      deliveriesByIdempotencyKey.set(delivery.idempotencyKey, delivery)
    }
  })

  Array.from(channel.select.claims?.(snapshot) ?? []).forEach((claim) => {
    appendGrouped(claimsByDeliveryKey, claim.deliveryKey, claim)
  })

  const terminalInputs = [
    ...channel.select.completions(snapshot),
    ...(channel.select.terminalFailures?.(snapshot) ?? []),
    ...channel.select.deadLetters(snapshot),
  ]
  terminalInputs.forEach((terminal) => {
    if (terminal.kind === "dead-letter") deadLetters.push(terminal)

    const existing = terminalByCompletionKey.get(terminal.completionKey)
    if (existing === undefined) {
      terminalByCompletionKey.set(terminal.completionKey, terminal)
      terminalByDeliveryKey.set(terminal.deliveryKey, terminal)
      return
    }
    if (sameTerminal(existing, terminal)) {
      duplicateTerminals.push(terminal)
      return
    }
    conflictingTerminals.push(terminalConflict(existing, terminal))
  })

  Array.from(channel.select.retries?.(snapshot) ?? []).forEach((retry) => {
    appendGrouped(retriesByDeliveryKey, retry.deliveryKey, retry)
  })

  Array.from(channel.select.cursorAcks?.(snapshot) ?? []).forEach((ack) => {
    const existing = cursorAcksBySubscriber.get(ack.subscriberId)
    if (
      existing === undefined
      || existing.acknowledgedAtMs <= ack.acknowledgedAtMs
    ) {
      cursorAcksBySubscriber.set(ack.subscriberId, ack)
    }
  })

  const pendingDeliveries = Array.from(deliveriesByKey.values()).filter(
    (delivery) => !terminalByDeliveryKey.has(delivery.deliveryKey),
  )
  const claimWinnerByDeliveryKey = new Map<DeliveryKey, DurableClaimRecord>()
  Array.from(claimsByDeliveryKey).forEach(([deliveryKey, claims]) => {
    const first = claims[0]
    if (first !== undefined) claimWinnerByDeliveryKey.set(deliveryKey, first)
  })
  const orderedPending = [...pendingDeliveries].sort((left, right) =>
    left.acceptedAtMs - right.acceptedAtMs,
  )
  const firstPendingByScope = new Map<OrderingScope, DeliveryKey>()
  orderedPending.forEach((delivery) => {
    if (!firstPendingByScope.has(delivery.orderingScope)) {
      firstPendingByScope.set(delivery.orderingScope, delivery.deliveryKey)
    }
  })
  const claimableDeliveries = orderedPending.filter((delivery) =>
    !claimWinnerByDeliveryKey.has(delivery.deliveryKey)
      && firstPendingByScope.get(delivery.orderingScope) === delivery.deliveryKey,
  )

  return {
    deliveriesByKey,
    deliveriesByIdempotencyKey,
    claimsByDeliveryKey,
    claimWinnerByDeliveryKey,
    terminalByCompletionKey,
    terminalByDeliveryKey,
    duplicateTerminals,
    conflictingTerminals,
    conflicts: [...channel.select.conflicts(snapshot), ...conflictingTerminals],
    retriesByDeliveryKey,
    cursorAcksBySubscriber,
    pendingDeliveries,
    claimableDeliveries,
    deadLetters,
  }
}

export class DurableDeliveryConflictError extends Schema.TaggedError<DurableDeliveryConflictError>()(
  "substrate/DurableDeliveryConflictError",
  {
    channel: Schema.String,
    idempotencyKey: Schema.String,
    existing: Schema.Unknown,
    incoming: Schema.Unknown,
  },
) {}

export class DurableDeliveryAppendError extends Schema.TaggedError<DurableDeliveryAppendError>()(
  "substrate/DurableDeliveryAppendError",
  {
    channel: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type DurableDeliveryProducerError =
  | DurableDeliveryConflictError
  | DurableDeliveryAppendError

export type DurableDeliveryAppendResult =
  | {
      readonly kind: "accepted"
      readonly delivery: DurableDeliveryEnvelope
    }
  | {
      readonly kind: "duplicate"
      readonly original: DurableDeliveryRecord
    }

export interface DurableDeliveryAppendInput<DeliveryInput> {
  readonly input: DeliveryInput
  readonly metadata: DurableDeliveryMetadata
}

export class DurableChannelMissingEventError extends Schema.TaggedError<DurableChannelMissingEventError>()(
  "substrate/DurableChannelMissingEventError",
  {
    channel: Schema.String,
    event: Schema.String,
  },
) {}

export class DurableChannelClaimError extends Schema.TaggedError<DurableChannelClaimError>()(
  "substrate/DurableChannelClaimError",
  {
    channel: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class DurableDeliveryNotFoundError extends Schema.TaggedError<DurableDeliveryNotFoundError>()(
  "substrate/DurableDeliveryNotFoundError",
  {
    channel: Schema.String,
    deliveryKey: Schema.String,
  },
) {}

export type DurableChannelClaimFailure =
  | DurableChannelMissingEventError
  | DurableChannelClaimError
  | DurableDeliveryNotFoundError

export interface DurableChannelClaimInput {
  readonly deliveryKey: DeliveryKey
  readonly subscriberId: DurableSubscriberId
  readonly claimId: DurableClaimId
  readonly attempt: number
  readonly sourceCursor?: string
  readonly leaseExpiresAtMs?: number
  readonly heartbeatAtMs?: number
  readonly fencingToken?: string
}

export type DurableChannelClaimResult =
  | {
      readonly kind: "claimed"
      readonly delivery: DurableDeliveryRecord
      readonly claim: DurableClaimRecord
    }
  | {
      readonly kind: "claim-lost"
      readonly delivery: DurableDeliveryRecord
      readonly winner: DurableClaimRecord
    }
  | {
      readonly kind: "already-terminal"
      readonly delivery: DurableDeliveryRecord
      readonly terminal: DurableTerminalRecord
    }
  | {
      readonly kind: "not-claimable"
      readonly delivery: DurableDeliveryRecord
    }

export type DurableOutcomeInput =
  | {
      readonly kind: "completed"
      readonly deliveryKey: DeliveryKey
      readonly subscriberId: DurableSubscriberId
      readonly claimId: DurableClaimId
      readonly value: unknown
    }
  | {
      readonly kind: "terminal-failure"
      readonly deliveryKey: DeliveryKey
      readonly subscriberId: DurableSubscriberId
      readonly claimId: DurableClaimId
      readonly value: unknown
    }
  | {
      readonly kind: "dead-letter"
      readonly deliveryKey: DeliveryKey
      readonly subscriberId: DurableSubscriberId
      readonly claimId: DurableClaimId
      readonly value: unknown
    }
  | {
      readonly kind: "retry"
      readonly deliveryKey: DeliveryKey
      readonly subscriberId: DurableSubscriberId
      readonly claimId: DurableClaimId
      readonly attempt: number
      readonly retryAtMs: number
      readonly reason: unknown
    }

export type DurableOutcomeResult =
  | {
      readonly kind: "recorded-terminal"
      readonly delivery: DurableDeliveryRecord
      readonly terminal: DurableTerminalRecord
    }
  | {
      readonly kind: "recorded-retry"
      readonly delivery: DurableDeliveryRecord
      readonly retry: DurableRetryRecord
    }
  | {
      readonly kind: "already-terminal"
      readonly delivery: DurableDeliveryRecord
      readonly terminal: DurableTerminalRecord
    }
  | {
      readonly kind: "claim-lost"
      readonly delivery: DurableDeliveryRecord
      readonly winner: DurableClaimRecord
    }

export type DurableOutcomeError =
  | DurableChannelMissingEventError
  | DurableChannelClaimError
  | DurableDeliveryNotFoundError

const producerMetadata = (
  metadata: DurableDeliveryMetadata,
): ProducerMetadata => ({
  idempotencyKey: metadata.idempotencyKey,
  ...(metadata.correlationId !== undefined
    ? { correlationId: metadata.correlationId }
    : {}),
  ...(metadata.causationId !== undefined
    ? { causationId: metadata.causationId }
    : {}),
  ...(metadata.trace !== undefined ? { extra: metadata.trace } : {}),
})

const carryMetadata = (
  idempotencyKey: string,
  delivery: DurableDeliveryRecord,
  override: {
    readonly correlationId?: string
    readonly causationId?: string
    readonly trace?: Readonly<Record<string, string>>
  },
): ProducerMetadata => ({
  idempotencyKey,
  ...(override.correlationId !== undefined
    ? { correlationId: override.correlationId }
    : delivery.correlationId !== undefined
      ? { correlationId: delivery.correlationId }
      : {}),
  ...(override.causationId !== undefined
    ? { causationId: override.causationId }
    : delivery.causationId !== undefined
      ? { causationId: delivery.causationId }
      : {}),
  ...(override.trace !== undefined
    ? { extra: override.trace }
    : delivery.trace !== undefined
      ? { extra: delivery.trace }
      : {}),
})

const claimMetadata = (
  delivery: DurableDeliveryRecord,
  claim: DurableClaimRecord,
): ProducerMetadata =>
  carryMetadata(
    `${delivery.idempotencyKey}:claim:${claim.claimId}`,
    delivery,
    claim,
  )

const terminalMetadata = (
  delivery: DurableDeliveryRecord,
  terminal: DurableTerminalRecord,
): ProducerMetadata =>
  carryMetadata(
    `${delivery.idempotencyKey}:terminal:${terminal.kind}:${terminal.claimId ?? "unclaimed"}`,
    delivery,
    terminal,
  )

const mapClaimError = (channel: string) => (cause: unknown) =>
  new DurableChannelClaimError({ channel, cause })

const missingEvent = (channel: string, event: string) =>
  new DurableChannelMissingEventError({ channel, event })

const inheritedRecordMetadata = (delivery: DurableDeliveryRecord) => ({
  ...(delivery.correlationId !== undefined
    ? { correlationId: delivery.correlationId }
    : {}),
  ...(delivery.causationId !== undefined
    ? { causationId: delivery.causationId }
    : {}),
  ...(delivery.trace !== undefined ? { trace: delivery.trace } : {}),
})

const loadFold = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  projection: PlaneProjection<S>,
): Effect.Effect<DurableChannelFold, DurableChannelClaimError> =>
  projection.snapshot(durableChannelFoldQuery(channel)).pipe(
    Effect.mapError(mapClaimError(channel.name)),
  )

const deliveryOrNotFound = (
  channel: string,
  fold: DurableChannelFold,
  deliveryKey: DeliveryKey,
): Effect.Effect<DurableDeliveryRecord, DurableDeliveryNotFoundError> => {
  const delivery = fold.deliveriesByKey.get(deliveryKey)
  if (delivery !== undefined) return Effect.succeed(delivery)
  return Effect.fail(new DurableDeliveryNotFoundError({ channel, deliveryKey }))
}

export const appendDurableDelivery = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  services: DurableChannelServices<S>,
  request: DurableDeliveryAppendInput<DeliveryInput>,
): Effect.Effect<DurableDeliveryAppendResult, DurableDeliveryProducerError> =>
  Effect.gen(function* () {
    const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const envelope: DurableDeliveryEnvelope = {
      channel: channel.name,
      channelVersion: channel.version,
      deliveryKey: channel.derive.deliveryKey(request.input),
      completionKey: channel.derive.completionKey(request.input),
      orderingScope: channel.derive.orderingScope(request.input),
      producerId: request.metadata.producerId,
      idempotencyKey: request.metadata.idempotencyKey,
      payloadFingerprint: channel.derive.payloadFingerprint(request.input),
      acceptedAtMs: nowMs,
      ...(request.metadata.correlationId !== undefined
        ? { correlationId: request.metadata.correlationId }
        : {}),
      ...(request.metadata.causationId !== undefined
        ? { causationId: request.metadata.causationId }
        : {}),
      ...(request.metadata.trace !== undefined
        ? { trace: request.metadata.trace }
        : {}),
    }

    const fold = yield* services.projection.snapshot(
      durableChannelFoldQuery(channel),
    ).pipe(
      Effect.mapError((cause) =>
        new DurableDeliveryAppendError({ channel: channel.name, cause }),
      ),
    )

    const existing = fold.deliveriesByIdempotencyKey.get(
      request.metadata.idempotencyKey,
    )
    if (existing !== undefined) {
      if (existing.payloadFingerprint === envelope.payloadFingerprint) {
        return { kind: "duplicate" as const, original: existing }
      }
      yield* services.producer.emit(
        channel.events.conflict({
          incoming: request.input,
          envelope,
          existing,
          reason: "idempotency-payload-conflict",
        }),
        producerMetadata(request.metadata),
      ).pipe(
        Effect.mapError((cause) =>
          new DurableDeliveryAppendError({ channel: channel.name, cause }),
        ),
      )
      return yield* Effect.fail(
        new DurableDeliveryConflictError({
          channel: channel.name,
          idempotencyKey: request.metadata.idempotencyKey,
          existing,
          incoming: envelope,
        }),
      )
    }

    yield* services.producer.emit(
      channel.events.delivery(request.input, envelope),
      producerMetadata(request.metadata),
    ).pipe(
      Effect.mapError((cause) =>
        new DurableDeliveryAppendError({ channel: channel.name, cause }),
      ),
    )
    return { kind: "accepted" as const, delivery: envelope }
  })

// firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.2
// firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.3
// firegrid-durable-subscriber-webhooks.DELIVERY_SEMANTICS.1
export const claimDurableDelivery = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  services: DurableChannelServices<S>,
  input: DurableChannelClaimInput,
): Effect.Effect<DurableChannelClaimResult, DurableChannelClaimFailure> =>
  Effect.gen(function* () {
    const buildClaim = channel.events.claim
    if (buildClaim === undefined) {
      return yield* Effect.fail(missingEvent(channel.name, "claim"))
    }

    const fold = yield* loadFold(channel, services.projection)
    const delivery = yield* deliveryOrNotFound(
      channel.name,
      fold,
      input.deliveryKey,
    )
    const terminal = fold.terminalByDeliveryKey.get(delivery.deliveryKey)
    if (terminal !== undefined) {
      return { kind: "already-terminal" as const, delivery, terminal }
    }
    if (
      !fold.claimableDeliveries.some((candidate) =>
        candidate.deliveryKey === delivery.deliveryKey,
      )
    ) {
      return { kind: "not-claimable" as const, delivery }
    }
    const winner = fold.claimWinnerByDeliveryKey.get(delivery.deliveryKey)
    if (winner !== undefined) {
      if (winner.claimId === input.claimId) {
        return { kind: "claimed" as const, delivery, claim: winner }
      }
      return { kind: "claim-lost" as const, delivery, winner }
    }

    const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const claim: DurableClaimRecord = {
      channel: channel.name,
      deliveryKey: delivery.deliveryKey,
      orderingScope: delivery.orderingScope,
      subscriberId: input.subscriberId,
      claimId: input.claimId,
      attempt: input.attempt,
      claimedAtMs: nowMs,
      ...(input.sourceCursor !== undefined
        ? { sourceCursor: input.sourceCursor }
        : {}),
      ...(input.leaseExpiresAtMs !== undefined
        ? { leaseExpiresAtMs: input.leaseExpiresAtMs }
        : {}),
      ...(input.heartbeatAtMs !== undefined
        ? { heartbeatAtMs: input.heartbeatAtMs }
        : {}),
      ...(input.fencingToken !== undefined
        ? { fencingToken: input.fencingToken }
        : {}),
      ...inheritedRecordMetadata(delivery),
    }
    yield* services.producer.emit(buildClaim(claim), claimMetadata(delivery, claim)).pipe(
      Effect.mapError(mapClaimError(channel.name)),
    )

    const observed = yield* services.projection.until(
      durableChannelFoldQuery(channel),
      (next) => next.claimWinnerByDeliveryKey.has(delivery.deliveryKey),
      { timeout: "2 seconds" },
    ).pipe(Effect.mapError(mapClaimError(channel.name)))
    const observedWinner = observed.claimWinnerByDeliveryKey.get(
      delivery.deliveryKey,
    )
    if (observedWinner?.claimId === input.claimId) {
      return { kind: "claimed" as const, delivery, claim: observedWinner }
    }
    if (observedWinner !== undefined) {
      return { kind: "claim-lost" as const, delivery, winner: observedWinner }
    }
    return { kind: "claim-lost" as const, delivery, winner: claim }
  })

// firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.4
// firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.5
// firegrid-durable-subscriber-webhooks.DELIVERY_PROJECTION.2
export const recordDurableChannelOutcome = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  services: DurableChannelServices<S>,
  outcome: DurableOutcomeInput,
): Effect.Effect<DurableOutcomeResult, DurableOutcomeError> =>
  Effect.gen(function* () {
    const fold = yield* loadFold(channel, services.projection)
    const delivery = yield* deliveryOrNotFound(
      channel.name,
      fold,
      outcome.deliveryKey,
    )
    const terminal = fold.terminalByDeliveryKey.get(delivery.deliveryKey)
    if (terminal !== undefined) {
      return { kind: "already-terminal" as const, delivery, terminal }
    }
    const winner = fold.claimWinnerByDeliveryKey.get(delivery.deliveryKey)
    if (winner === undefined || winner.claimId !== outcome.claimId) {
      if (winner !== undefined) {
        return { kind: "claim-lost" as const, delivery, winner }
      }
      return yield* Effect.fail(
        new DurableChannelClaimError({
          channel: channel.name,
          cause: "missing-winning-claim",
        }),
      )
    }

    if (outcome.kind === "retry") {
      const buildRetry = channel.events.retry
      if (buildRetry === undefined) {
        return yield* Effect.fail(missingEvent(channel.name, "retry"))
      }
      const retry: DurableRetryRecord = {
        channel: channel.name,
        deliveryKey: delivery.deliveryKey,
        claimId: outcome.claimId,
        attempt: outcome.attempt,
        retryAtMs: outcome.retryAtMs,
        reason: outcome.reason,
      }
      yield* services.producer.emit(buildRetry(retry), {
        idempotencyKey: `${delivery.idempotencyKey}:retry:${outcome.claimId}:${outcome.attempt}`,
      }).pipe(Effect.mapError(mapClaimError(channel.name)))
      return { kind: "recorded-retry" as const, delivery, retry }
    }

    const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const nextTerminal: DurableTerminalRecord = {
      channel: channel.name,
      deliveryKey: delivery.deliveryKey,
      completionKey: delivery.completionKey,
      kind: outcome.kind,
      value: outcome.value,
      recordedAtMs: nowMs,
      subscriberId: outcome.subscriberId,
      claimId: outcome.claimId,
      ...inheritedRecordMetadata(delivery),
    }
    const buildTerminal =
      outcome.kind === "completed"
        ? channel.events.completion
        : outcome.kind === "terminal-failure"
          ? channel.events.terminalFailure
          : channel.events.deadLetter
    if (buildTerminal === undefined) {
      return yield* Effect.fail(missingEvent(channel.name, outcome.kind))
    }
    yield* services.producer.emit(
      buildTerminal(nextTerminal),
      terminalMetadata(delivery, nextTerminal),
    ).pipe(Effect.mapError(mapClaimError(channel.name)))
    return {
      kind: "recorded-terminal" as const,
      delivery,
      terminal: nextTerminal,
    }
  })

export const durableChannelFoldQuery = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
): PlaneProjectionQuery<S, DurableChannelFold> => ({
  label: `durable-channel:${channel.name}:fold`,
  authority: "eligibility-producing",
  evaluate: (snapshot) => Effect.succeed(foldDurableChannel(channel, snapshot)),
})

export const durableChannelCompletionQuery = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  completionKey: CompletionKey,
): PlaneProjectionQuery<S, DurableTerminalRecord | undefined> => ({
  label: `durable-channel:${channel.name}:completion:${completionKey}`,
  authority: "terminal-domain",
  evaluate: (snapshot) =>
    Effect.succeed(
      foldDurableChannel(channel, snapshot).terminalByCompletionKey.get(
        completionKey,
      ),
    ),
})

export const DurableChannel = {
  define: defineDurableChannel,
  appendDelivery: appendDurableDelivery,
  claimDelivery: claimDurableDelivery,
  recordOutcome: recordDurableChannelOutcome,
  fold: foldDurableChannel,
  foldQuery: durableChannelFoldQuery,
  completionQuery: durableChannelCompletionQuery,
} as const
