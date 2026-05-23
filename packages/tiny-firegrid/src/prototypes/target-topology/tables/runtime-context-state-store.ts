// tables/ — durable state-of-record capability tags (the C1 keyed state plane).
//
// In production these are backed by `DurableTable(...)` from
// effect-durable-operators. The prototype keeps the *capability tag* and the
// service interface — that is what the `R` channel of a subscriber names — and
// leaves the durable backing to a stub layer in composition/. The topology
// proof is about which subscriber names which tag, not about the table engine.

import { Context, Effect, Layer } from "effect"
import type { RuntimeContext } from "../events/index.ts"
import type { ProtoRuntimeError } from "../errors.ts"

// The durable per-context reducer state. Production: `RuntimeContextEventState`.
export interface RuntimeContextEventState {
  readonly contextId: string
  readonly lastInputSequence: number
  readonly lastOutputSequence: number
  readonly pendingToolUseIds: ReadonlyArray<string>
}

// C1 + C7: keyed durable state for one `contextId`, read/written by load/save.
// `nextOutput` is the sparse forward point-get (C6) the subscriber uses instead
// of scanning dense raw output.
export interface RuntimeContextStateStoreService {
  readonly load: (
    context: RuntimeContext,
  ) => Effect.Effect<RuntimeContextEventState, ProtoRuntimeError>
  readonly save: (
    context: RuntimeContext,
    state: RuntimeContextEventState,
  ) => Effect.Effect<void, ProtoRuntimeError>
  readonly nextOutputSequence: (
    context: RuntimeContext,
    afterSequence: number,
  ) => Effect.Effect<number, ProtoRuntimeError>
}

// The capability tag a Shape C subscriber names in `R` to declare it OWNS
// durable state for the `contextId` key kind.
export class RuntimeContextStateStore extends Context.Tag(
  "@proto/target-topology/RuntimeContextStateStore",
)<RuntimeContextStateStore, RuntimeContextStateStoreService>() {}

// Prototype backing. Production ships `RuntimeContextStateStoreLive` over a
// `DurableTable`. The topology proof only needs a value of the service type so
// the tag is providable in composition; behavior is intentionally inert.
export const RuntimeContextStateStoreStubLayer: Layer.Layer<RuntimeContextStateStore> =
  Layer.succeed(RuntimeContextStateStore, {
    load: (context) =>
      Effect.succeed({
        contextId: context.contextId,
        lastInputSequence: -1,
        lastOutputSequence: -1,
        pendingToolUseIds: [],
      }),
    save: () => Effect.void,
    nextOutputSequence: (_context, afterSequence) =>
      Effect.succeed(afterSequence + 1),
  })
