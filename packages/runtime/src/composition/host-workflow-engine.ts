// Host-scoped WorkflowEngine provider — canonical runtime composition.
//
// Replaces the engine-binding half of the retired kernel runtime wrapper.
// Surfaces only the substrate Tags (`WorkflowEngine.WorkflowEngine` +
// `WorkflowEngineTable`); no per-context dispatcher, no checkpoint, no
// body driver. This file is composition/ so it owns layer/topology
// wiring per the canonical target tree
// (`2026-05-22-runtime-physical-target-tree.md` §Composition Boundary).
//
// Required services (filled by host-sdk at composition time):
//   - `RuntimeHostConfig`  — durable-streams base URL + headers
//   - `CurrentHostSession` — host stream prefix
//
// Provides:
//   - `WorkflowEngine.WorkflowEngine`
//   - `WorkflowEngineTable`
//
// Host-sdk install order: `HostWorkflowEngineLive` must be provide-merged
// DOWNSTREAM of any layer that requires `WorkflowEngine` (e.g.
// `ToolDispatchLive`, `ScheduledPromptWorkflowLayer`). Effect's
// `Layer.provideMerge` semantics: the layer applied later in a `.pipe()`
// chain is the deeper provider, so later in the chain == satisfies the
// requirements of earlier layers in the chain.

import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  hostOwnedStreamUrl,
} from "@firegrid/protocol/launch"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { RuntimeHostConfig } from "../channels/runtime-host-config.ts"
import {
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../runtime-errors.ts"
// Composition reaches the engine substrate at its canonical home under
// `engine/`, per the tf-z8wq target-tree amendment (see
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md` §"Logical
// Order And Import Direction" — `engine/` is a leaf-tier substrate
// sibling of `events/`, importable by Shape D `subscribers/` and by
// `composition/`). The prior `workflow-engine/`-resident substrate residue
// + the `composition/host-workflow-engine.ts` exact-file dep-cruiser
// carve-out for `runtime-composition-no-legacy-tree-import` were retired
// in this slice.
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "../engine/durable-streams-workflow-engine.ts"

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- DurableStreamsWorkflowEngine.layer still leaks any through substrate layers; the declared Layer R/ROut channel is the intended capability boundary (same carve-out the retired kernel runtime wrapper used).
export const HostWorkflowEngineLive: Layer.Layer<
  WorkflowEngine.WorkflowEngine | WorkflowEngineTable,
  RuntimeContextError,
  RuntimeHostConfig | CurrentHostSession
> = Layer.scopedContext(
  Effect.gen(function*() {
    const config = yield* RuntimeHostConfig
    const hostSession = yield* CurrentHostSession
    const engineScope = yield* Scope.make()
    // `DurableStreamsWorkflowEngine.layer` is typed `Layer<any, …>` per
    // the existing substrate-leak documented elsewhere; cast the
    // buildWithScope result to the narrow Context shape so consumers see
    // the precise Tag outputs. The narrow cast matches the declared
    // `HostWorkflowEngineLive` ROut and is the same pattern the retired
    // kernel runtime wrapper used internally.
    const engineContext: Context.Context<
      WorkflowEngine.WorkflowEngine | WorkflowEngineTable
    > = yield* Layer.buildWithScope(
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
    yield* Effect.addFinalizer(() => Scope.close(engineScope, Exit.void))
    return Context.make(WorkflowEngine.WorkflowEngine, hostEngine).pipe(
      Context.add(WorkflowEngineTable, hostTable),
    )
  }),
)
