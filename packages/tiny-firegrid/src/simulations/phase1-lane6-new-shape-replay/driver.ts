import { Effect } from "effect"
import { phase1Lane6ReplayResult } from "./host.ts"

export const phase1Lane6NewShapeReplayDriver = Effect.tryPromise({
  try: () => phase1Lane6ReplayResult,
  catch: (error) => error,
})
