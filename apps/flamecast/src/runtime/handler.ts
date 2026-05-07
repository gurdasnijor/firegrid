import { Effect } from "effect"
import {
  makeFlamecastDb,
  runFlamecastProcessor,
} from "../shared/db.ts"

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
        return yield* runFlamecastProcessor(db)
      }),
    ),
    Effect.scoped,
  )
