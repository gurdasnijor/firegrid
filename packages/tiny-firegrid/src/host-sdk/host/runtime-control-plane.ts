import type { RuntimeContext } from "@firegrid/protocol/launch"
import type { RuntimeInputIntentRow } from "@firegrid/protocol/runtime-ingress"
import { Context, Effect, Layer } from "effect"
import type { DurableTableCollectionFacade } from "effect-durable-operators"
import { makeMemoryDurableCollectionFacade } from "../../effect-durable-operators/DurableTable.ts"

interface TinyRuntimeControlPlaneTableService {
  readonly contexts: DurableTableCollectionFacade<RuntimeContext, string>
  readonly inputIntents: DurableTableCollectionFacade<RuntimeInputIntentRow, string>
}

export class TinyRuntimeControlPlaneTable extends Context.Tag(
  "@firegrid/tiny-firegrid/TinyRuntimeControlPlaneTable",
)<TinyRuntimeControlPlaneTable, TinyRuntimeControlPlaneTableService>() {}

export const MemoryRuntimeControlPlaneTableLive = Layer.effect(
  TinyRuntimeControlPlaneTable,
  Effect.gen(function*() {
    const contexts = yield* makeMemoryDurableCollectionFacade<RuntimeContext, string>(
      row => row.contextId,
    )
    const inputIntents = yield* makeMemoryDurableCollectionFacade<RuntimeInputIntentRow, string>(
      row => row.intentId,
    )
    return { contexts, inputIntents }
  }),
)
