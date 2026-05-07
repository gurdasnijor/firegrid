import type { ChangeEvent, StreamStateDefinition } from "@durable-streams/state"
import { Effect } from "effect"
import type { EventPlaneDefinition } from "./define.ts"
import type {
  PlaneProjectionQuery,
  PlaneSnapshot,
} from "./projection.ts"

export type DeliveryKey = string & { readonly DeliveryKey: unique symbol }
export type CompletionKey = string & { readonly CompletionKey: unique symbol }
export type OrderingScope = string & { readonly OrderingScope: unique symbol }

export const DeliveryKey = (value: string): DeliveryKey => value as DeliveryKey
export const CompletionKey = (value: string): CompletionKey =>
  value as CompletionKey
export const OrderingScope = (value: string): OrderingScope =>
  value as OrderingScope

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
  readonly correlationId?: string
  readonly causationId?: string
  readonly trace?: Readonly<Record<string, string>>
}

export interface DurableConflictRecord {
  readonly channel: string
  readonly deliveryKey?: DeliveryKey
  readonly completionKey?: CompletionKey
  readonly reason: string
  readonly observedAtMs: number
}

export interface DurableChannelSelectors<S extends StreamStateDefinition> {
  readonly deliveries: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableDeliveryRecord>
  readonly completions: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableTerminalRecord>
  readonly terminalFailures?: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableTerminalRecord>
  readonly deadLetters: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableTerminalRecord>
  readonly conflicts?: (
    snapshot: PlaneSnapshot<S>,
  ) => Iterable<DurableConflictRecord>
}

export interface DurableChannelEvents<DeliveryInput> {
  readonly delivery: (
    input: DeliveryInput,
    envelope: DurableDeliveryEnvelope,
  ) => ChangeEvent
  readonly completion?: (record: DurableTerminalRecord) => ChangeEvent
  readonly terminalFailure?: (record: DurableTerminalRecord) => ChangeEvent
  readonly deadLetter?: (record: DurableTerminalRecord) => ChangeEvent
}

export interface DurableChannelDefinition<
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
> {
  readonly name: Name
  readonly version: string
  readonly plane: EventPlaneDefinition<Name, S>
  readonly derive: {
    readonly deliveryKey: (input: DeliveryInput) => DeliveryKey
    readonly completionKey: (input: DeliveryInput) => CompletionKey
    readonly orderingScope: (input: DeliveryInput) => OrderingScope
    readonly payloadFingerprint: (input: DeliveryInput) => string
  }
  readonly events: DurableChannelEvents<DeliveryInput>
  readonly select: DurableChannelSelectors<S>
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
  readonly terminalByCompletionKey: ReadonlyMap<
    CompletionKey,
    DurableTerminalRecord
  >
  readonly terminalByDeliveryKey: ReadonlyMap<DeliveryKey, DurableTerminalRecord>
  readonly duplicateTerminals: ReadonlyArray<DurableTerminalRecord>
  readonly conflictingTerminals: ReadonlyArray<DurableConflictRecord>
  readonly conflicts: ReadonlyArray<DurableConflictRecord>
  readonly pendingDeliveries: ReadonlyArray<DurableDeliveryRecord>
  readonly deadLetters: ReadonlyArray<DurableTerminalRecord>
}

const sameTerminal = (
  left: DurableTerminalRecord,
  right: DurableTerminalRecord,
): boolean =>
  left.kind === right.kind
    && JSON.stringify(left.value) === JSON.stringify(right.value)

const compareTerminal = (
  left: DurableTerminalRecord,
  right: DurableTerminalRecord,
): number =>
  left.recordedAtMs - right.recordedAtMs
    || left.kind.localeCompare(right.kind)
    || left.deliveryKey.localeCompare(right.deliveryKey)
    || left.completionKey.localeCompare(right.completionKey)

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

// firegrid-durable-subscriber-webhooks.CHANNEL_DESCRIPTOR.1
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
  const terminalByCompletionKey = new Map<CompletionKey, DurableTerminalRecord>()
  const terminalByDeliveryKey = new Map<DeliveryKey, DurableTerminalRecord>()
  const duplicateTerminals: DurableTerminalRecord[] = []
  const conflictingTerminals: DurableConflictRecord[] = []

  Array.from(channel.select.deliveries(snapshot))
    .sort((left, right) =>
      left.acceptedAtMs - right.acceptedAtMs
        || left.deliveryKey.localeCompare(right.deliveryKey),
    )
    .forEach((delivery) => {
      if (!deliveriesByKey.has(delivery.deliveryKey)) {
        deliveriesByKey.set(delivery.deliveryKey, delivery)
      }
      if (!deliveriesByIdempotencyKey.has(delivery.idempotencyKey)) {
        deliveriesByIdempotencyKey.set(delivery.idempotencyKey, delivery)
      }
    })

  const terminals = [
    ...channel.select.completions(snapshot),
    ...(channel.select.terminalFailures?.(snapshot) ?? []),
    ...channel.select.deadLetters(snapshot),
  ].sort(compareTerminal)

  terminals.forEach((terminal) => {
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

  const pendingDeliveries = Array.from(deliveriesByKey.values()).filter(
    (delivery) => !terminalByDeliveryKey.has(delivery.deliveryKey),
  )

  const deadLetters = terminals.filter((terminal) =>
    terminal.kind === "dead-letter",
  )

  return {
    deliveriesByKey,
    deliveriesByIdempotencyKey,
    terminalByCompletionKey,
    terminalByDeliveryKey,
    duplicateTerminals,
    conflictingTerminals,
    conflicts: [
      ...(channel.select.conflicts?.(snapshot) ?? []),
      ...conflictingTerminals,
    ],
    pendingDeliveries,
    deadLetters,
  }
}

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
>(args: {
  readonly channel: DurableChannelDefinition<Name, S, DeliveryInput>
  readonly completionKey: CompletionKey
}): PlaneProjectionQuery<S, DurableTerminalRecord | undefined> => ({
  label: `durable-channel:${args.channel.name}:completion:${args.completionKey}`,
  authority: "terminal-domain",
  evaluate: (snapshot) =>
    Effect.succeed(
      foldDurableChannel(args.channel, snapshot).terminalByCompletionKey.get(
        args.completionKey,
      ),
    ),
})

export const DurableChannel = {
  define: defineDurableChannel,
  fold: foldDurableChannel,
  foldQuery: durableChannelFoldQuery,
  completionQuery: durableChannelCompletionQuery,
} as const
