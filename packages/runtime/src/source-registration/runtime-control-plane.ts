import { Effect, Layer } from "effect"
import {
  RuntimeContexts,
  RuntimeRuns,
} from "../authorities/runtime-control-plane-recorder.ts"
import { RuntimeAuthoritySourceNames } from "../authorities/source-names.ts"
import {
  SourceCollections,
  sourceCollectionStreamHandle,
} from "../waits/source-registration.ts"

export const RuntimeControlPlaneSourceRegistrationsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registrations = yield* SourceCollections
    const runtimeContexts = yield* RuntimeContexts
    const runtimeRuns = yield* RuntimeRuns

    yield* registrations.register(sourceCollectionStreamHandle(
      RuntimeAuthoritySourceNames.runtimeContexts,
      runtimeContexts,
    ))
    yield* registrations.register(sourceCollectionStreamHandle(
      RuntimeAuthoritySourceNames.runtimeRuns,
      runtimeRuns,
    ))
  }),
)
