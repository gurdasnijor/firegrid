// Shape B: Projection. Read-only consumer of durable rows. Owns no state,
// writes nothing. `R` mentions ONLY a typed read source.
//
//   R = RuntimeAgentOutputRead
//
// If this consumer ever needed a state store, a `*Write` tag, or
// `WorkflowEngine`, the addition would show up in `R` and at the composition
// boundary — that is the shape boundary made visible.

import { Effect, Stream } from "effect"
import { RuntimeAgentOutputRead } from "../../tables/runtime-output-table.ts"
import type { ProtoRuntimeError } from "../../errors.ts"

export const projectionConsumer = (
  contextId: string,
): Effect.Effect<number, ProtoRuntimeError, RuntimeAgentOutputRead> =>
  Effect.gen(function* () {
    const read = yield* RuntimeAgentOutputRead
    // C6: snapshot at the cursor, then tail strictly after it.
    const snapshot = yield* read.initial(contextId)
    const after = snapshot?.sequence ?? -1
    return yield* read.after(contextId, after).pipe(
      Stream.runFold(0, (count) => count + 1),
    )
  })
