/**
 * Substrate composition — durable-streams + workflow engine + unified
 * tables + signal primitive. The "rebuild base" for the simulation.
 *
 * Each generation = one engine scope over the same set of durable
 * stream URLs. Closing a generation drops in-memory state (= process
 * death); a fresh layer over the same URLs reconstructs.
 *
 * `runGeneration` runs `recoverPendingSignals` once after registering
 * the workflow catalog — that's how parked bodies wake up
 * automatically on restart without the test re-driving them.
 */

import {
  type WorkflowEngine,
} from "@effect/workflow"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Effect, Layer } from "effect"
import {
  recoverPendingSignals,
  type ResumableWorkflow,
  SignalTable,
  type SignalRowRewriter,
  type SignalTableService,
  type WorkflowCatalog,
} from "./signal.ts"
import { UnifiedTable, type UnifiedTableService } from "./tables.ts"

export interface GenerationUrls {
  readonly engineStreamUrl: string
  readonly unifiedTableStreamUrl: string
  readonly signalTableStreamUrl: string
}

export interface GenerationServices {
  readonly engineTable: WorkflowEngineTableService
  readonly unified: UnifiedTableService
  readonly signals: SignalTableService
  readonly replayed: number
  readonly replaySkipped: number
}

export interface GenerationSetup {
  readonly urls: GenerationUrls
  /**
   * Workflows to register with the engine for this generation. The
   * layer requirements (`RIn`) are widened to `any` because Layer is
   * contravariant in RIn — a layer requiring `WorkflowEngine | UnifiedTable
   * | SignalTable` is not assignable to a layer requiring `unknown`. The
   * substrate provides those services internally, so widening here is
   * safe; the actual layer merge below carries the requirements
   * through.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly workflowLayers: ReadonlyArray<Layer.Layer<never, unknown, any>>
  /** Catalog the signal primitive consults at recovery. */
  readonly catalog: WorkflowCatalog
  /**
   * Optional per-signal row rewriter. Only needed when a producer
   * delegated a companion row write to `sendSignal` (rare) and that
   * row write was lost mid-send. The common case — payload travels
   * in `payloadJson` — does not need a rewriter.
   */
  readonly rewriter?: SignalRowRewriter
}

const tableLayerFor = <T extends UnifiedTable | SignalTable>(
  cls: {
    layer: (options: {
      readonly streamOptions: {
        readonly url: string
        readonly contentType: string
      }
      readonly txTimeoutMs?: number
    }) => Layer.Layer<T, unknown, never>
  },
  url: string,
): Layer.Layer<T, unknown, never> =>
  cls.layer({
    streamOptions: { url, contentType: "application/json" },
    txTimeoutMs: 2_000,
  })

const engineLayer = (url: string) =>
  DurableStreamsWorkflowEngine.layer({ streamUrl: url })

const makeCatalog = (
  workflows: ReadonlyArray<ResumableWorkflow>,
): WorkflowCatalog => {
  const map = new Map<string, ResumableWorkflow>()
  for (const wf of workflows) map.set(wf.name, wf)
  return {
    get: (name) => map.get(name),
  }
}

/**
 * Build a single generation's layer graph and run `program` inside it.
 * Runs the signal recovery sweep BEFORE `program` so the test sees
 * the post-recovery state directly.
 */
export const runGeneration = <A>(
  setup: GenerationSetup,
  program: (services: GenerationServices) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, unknown> => {
  const unifiedLayer = tableLayerFor(UnifiedTable, setup.urls.unifiedTableStreamUrl)
  const signalLayer = tableLayerFor(SignalTable, setup.urls.signalTableStreamUrl)
  const upperLayers = setup.workflowLayers.reduce<
    Layer.Layer<unknown, unknown, unknown>
  >(
    (acc, wf) => Layer.merge(acc, wf),
    Layer.merge(unifiedLayer, signalLayer) as Layer.Layer<unknown, unknown, unknown>,
  )
  const generationLayer = upperLayers.pipe(
    Layer.provideMerge(engineLayer(setup.urls.engineStreamUrl)),
  )
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      const unified = yield* UnifiedTable
      const signals = yield* SignalTable
      const recovery = yield* recoverPendingSignals({
        signals,
        engineTable,
        catalog: setup.catalog,
        ...(setup.rewriter !== undefined ? { rewriter: setup.rewriter } : {}),
      })
      const services: GenerationServices = {
        engineTable,
        unified,
        signals,
        replayed: recovery.replayed,
        replaySkipped: recovery.skipped,
      }
      return yield* program(services)
    }).pipe(
      Effect.provide(generationLayer as Layer.Layer<
        WorkflowEngine.WorkflowEngine | WorkflowEngineTable | UnifiedTable | SignalTable,
        unknown,
        never
      >),
    ),
  ) as Effect.Effect<A, unknown>
}

export { makeCatalog, tableLayerFor }
