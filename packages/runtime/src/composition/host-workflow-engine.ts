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
import { RuntimeHostConfig } from "../kernel/runtime-host-config.ts"
import {
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../runtime-errors.ts"
// Substrate residue carve-out (per OLA reviewer #726 clarification on
// blocker 3, option b): `DurableStreamsWorkflowEngine` + its engine
// internals physically remain under `workflow-engine/` pending a
// mechanical physical move into the canonical `engine/` tier defined by
// the tf-z8wq target-tree amendment (merged commit 45d3642f;
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
// describes the canonical `engine/` substrate tier). The substrate is
// `workflow-engine/`-resident
// **residue**, not new ownership of the legacy root. Composition
// reaches it through a narrow exact-file carve-out in
// `.dependency-cruiser.cjs` + `test/composition/host-live.test.ts`.
//
// RETIREMENT BEAD: tf-z8wq. Once the engine substrate physically moves
// into the amended `engine/` tier, this import retargets and the
// carve-out shrinks to a deletion.
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "../workflow-engine/DurableStreamsWorkflowEngine.ts"

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
