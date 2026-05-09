import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import { Effect, Layer } from "effect"
import type { SandboxProvider } from "../../data-plane/execution/sandbox/sandbox.ts"
import {
  asRuntimeContextError,
} from "./errors.ts"
import type { RuntimeContextError } from "./errors.ts"
import {
  RuntimeContextWorkflowLayer,
  RuntimeContextWorkflow,
} from "./workflow.ts"
import {
  RuntimeControlPlaneLive,
} from "./service.ts"
import {
  RuntimeCaptureJournalLive,
} from "../../data-plane/runtime-output/writer.ts"
import {
  layerDurableStreams,
} from "../workflow-engine/workflows.ts"

export interface StartRuntimeOptions {
  readonly runtimeStreamUrl: string
  readonly controlPlaneStreamUrl?: string
  readonly dataPlaneStreamUrl?: string
  readonly workflowStreamUrl?: string
  readonly contextId: string
  readonly workerId?: string
}

export interface StartRuntimeResult {
  readonly contextId: string
  readonly activityAttempt: number
  readonly exitCode: number
}

const runtimeContextLayer = (
  options: StartRuntimeOptions,
) =>
  RuntimeContextWorkflowLayer.pipe(
    Layer.provideMerge(layerDurableStreams({
      streamUrl: options.workflowStreamUrl ?? options.controlPlaneStreamUrl ?? options.runtimeStreamUrl,
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    })),
    Layer.provide(RuntimeControlPlaneLive({
      streamUrl: options.controlPlaneStreamUrl ?? options.runtimeStreamUrl,
    })),
    Layer.provide(RuntimeCaptureJournalLive({
      streamUrl: options.dataPlaneStreamUrl ?? options.runtimeStreamUrl,
    })),
  )

export const startRuntime = (
  options: StartRuntimeOptions,
): Effect.Effect<
  StartRuntimeResult,
  RuntimeContextError,
  CommandExecutor | SandboxProvider
> =>
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.3
  RuntimeContextWorkflow.execute({ contextId: options.contextId }).pipe(
    Effect.provide(runtimeContextLayer(options)),
    Effect.catchTags({
      RuntimeControlPlaneError: cause =>
        Effect.fail(asRuntimeContextError(
          `runtime-control-plane.${cause.op}`,
          "failed to initialize runtime control plane",
          options.contextId,
          cause,
        )),
      WorkflowStateStoreError: cause =>
        Effect.fail(asRuntimeContextError(
          `workflow-state.${cause.op}`,
          "failed to run runtime context workflow state",
          options.contextId,
          cause,
        )),
    }),
    Effect.map(result => ({
      contextId: result.contextId,
      activityAttempt: result.activityAttempt,
      exitCode: result.exitCode,
    })),
  )
