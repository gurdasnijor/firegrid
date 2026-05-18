import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  runtimeContextWorkflowStreamUrl,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  runtimeInputIntentToRuntimeIngressRequest,
  type RuntimeIngressInputRow,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "@firegrid/runtime/workflow-engine"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "@firegrid/runtime/errors"
import { Context, Effect, Exit, Layer, Option, Ref, Scope, Stream } from "effect"
import { RuntimeHostConfig } from "./config.ts"
import { appendRuntimeInputDeferred } from "./runtime-input-deferred.ts"

export interface ActiveRuntimeContextEngine {
  readonly context: RuntimeContext
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly table: WorkflowEngineTable["Type"]
  readonly scope: Scope.CloseableScope
}

interface RuntimeContextEngineRegistryService {
  readonly startOrAttach: (
    context: RuntimeContext,
  ) => Effect.Effect<ActiveRuntimeContextEngine, RuntimeContextError>
  readonly claimActive: (
    context: RuntimeContext,
  ) => Effect.Effect<ActiveRuntimeContextEngine, RuntimeContextError>
  readonly get: (
    contextId: string,
  ) => Effect.Effect<Option.Option<ActiveRuntimeContextEngine>>
  readonly reconcile: (
    context: RuntimeContext,
  ) => Effect.Effect<void, RuntimeContextError>
  readonly dispatchIntent: (
    intent: RuntimeInputIntentRow,
  ) => Effect.Effect<Option.Option<RuntimeIngressInputRow>, RuntimeContextError>
  readonly deregister: (contextId: string) => Effect.Effect<void>
  readonly activeContextIds: Effect.Effect<ReadonlyArray<string>>
}

export class RuntimeContextEngineRegistry extends Context.Tag(
  "@firegrid/host-sdk/RuntimeContextEngineRegistry",
)<RuntimeContextEngineRegistry, RuntimeContextEngineRegistryService>() {}

const runtimeInputIntentOrder = (
  left: RuntimeInputIntentRow,
  right: RuntimeInputIntentRow,
) => {
  const created = left.createdAt.localeCompare(right.createdAt)
  return created === 0 ? left.intentId.localeCompare(right.intentId) : created
}

