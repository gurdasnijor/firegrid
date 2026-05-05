import { Effect } from "effect"
import type { StateEvent } from "@durable-streams/state"

export interface JsonAppendTarget {
  readonly append: (payload: string) => Promise<unknown>
}

// firegrid-remediation-hardening.CODE_REUSE.1
export const appendChange = <E>(
  target: JsonAppendTarget,
  change: StateEvent,
  mapError: (cause: unknown) => E,
): Effect.Effect<void, E> =>
  Effect.tryPromise({
    try: () => target.append(JSON.stringify(change)),
    catch: mapError,
  }).pipe(Effect.asVoid)
