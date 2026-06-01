import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
} from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import {
  CodecOutputJournalTag,
  ContextResolverTag,
} from "./codec-adapter-tags.ts"

export const CodecOutputJournalFromRuntimeOutputTableLive = Layer.effect(
  CodecOutputJournalTag,
  Effect.gen(function*() {
    const table = yield* RuntimeOutputTable
    return {
      append: (row) => table.events.insertOrGet(row).pipe(Effect.asVoid),
    }
  }),
)

export const ContextResolverFromControlPlaneTableLive = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId) => control.contexts.get(contextId),
    }
  }),
)
