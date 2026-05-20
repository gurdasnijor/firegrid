import { Effect } from "effect"
import { inv3RestartReplayResult } from "./host.ts"

export const inv3RestartReplayDriver = Effect.tryPromise({
  try: () => inv3RestartReplayResult,
  catch: error => error,
})
