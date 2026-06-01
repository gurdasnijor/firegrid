import {
  type RuntimeContext,
  type RuntimeEventRow,
} from "@firegrid/protocol/launch"
import { Context, type Effect, type Option } from "effect"

export interface ContextResolver {
  readonly resolve: (
    contextId: string,
  ) => Effect.Effect<Option.Option<RuntimeContext>, unknown>
}

export class ContextResolverTag extends Context.Tag(
  "@firegrid/runtime/unified/ContextResolver",
)<ContextResolverTag, ContextResolver>() {}

export interface CodecOutputJournal {
  readonly append: (
    row: RuntimeEventRow,
  ) => Effect.Effect<void, unknown>
}

export class CodecOutputJournalTag extends Context.Tag(
  "@firegrid/runtime/unified/CodecOutputJournal",
)<CodecOutputJournalTag, CodecOutputJournal>() {}
