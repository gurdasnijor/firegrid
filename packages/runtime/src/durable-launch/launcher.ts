import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { WorkflowEngine } from "@effect/workflow"
import { Effect, Layer } from "effect"
import type { SandboxProvider } from "./execution/sandbox.ts"
import {
  asLaunchError,
} from "./errors.ts"
import type { RuntimeLaunchError } from "./errors.ts"
import {
  LaunchAgentWorkflow,
  LaunchAgentWorkflowLayer,
} from "./workflow.ts"
import type { LaunchTerminalState } from "./schema.ts"
import { RuntimeLaunchDbLive } from "./store.ts"
import {
  layerDurableStreams,
} from "../durable-workflow/workflows.ts"

export interface RunLaunchOnceOptions {
  readonly launchStreamUrl: string
  readonly workflowStreamUrl?: string
  readonly launchId: string
  readonly workerId?: string
}

export interface RunLaunchOnceResult {
  readonly launchId: string
  readonly activityAttempt: number
  readonly exitCode: number
}

const runObservedLaunch = (
  launchId: string,
): Effect.Effect<
  LaunchTerminalState,
  RuntimeLaunchError,
  WorkflowEngine.WorkflowEngine
> =>
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.3
  LaunchAgentWorkflow.execute({ launchId })

const launchRuntimeLayer = (
  options: RunLaunchOnceOptions,
) =>
  LaunchAgentWorkflowLayer.pipe(
    Layer.provideMerge(layerDurableStreams({
      streamUrl: options.workflowStreamUrl ?? options.launchStreamUrl,
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    })),
    Layer.provideMerge(RuntimeLaunchDbLive({
      streamUrl: options.launchStreamUrl,
    })),
  )

export const runLaunchOnce = (
  options: RunLaunchOnceOptions,
): Effect.Effect<
  RunLaunchOnceResult,
  RuntimeLaunchError,
  CommandExecutor | SandboxProvider
> =>
  runObservedLaunch(options.launchId).pipe(
    Effect.provide(launchRuntimeLayer(options)),
    Effect.catchTags({
      RuntimeLaunchDbError: cause =>
        Effect.fail(asLaunchError(
          `launch-db.${cause.op}`,
          "failed to initialize launch journal",
          options.launchId,
          cause,
        )),
      WorkflowStateStoreError: cause =>
        Effect.fail(asLaunchError(
          `workflow-state.${cause.op}`,
          "failed to run launch workflow state",
          options.launchId,
          cause,
        )),
    }),
    Effect.map(result => ({
      launchId: result.launchId,
      activityAttempt: result.activityAttempt,
      exitCode: result.exitCode,
    })),
  )
