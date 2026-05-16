import { Effect, Layer } from "effect"
import {
  RuntimeAgentOutputEvents,
  RuntimeOutputEvents,
  RuntimeOutputLogs,
} from "../agent-event-pipeline/authorities/runtime-output-journal.ts"
import { RuntimeAuthoritySourceNames } from "../authorities/source-names.ts"
import {
  SourceCollections,
  sourceCollectionStreamHandle,
} from "../waits/source-registration.ts"

export const RuntimeOutputSourceRegistrationsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registrations = yield* SourceCollections
    const runtimeOutputEvents = yield* RuntimeOutputEvents
    const runtimeOutputLogs = yield* RuntimeOutputLogs
    const runtimeAgentOutputEvents = yield* RuntimeAgentOutputEvents

    yield* registrations.register(sourceCollectionStreamHandle(
      RuntimeAuthoritySourceNames.runtimeOutputEvents,
      runtimeOutputEvents,
    ))
    yield* registrations.register(sourceCollectionStreamHandle(
      RuntimeAuthoritySourceNames.runtimeOutputLogs,
      runtimeOutputLogs,
    ))
    yield* registrations.register(sourceCollectionStreamHandle(
      RuntimeAuthoritySourceNames.agentOutputEvents,
      runtimeAgentOutputEvents,
    ))
  }),
)
