/* eslint-disable @effect/no-import-from-barrel-package -- firegrid-platform-invariants.PUBLIC_SURFACE.1 */
import {
  FiregridClient,
  FiregridClientLive,
  type FiregridClientConfig,
} from "@firegrid/client"
/* eslint-enable @effect/no-import-from-barrel-package */
import { Effect, Fiber, Stream } from "effect"
import {
  detailForSession,
  makeSessionId,
  makeTurnId,
  SessionEvents,
  SessionTurn,
  summarizeSessions,
  type SessionDetail,
  type SessionEvent,
  type SessionSummary,
} from "../shared/protocol.ts"

export interface FlamecastClient {
  readonly sendTurn: (input: {
    readonly sessionId?: string
    readonly message: string
    readonly ordinal: number
  }) => Promise<{ readonly sessionId: string; readonly handleId: string }>
  readonly watchEvents: (
    onEvent: (event: SessionEvent) => void,
    onError: (error: unknown) => void,
  ) => () => void
}

const layerFor = (cfg: FiregridClientConfig) => FiregridClientLive(cfg)

export const createFlamecastClient = (
  cfg: FiregridClientConfig,
): FlamecastClient => ({
  sendTurn: async (input) => {
    const sessionId = input.sessionId ?? makeSessionId()
    const turnId = makeTurnId()
    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        return yield* client.send(SessionTurn, {
          sessionId,
          turnId,
          message: input.message,
          ordinal: input.ordinal,
        })
      }).pipe(Effect.provide(layerFor(cfg))),
    )
    return { sessionId, handleId: handle.id }
  },
  watchEvents: (onEvent, onError) => {
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        yield* client.events(SessionEvents).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
        )
      }).pipe(Effect.provide(layerFor(cfg))),
    )
    void Effect.runPromise(fiber.await).catch(onError)
    return () => {
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  },
})

export const sessionsFromEvents = summarizeSessions
export const sessionDetailFromEvents = detailForSession
export type { SessionDetail, SessionEvent, SessionSummary }
