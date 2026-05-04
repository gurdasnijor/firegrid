import type {
  ChangeEvent,
  ChangeHeaders,
  CollectionDefinition,
} from "@durable-streams/state"
import { DurableStream } from "@durable-streams/client"
import { Data, Effect } from "effect"

// client-event-plane-registration.PRODUCER_API.1, .2, .3, .4
// PlaneProducer emits typed validated state-collection events. It does
// not expose raw Durable Streams append helpers as the normal API
// (BOUNDARY.1). Callers build events via the plane's StateSchema event
// helpers (e.g. `plane.state.rows.insert({ value })`).

export class PlaneProducerError extends Data.TaggedError(
  "substrate/PlaneProducerError",
)<{
  readonly planeName: string
  readonly cause: unknown
}> {}

export class PlaneProducerValidationError extends Data.TaggedError(
  "substrate/PlaneProducerValidationError",
)<{
  readonly planeName: string
  readonly eventType: string
  readonly issues: unknown
}> {}

export class PlaneProducerUnknownTypeError extends Data.TaggedError(
  "substrate/PlaneProducerUnknownTypeError",
)<{
  readonly planeName: string
  readonly eventType: string
}> {}

export type PlaneProducerErrors =
  | PlaneProducerError
  | PlaneProducerValidationError
  | PlaneProducerUnknownTypeError

// PRODUCER_API.2 — typed metadata extension stored as ChangeEvent
// headers. NOT a fixed envelope (BOUNDARY.2): `extra` lets the higher
// layer attach domain-specific string headers without substrate-owned
// shape pressure.
export interface ProducerMetadata {
  readonly idempotencyKey?: string
  readonly correlationId?: string
  readonly causationId?: string
  readonly extra?: Readonly<Record<string, string>>
}

export interface PlaneProducer {
  readonly emit: (
    event: ChangeEvent,
    metadata?: ProducerMetadata,
  ) => Effect.Effect<{ readonly appended: true }, PlaneProducerErrors>
}

const mergeMetadataIntoHeaders = (
  event: ChangeEvent,
  metadata: ProducerMetadata | undefined,
): ChangeEvent => {
  if (metadata === undefined) return event
  // ChangeHeaders is a closed shape (operation/txid/timestamp). Producer
  // metadata is layered as additional string fields at runtime — the
  // State helpers already accept arbitrary extra headers via
  // `Omit<Record<string,string>, "operation">`. We build the merged
  // object as a Record<string,string> and cast to ChangeHeaders for
  // the final ChangeEvent. Extras are erased from the type but present
  // at runtime, matching the State helper convention.
  const merged: Record<string, string> = {
    ...(event.headers as unknown as Record<string, string>),
  }
  if (metadata.idempotencyKey !== undefined) {
    merged.idempotencyKey = metadata.idempotencyKey
  }
  if (metadata.correlationId !== undefined) {
    merged.correlationId = metadata.correlationId
  }
  if (metadata.causationId !== undefined) {
    merged.causationId = metadata.causationId
  }
  if (metadata.extra !== undefined) {
    for (const [k, v] of Object.entries(metadata.extra)) merged[k] = v
  }
  return { ...event, headers: merged as unknown as ChangeHeaders }
}

// PRODUCER_API.3 — defense-in-depth re-validation against the
// registered Standard Schema for the event's type. Catches forged
// ChangeEvents that bypass the State helpers.
type RevalidateError = PlaneProducerValidationError | PlaneProducerUnknownTypeError

const revalidate = (
  planeName: string,
  event: ChangeEvent,
  collectionsByType: ReadonlyMap<string, CollectionDefinition>,
): Effect.Effect<void, RevalidateError> =>
  Effect.suspend((): Effect.Effect<void, RevalidateError> => {
    const def = collectionsByType.get(event.type)
    if (def === undefined) {
      return Effect.fail(
        new PlaneProducerUnknownTypeError({ planeName, eventType: event.type }),
      )
    }
    if (event.value === undefined) {
      // delete events have no value to validate; accepted as-is.
      return Effect.void
    }
    const result = def.schema["~standard"].validate(event.value)
    // Standard Schema validate may return Promise; the helpers used by
    // createStateSchema are synchronous in practice. Handle both.
    if (result instanceof Promise) {
      return Effect.tryPromise({
        try: async () => {
          const r = await result
          if ("issues" in r && r.issues !== undefined) {
            throw new PlaneProducerValidationError({
              planeName,
              eventType: event.type,
              issues: r.issues,
            })
          }
        },
        catch: (cause): RevalidateError =>
          cause instanceof PlaneProducerValidationError
            ? cause
            : new PlaneProducerValidationError({
                planeName,
                eventType: event.type,
                issues: cause,
              }),
      })
    }
    if ("issues" in result && result.issues !== undefined) {
      return Effect.fail(
        new PlaneProducerValidationError({
          planeName,
          eventType: event.type,
          issues: result.issues,
        }),
      )
    }
    return Effect.void
  })

export interface MakePlaneProducerArgs {
  readonly planeName: string
  readonly streamUrl: string
  readonly contentType?: string
  readonly collectionsByType: ReadonlyMap<string, CollectionDefinition>
}

export const makePlaneProducer = (args: MakePlaneProducerArgs): PlaneProducer => {
  const contentType = args.contentType ?? "application/json"
  const stream = new DurableStream({ url: args.streamUrl, contentType })
  return {
    emit: (event, metadata) =>
      Effect.gen(function* () {
        yield* revalidate(args.planeName, event, args.collectionsByType)
        const enriched = mergeMetadataIntoHeaders(event, metadata)
        yield* Effect.tryPromise({
          try: () => stream.append(JSON.stringify(enriched)),
          catch: (cause) =>
            new PlaneProducerError({ planeName: args.planeName, cause }),
        })
        return { appended: true as const }
      }),
  }
}
