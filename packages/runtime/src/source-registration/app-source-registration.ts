import { Effect, Layer, type Stream } from "effect"
import {
  SourceCollections,
  sourceCollectionStreamHandle,
} from "../waits/source-registration.ts"

export interface RuntimeHostAppSourceRegistration {
  readonly name: string
  readonly stream: Stream.Stream<unknown, unknown>
}

export const registerRuntimeHostAppSource = (
  source: RuntimeHostAppSourceRegistration,
): Effect.Effect<void, never, SourceCollections> =>
  Effect.flatMap(SourceCollections, registrations =>
    registrations.register(sourceCollectionStreamHandle(source.name, source.stream)))

export const RuntimeHostAppSourceRegistrationsLive = (
  sources: ReadonlyArray<RuntimeHostAppSourceRegistration>,
) =>
  Layer.scopedDiscard(
    Effect.forEach(
      sources,
      registerRuntimeHostAppSource,
      { discard: true },
    ),
  )
