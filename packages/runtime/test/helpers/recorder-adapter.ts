import { Effect, Ref } from "effect"
import {
  type RuntimeContextSessionAdapterService,
  type SessionInputPayload,
} from "../../src/unified/adapter.ts"

interface RecorderAdapterState {
  readonly spawns: ReadonlyArray<string>
  readonly sends: ReadonlyArray<{ readonly key: string; readonly input: SessionInputPayload }>
  readonly deregistrations: ReadonlyArray<string>
}

interface RecorderAdapter {
  readonly service: RuntimeContextSessionAdapterService
  readonly snapshot: Effect.Effect<RecorderAdapterState>
}

const sessionKey = (contextId: string, attempt: number): string =>
  `${contextId}:${attempt}`

export const makeRecorderAdapter = (): Effect.Effect<RecorderAdapter> =>
  Effect.gen(function*() {
    const state = yield* Ref.make<RecorderAdapterState>({
      spawns: [],
      sends: [],
      deregistrations: [],
    })

    const service: RuntimeContextSessionAdapterService = {
      startOrAttach: (contextId, attempt) =>
        Ref.update(state, (current) => ({
          ...current,
          spawns: [...current.spawns, sessionKey(contextId, attempt)],
        })),
      send: (contextId, attempt, input) =>
        Ref.update(state, (current) => ({
          ...current,
          sends: [
            ...current.sends,
            { key: sessionKey(contextId, attempt), input },
          ],
        })),
      deregister: (contextId) =>
        Ref.update(state, (current) => ({
          ...current,
          deregistrations: [...current.deregistrations, contextId],
        })),
    }

    return {
      service,
      snapshot: Ref.get(state),
    }
  })
