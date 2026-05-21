import { Clock, Effect } from "effect"

export const authorityNowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)