const provideActiveEngine = <A, E, R>(
  handle: ActiveRuntimeContextEngine,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E,
  Exclude<Exclude<R, WorkflowEngine.WorkflowEngine>, WorkflowEngineTable>
> =>
  effect.pipe(
    Effect.provideService(WorkflowEngine.WorkflowEngine, handle.engine),
    Effect.provideService(WorkflowEngineTable, handle.table),
  ) as Effect.Effect<
    A,
    E,
    Exclude<Exclude<R, WorkflowEngine.WorkflowEngine>, WorkflowEngineTable>
  >

const closeActiveEngine = (
  engines: Ref.Ref<Map<string, ActiveRuntimeContextEngine>>,
  contextId: string,
) =>
  Effect.gen(function*() {
    const handle = (yield* Ref.get(engines)).get(contextId)
    if (handle === undefined) return
    yield* Ref.update(engines, map => {
      const next = new Map(map)
      next.delete(contextId)
      return next
    })
    yield* Scope.close(handle.scope, Exit.void)
  })

const appendIntentToEngine = (
  handle: ActiveRuntimeContextEngine,
  intent: RuntimeInputIntentRow,
): Effect.Effect<RuntimeIngressInputRow, RuntimeContextError> =>
  provideActiveEngine(
    handle,
    appendRuntimeInputDeferred(
      runtimeInputIntentToRuntimeIngressRequest(intent),
      handle.context,
    ),
  ).pipe(
    Effect.mapError(cause =>
      asRuntimeContextError(
        "runtime-context.input-intent.dispatch",
        "failed dispatching runtime input intent to local per-context engine",
        intent.contextId,
        cause,
      )),
  )

export const RuntimeContextEngineRegistryLive = Layer.scoped(
  RuntimeContextEngineRegistry,
  Effect.gen(function*() {
    const config = yield* RuntimeHostConfig
    const hostSession = yield* CurrentHostSession
    const control = yield* RuntimeControlPlaneTable
    const engines = yield* Ref.make(new Map<string, ActiveRuntimeContextEngine>())

    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        const current = yield* Ref.get(engines)
        yield* Effect.forEach(
          current.values(),
          handle => Scope.close(handle.scope, Exit.void),
          { discard: true },
        )
        yield* Ref.set(engines, new Map())
      }))

    const claimActive = (
      context: RuntimeContext,
    ): Effect.Effect<ActiveRuntimeContextEngine, RuntimeContextError> =>
      Effect.gen(function*() {
        const current = yield* Ref.get(engines)
        const existing = current.get(context.contextId)
        if (existing !== undefined) return existing
        if (context.host.hostId !== hostSession.hostId) {
          return yield* Effect.fail(asRuntimeContextError(
            "runtime-context.engine.claim",
            "runtime context is not owned by this host",
            context.contextId,
            { hostId: context.host.hostId, currentHostId: hostSession.hostId },
          ))
        }
        const engineScope = yield* Scope.make()
        const engineContext = yield* Layer.buildWithScope(
          DurableStreamsWorkflowEngine.layer({
            streamUrl: runtimeContextWorkflowStreamUrl({
              baseUrl: config.durableStreamsBaseUrl,
              namespace: config.namespace,
              contextId: context.contextId,
            }),
            ...(config.headers === undefined ? {} : { headers: config.headers }),
          }),
          engineScope,
        ).pipe(
          mapRuntimeContextError(
            "runtime-context.engine.layer",
            "failed provisioning per-context workflow engine",
            context.contextId,
          ),
        )
        const handle: ActiveRuntimeContextEngine = {
          context,
          engine: Context.get(engineContext, WorkflowEngine.WorkflowEngine),
          table: Context.get(engineContext, WorkflowEngineTable),
          scope: engineScope,
        }
        yield* Ref.update(engines, map => new Map([...map, [context.contextId, handle]]))
        return handle
      })

    const startOrAttach = (
      context: RuntimeContext,
    ): Effect.Effect<ActiveRuntimeContextEngine, RuntimeContextError> =>
      Effect.gen(function*() {
        const handle = yield* claimActive(context)
        yield* reconcile(context)
        return handle
      })

    const get = (
      contextId: string,
    ): Effect.Effect<Option.Option<ActiveRuntimeContextEngine>> =>
      Ref.get(engines).pipe(
        Effect.map(map => Option.fromNullable(map.get(contextId))),
      )

    const reconcile = (
      context: RuntimeContext,
    ): Effect.Effect<void, RuntimeContextError> =>
      Effect.gen(function*() {
        const handle = yield* claimActive(context)
        const intents = yield* control.inputIntents.query((coll) =>
          coll.toArray
            .filter(intent => intent.contextId === context.contextId)
            .sort(runtimeInputIntentOrder)).pipe(
          mapRuntimeContextError(
            "runtime-context.input-intent.reconcile",
            "failed reading runtime input intents for startup reconciliation",
            context.contextId,
          ),
        )
        yield* Effect.forEach(intents, intent => appendIntentToEngine(handle, intent), {
          discard: true,
        })
      })

    const dispatchIntent = (
      intent: RuntimeInputIntentRow,
    ): Effect.Effect<Option.Option<RuntimeIngressInputRow>, RuntimeContextError> =>
      Effect.gen(function*() {
        const handle = yield* get(intent.contextId)
        if (Option.isNone(handle)) return Option.none()
        return Option.some(yield* appendIntentToEngine(handle.value, intent))
      })

    return RuntimeContextEngineRegistry.of({
      startOrAttach,
      claimActive,
      get,
      reconcile,
      dispatchIntent,
      deregister: contextId => closeActiveEngine(engines, contextId),
      activeContextIds: Ref.get(engines).pipe(
        Effect.map(map => [...map.keys()]),
      ),
    })
  }),
)

export const RuntimeInputIntentDispatcherLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    const registry = yield* RuntimeContextEngineRegistry
    yield* table.inputIntents.rows().pipe(
      Stream.runForEach(intent =>
        registry.dispatchIntent(intent).pipe(
          Effect.catchAll(cause =>
            Effect.logError("[host-sdk] runtime input intent dispatch failed").pipe(
              Effect.annotateLogs({ contextId: intent.contextId, intentId: intent.intentId, cause }),
            )),
        )),
      Effect.forkScoped,
    )
  }),
)
