import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  hostOwnedStreamUrl,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  runtimeInputIntentToRuntimeIngressRequest,
  type RuntimeIngressInputRow,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import {
  appendRuntimeInputDeferred,
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "@firegrid/runtime/workflow-engine"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "@firegrid/runtime/errors"
import { Context, Effect, Exit, Layer, Option, Ref, Scope, Stream, type Tracer } from "effect"
import { RuntimeHostConfig } from "./config.ts"
import {
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"

interface ActiveRuntimeContextExecution {
  readonly context: RuntimeContext
  readonly executionId: string
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly table: WorkflowEngineTable["Type"]
}

export interface RuntimeContextWorkflowCheckpointHandle {
  readonly context: RuntimeContext
  readonly executionId: string
  readonly table: WorkflowEngineTable["Type"]
}

interface RuntimeContextWorkflowRuntimeService {
  readonly ensureActive: (
    context: RuntimeContext,
  ) => Effect.Effect<void, RuntimeContextError>
  readonly run: <A, E, R, RLayer>(options: {
    readonly context: RuntimeContext
    readonly workflowName: string
    readonly supportLayer: Layer.Layer<never, unknown, RLayer>
    readonly effect: Effect.Effect<A, E, R>
    readonly deregisterOnExit?: boolean | undefined
  }) => Effect.Effect<
    A,
    E | RuntimeContextError,
    | Exclude<R, WorkflowEngine.WorkflowEngine>
    | Exclude<
      Exclude<Exclude<RLayer, WorkflowEngine.WorkflowEngine>, WorkflowEngineTable>,
      Tracer.ParentSpan
    >
  >
  readonly deregister: (contextId: string) => Effect.Effect<void>
}

interface RuntimeContextInputService {
  readonly reconcile: (
    context: RuntimeContext,
  ) => Effect.Effect<void, RuntimeContextError>
  readonly dispatchIntent: (
    intent: RuntimeInputIntentRow,
  ) => Effect.Effect<Option.Option<RuntimeIngressInputRow>, RuntimeContextError>
}

interface RuntimeContextCheckpointSourceService {
  readonly get: (
    contextId: string,
  ) => Effect.Effect<Option.Option<RuntimeContextWorkflowCheckpointHandle>>
  readonly activeContextIds: Effect.Effect<ReadonlyArray<string>>
}

export class RuntimeContextWorkflowRuntime extends Context.Tag(
  "@firegrid/host-sdk/RuntimeContextWorkflowRuntime",
)<RuntimeContextWorkflowRuntime, RuntimeContextWorkflowRuntimeService>() {}

export class RuntimeContextInput extends Context.Tag(
  "@firegrid/host-sdk/RuntimeContextInput",
)<RuntimeContextInput, RuntimeContextInputService>() {}

export class RuntimeContextCheckpointSource extends Context.Tag(
  "@firegrid/host-sdk/RuntimeContextCheckpointSource",
)<RuntimeContextCheckpointSource, RuntimeContextCheckpointSourceService>() {}

const runtimeInputIntentOrder = (
  left: RuntimeInputIntentRow,
  right: RuntimeInputIntentRow,
) => {
  const created = left.createdAt.localeCompare(right.createdAt)
  return created === 0 ? left.intentId.localeCompare(right.intentId) : created
}

const provideActiveExecution = <A, E, R>(
  handle: ActiveRuntimeContextExecution,
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

const supportLayerWithHostEngine = <R>(
  handle: ActiveRuntimeContextExecution,
  layer: Layer.Layer<never, unknown, R>,
): Layer.Layer<
  never,
  unknown,
  Exclude<Exclude<R, WorkflowEngine.WorkflowEngine>, WorkflowEngineTable>
> =>
  layer.pipe(
    Layer.provideMerge(Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)),
    Layer.provideMerge(Layer.succeed(WorkflowEngineTable, handle.table)),
  ) as Layer.Layer<
    never,
    unknown,
    Exclude<Exclude<R, WorkflowEngine.WorkflowEngine>, WorkflowEngineTable>
  >

const deregisterActiveExecution = (
  executions: Ref.Ref<Map<string, ActiveRuntimeContextExecution>>,
  contextId: string,
) =>
  Effect.gen(function*() {
    yield* Ref.update(executions, map => {
      const next = new Map(map)
      next.delete(contextId)
      return next
    })
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.execution.deregister", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
  )

const appendIntentToExecution = (
  handle: ActiveRuntimeContextExecution,
  intent: RuntimeInputIntentRow,
): Effect.Effect<RuntimeIngressInputRow, RuntimeContextError> =>
  provideActiveExecution(
    handle,
    // firegrid-workflow-driven-runtime.BOUNDARIES.7-1
    appendRuntimeInputDeferred(
      runtimeInputIntentToRuntimeIngressRequest(intent),
      handle.context,
      intent._otel,
    ),
  ).pipe(
    Effect.mapError(cause =>
      asRuntimeContextError(
        "runtime-context.input-intent.dispatch",
        "failed dispatching runtime input intent to local host-scoped engine",
        intent.contextId,
        cause,
      )),
  ).pipe(
    Effect.withSpan("firegrid.host.runtime_context.input.append_intent", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": intent.contextId,
        "firegrid.input.intent_id": intent.intentId,
      },
    }),
  )

export const RuntimeContextWorkflowRuntimeLive = Layer.scopedContext(
  Effect.gen(function*() {
    const config = yield* RuntimeHostConfig
    const hostSession = yield* CurrentHostSession
    const control = yield* RuntimeControlPlaneTable
    const executions = yield* Ref.make(new Map<string, ActiveRuntimeContextExecution>())
    const engineScope = yield* Scope.make()
    // firegrid-workflow-driven-runtime.BOUNDARIES.6-1
    const engineContext = yield* Layer.buildWithScope(
      DurableStreamsWorkflowEngine.layer({
        streamUrl: hostOwnedStreamUrl({
          baseUrl: config.durableStreamsBaseUrl,
          prefix: hostSession.streamPrefix,
          segment: "workflow",
        }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      }),
      engineScope,
    ).pipe(
      mapRuntimeContextError(
        "runtime-context.engine.layer",
        "failed provisioning host-scoped workflow engine",
        hostSession.hostId,
      ),
    )
    const hostEngine = Context.get(engineContext, WorkflowEngine.WorkflowEngine)
    const hostTable = Context.get(engineContext, WorkflowEngineTable)
    const workflowSupportScope = yield* Scope.make()
    const workflowSupportRegistered = yield* Ref.make(new Set<string>())
    const workflowSupportLock = yield* Effect.makeSemaphore(1)

    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        yield* Ref.set(executions, new Map())
        yield* Scope.close(workflowSupportScope, Exit.void)
        yield* Scope.close(engineScope, Exit.void)
      }))

    const buildWorkflowSupport = <RLayer>(
      workflowName: string,
      contextId: string,
      handle: ActiveRuntimeContextExecution,
      layer: Layer.Layer<never, unknown, RLayer>,
    ): Effect.Effect<
      void,
      RuntimeContextError,
      Exclude<
        Exclude<Exclude<RLayer, WorkflowEngine.WorkflowEngine>, WorkflowEngineTable>,
        Tracer.ParentSpan
      >
    > =>
      workflowSupportLock.withPermits(1)(
        Effect.gen(function*() {
          const registered = yield* Ref.get(workflowSupportRegistered)
          if (registered.has(workflowName)) return
          yield* Layer.buildWithScope(
            supportLayerWithHostEngine(handle, layer),
            workflowSupportScope,
          ).pipe(
            mapRuntimeContextError(
              "runtime-context.workflow.register",
              "failed registering workflow support on host-scoped engine",
              contextId,
            ),
          )
          yield* Ref.update(workflowSupportRegistered, current => new Set([...current, workflowName]))
        }),
      ).pipe(
        Effect.withSpan("firegrid.host.runtime_context.engine.workflow_support", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": contextId,
            "firegrid.workflow.name": workflowName,
          },
        }),
      )

    const ensureActiveHandle = (
      context: RuntimeContext,
    ): Effect.Effect<ActiveRuntimeContextExecution, RuntimeContextError> =>
      Effect.gen(function*() {
        const current = yield* Ref.get(executions)
        const existing = current.get(context.contextId)
        if (existing !== undefined) {
          yield* Effect.annotateCurrentSpan({
            "firegrid.runtime_context.execution.existing": true,
          })
          return existing
        }
        yield* Effect.annotateCurrentSpan({
          "firegrid.runtime_context.execution.existing": false,
        })
        if (context.host.hostId !== hostSession.hostId) {
          return yield* Effect.fail(asRuntimeContextError(
            "runtime-context.execution.ensure",
            "runtime context is not owned by this host",
            context.contextId,
            { hostId: context.host.hostId, currentHostId: hostSession.hostId },
          ))
        }
        const handle: ActiveRuntimeContextExecution = {
          context,
          executionId: runtimeContextWorkflowExecutionId(context.contextId),
          engine: hostEngine,
          table: hostTable,
        }
        yield* Ref.update(executions, map => new Map([...map, [context.contextId, handle]]))
        return handle
      }).pipe(
        Effect.withSpan("firegrid.host.runtime_context.execution.ensure_active", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": context.contextId,
            "firegrid.host.id": hostSession.hostId,
            "firegrid.workflow.execution_id": runtimeContextWorkflowExecutionId(context.contextId),
          },
        }),
      )

    const get = (
      contextId: string,
    ): Effect.Effect<Option.Option<ActiveRuntimeContextExecution>> =>
      Ref.get(executions).pipe(
        Effect.map(map => Option.fromNullable(map.get(contextId))),
      )

    const reconcile = (
      context: RuntimeContext,
    ): Effect.Effect<void, RuntimeContextError> =>
      Effect.gen(function*() {
        const handle = yield* ensureActiveHandle(context)
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
        yield* Effect.annotateCurrentSpan({
          "firegrid.input.intent_count": intents.length,
        })
        yield* Effect.forEach(intents, intent => appendIntentToExecution(handle, intent), {
          discard: true,
        })
      }).pipe(
        Effect.withSpan("firegrid.host.runtime_context.input.reconcile", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": context.contextId,
          },
        }),
      )

    const dispatchIntent = (
      intent: RuntimeInputIntentRow,
    ): Effect.Effect<Option.Option<RuntimeIngressInputRow>, RuntimeContextError> =>
      Effect.gen(function*() {
        const handle = yield* get(intent.contextId)
        if (Option.isNone(handle)) {
          yield* Effect.annotateCurrentSpan({
            "firegrid.runtime_context.engine.active": false,
          })
          return Option.none()
        }
        yield* Effect.annotateCurrentSpan({
          "firegrid.runtime_context.execution.active": true,
        })
        return Option.some(yield* appendIntentToExecution(handle.value, intent))
      }).pipe(
        Effect.withSpan("firegrid.host.runtime_context.input.dispatch_intent", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": intent.contextId,
            "firegrid.input.intent_id": intent.intentId,
          },
        }),
      )

    const run: RuntimeContextWorkflowRuntimeService["run"] = options =>
      Effect.gen(function*() {
        const handle = yield* ensureActiveHandle(options.context)
        yield* reconcile(options.context)
        yield* buildWorkflowSupport(
          options.workflowName,
          options.context.contextId,
          handle,
          options.supportLayer,
        )
        return yield* options.effect.pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, handle.engine),
        )
      }).pipe(
        Effect.ensuring(
          options.deregisterOnExit === true
            ? deregisterActiveExecution(executions, options.context.contextId)
            : Effect.void,
        ),
      )

    const checkpointGet: RuntimeContextCheckpointSourceService["get"] = contextId =>
      get(contextId).pipe(
        Effect.map(Option.map(handle => ({
          context: handle.context,
          executionId: handle.executionId,
          table: handle.table,
        }))),
      )

    return Context.make(RuntimeContextWorkflowRuntime, {
      ensureActive: context => ensureActiveHandle(context).pipe(Effect.asVoid),
      run,
      deregister: contextId => deregisterActiveExecution(executions, contextId),
    }).pipe(
      Context.add(RuntimeContextInput, {
        reconcile,
        dispatchIntent,
      }),
      Context.add(RuntimeContextCheckpointSource, {
        get: checkpointGet,
        activeContextIds: Ref.get(executions).pipe(
          Effect.map(map => [...map.keys()]),
        ),
      }),
    )
  }),
)

export const RuntimeInputIntentDispatcherLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    const input = yield* RuntimeContextInput
    // firegrid-workflow-driven-runtime.BOUNDARIES.7
    yield* table.inputIntents.rows().pipe(
      Stream.withSpan("firegrid.host.runtime_input_intent.dispatcher", {
        kind: "internal",
      }),
      Stream.runForEach(intent =>
        input.dispatchIntent(intent).pipe(
          Effect.catchAll(cause =>
            Effect.logError("[host-sdk] runtime input intent dispatch failed").pipe(
              Effect.annotateLogs({ contextId: intent.contextId, intentId: intent.intentId, cause }),
            )),
        )),
      Effect.forkScoped,
    )
  }),
)
