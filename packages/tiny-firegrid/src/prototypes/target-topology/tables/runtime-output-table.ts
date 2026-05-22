// tables/ — the runtime output row plane, split by POLARITY into a read tag and
// a write tag (the doc's `*Read` / `*Write` convention). The split is what makes
// "is this subscriber an observer or an authority?" visible in `R`:
//   - `R` mentions RuntimeAgentOutputRead  -> observer (Shape B / read side of C)
//   - `R` mentions RuntimeAgentOutputWrite -> authority for the output table.

import { Context, Effect, Layer, Stream } from "effect"
import type { RuntimeAgentOutputObservation } from "../events/index.ts"
import type { ProtoRuntimeError } from "../errors.ts"

// C6 read side: typed source + cursor + optional match. `initial` is the
// snapshot read at a cursor; `after` is the tail subscription strictly after it.
export interface RuntimeAgentOutputReadService {
  readonly initial: (
    contextId: string,
  ) => Effect.Effect<RuntimeAgentOutputObservation | undefined, ProtoRuntimeError>
  readonly after: (
    contextId: string,
    afterSequence: number,
  ) => Stream.Stream<RuntimeAgentOutputObservation, ProtoRuntimeError>
}

// Write side: the authority that appends output rows for one context.
export interface RuntimeAgentOutputWriteService {
  readonly append: (
    contextId: string,
    observation: RuntimeAgentOutputObservation,
  ) => Effect.Effect<void, ProtoRuntimeError>
}

export class RuntimeAgentOutputRead extends Context.Tag(
  "@proto/target-topology/RuntimeAgentOutputRead",
)<RuntimeAgentOutputRead, RuntimeAgentOutputReadService>() {}

export class RuntimeAgentOutputWrite extends Context.Tag(
  "@proto/target-topology/RuntimeAgentOutputWrite",
)<RuntimeAgentOutputWrite, RuntimeAgentOutputWriteService>() {}

// Prototype backings (production: the read journal + per-context writer Live
// layers over `RuntimeOutputTable`). Inert; present so the tags are providable.
export const RuntimeAgentOutputReadStubLayer: Layer.Layer<RuntimeAgentOutputRead> =
  Layer.succeed(RuntimeAgentOutputRead, {
    initial: () => Effect.succeed(undefined),
    after: () => Stream.empty,
  })

export const RuntimeAgentOutputWriteStubLayer: Layer.Layer<RuntimeAgentOutputWrite> =
  Layer.succeed(RuntimeAgentOutputWrite, {
    append: () => Effect.void,
  })
