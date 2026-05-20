import { Effect } from "effect"
import { runtimeToolUseExecutorContractResult } from "./host.ts"

export const runtimeToolUseExecutorContractDriver = Effect.tryPromise({
  try: () => runtimeToolUseExecutorContractResult,
  catch: error => error,
})
