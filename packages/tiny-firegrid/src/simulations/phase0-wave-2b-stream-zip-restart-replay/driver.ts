import { Effect } from "effect"
import { phase0Wave2BResult } from "./host.ts"

export const phase0Wave2BDriver = Effect.tryPromise({
  try: () => phase0Wave2BResult,
  catch: error => error,
})
