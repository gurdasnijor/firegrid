import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  runtimeInputIntentToRuntimeIngressRequest,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer, Option, Stream } from "effect"
import { RuntimeHostConfig } from "./config.ts"
import { appendRuntimeIngressToOwner } from "./commands.ts"

const isOwnedByHost = (
  context: RuntimeContext,
  hostSession: CurrentHostSession["Type"],
): boolean => context.host.hostId === hostSession.hostId

const processRuntimeInputIntent = (
  intent: RuntimeInputIntentRow,
) =>
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    const hostSession = yield* CurrentHostSession
    const config = yield* RuntimeHostConfig
    const context = yield* table.contexts.get(intent.contextId)
    if (Option.isNone(context) || !isOwnedByHost(context.value, hostSession)) {
      return
    }
    yield* appendRuntimeIngressToOwner(
      runtimeInputIntentToRuntimeIngressRequest(intent),
      context.value,
      config,
    )
  })

const startRuntimeInputControlRouter = Effect.gen(function*() {
  const table = yield* RuntimeControlPlaneTable
  yield* table.inputIntents.rows().pipe(
    Stream.runForEach(intent =>
      processRuntimeInputIntent(intent).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    ),
    Effect.forkScoped,
  )
})

export const RuntimeInputControlRouterLive = Layer.scopedDiscard(
  startRuntimeInputControlRouter,
)
