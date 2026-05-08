import { Effect } from "effect"
import {
  makeFlamecastDb,
  processSubmittedTurns,
  waitForFlamecastChange,
} from "../shared/db.ts"
import { processAcceptedAgentsWebhooks } from "./agent-webhooks.ts"

export const runFlamecastRuntime = (
  streamUrl: string,
): Effect.Effect<never, unknown> =>
  Effect.acquireRelease(
    Effect.sync(() => makeFlamecastDb(streamUrl)),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.flatMap((db) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => db.preload(),
          catch: (cause) => cause,
        })
        while (true) {
          // stream-webhook-workflows.STREAM_INGRESS.2
          // stream-webhook-workflows.LOCAL_RUNTIME.1
          yield* processSubmittedTurns(db)
          yield* processAcceptedAgentsWebhooks(streamUrl, db)
          yield* waitForFlamecastChange(db)
        }
      }),
    ),
    Effect.scoped,
  )
