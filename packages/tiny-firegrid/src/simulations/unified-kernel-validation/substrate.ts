/**
 * Substrate composition — durable-streams + workflow engine + unified
 * tables + kernel command table. The "rebuild base" for the simulation.
 *
 * Each generation = one engine scope over the same set of durable
 * stream URLs. Closing a generation drops in-memory state (= process
 * death); a fresh layer over the same URLs reconstructs.
 *
 * `runGeneration` ALSO runs `replayPendingWriteArm` once after
 * registering the workflow catalog — that's how the kernel auto-recovers
 * parked bodies on restart without the test re-driving them.
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
  KernelCommandTable,
  type KernelCommandTableService,
  type KernelRowRewriter,
  type KernelWorkflowCatalog,
  replayPendingWriteArm,
  type ResumableWorkflow,
} from "./kernel.ts"
import { UnifiedTable, type UnifiedTableService } from "./tables.ts"

export interface GenerationUrls {
  readonly engineStreamUrl: string
  readonly unifiedTableStreamUrl: string
  readonly kernelTableStreamUrl: string
}

export interface GenerationServices {
  readonly engineTable: WorkflowEngineTableService
  readonly unified: UnifiedTableService
  readonly kernel: KernelCommandTableService
  readonly replayed: number
  readonly replaySkipped: number
}

export interface GenerationSetup {
  readonly urls: GenerationUrls
  /** Workflows to register with the engine for this generation. */
  readonly workflowLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>
  /** Catalog the kernel consults at replay. */
  readonly catalog: KernelWorkflowCatalog
  /** Optional per-command row rewriter used during replay. */
  readonly rewriter?: KernelRowRewriter
}

export const tableLayerFor = <T extends UnifiedTable | KernelCommandTable>(
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

const defaultRewriter: KernelRowRewriter = {
  forCommand: () => undefined,
}

const makeCatalog = (
  workflows: ReadonlyArray<ResumableWorkflow>,
): KernelWorkflowCatalog => {
  const map = new Map<string, ResumableWorkflow>()
  for (const wf of workflows) map.set(wf.name, wf)
  return {
    get: (name) => map.get(name),
  }
}

/**
 * Build a single generation's layer graph and run `program` inside it.
 * Runs the kernel replay sweep BEFORE `program` so the test sees the
 * post-recovery state directly.
 */
export const runGeneration = <A>(
  setup: GenerationSetup,
  program: (services: GenerationServices) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, unknown> => {
  const unifiedLayer = tableLayerFor(UnifiedTable, setup.urls.unifiedTableStreamUrl)
  const kernelLayer = tableLayerFor(KernelCommandTable, setup.urls.kernelTableStreamUrl)
  // All upper-tier layers (tables + workflow registrations) must be merged
  // BEFORE the engine is `provideMerge`d under them, so the workflow
  // layers' `WorkflowEngine` requirement is satisfied at the right tier.
  const upperLayers = setup.workflowLayers.reduce<
    Layer.Layer<unknown, unknown, unknown>
  >(
    (acc, wf) => Layer.merge(acc, wf),
    Layer.merge(unifiedLayer, kernelLayer) as Layer.Layer<unknown, unknown, unknown>,
  )
  const generationLayer = upperLayers.pipe(
    Layer.provideMerge(engineLayer(setup.urls.engineStreamUrl)),
  )
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      const unified = yield* UnifiedTable
      const kernel = yield* KernelCommandTable
      const replay = yield* replayPendingWriteArm({
        kernel,
        engineTable,
        catalog: setup.catalog,
        rewriter: setup.rewriter ?? defaultRewriter,
      })
      const services: GenerationServices = {
        engineTable,
        unified,
        kernel,
        replayed: replay.replayed,
        replaySkipped: replay.skipped,
      }
      return yield* program(services)
    }).pipe(
      Effect.provide(generationLayer as Layer.Layer<
        WorkflowEngine.WorkflowEngine | WorkflowEngineTable | UnifiedTable | KernelCommandTable,
        unknown,
        never
      >),
    ),
  ) as Effect.Effect<A, unknown>
}

export { makeCatalog }
