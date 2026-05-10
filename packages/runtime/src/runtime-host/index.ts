import { NodeContext } from "@effect/platform-node"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/durable-streams"
import { Context, Effect, Layer } from "effect"
import {
  RuntimeContextWorkflowLayer,
} from "../control-plane/runtime-context/workflow.ts"
import {
  RuntimeControlPlaneLive,
} from "../control-plane/runtime-context/service.ts"
import {
  startRuntimeContext,
  type StartRuntimeContextOptions,
  type StartRuntimeResult,
} from "../control-plane/runtime-context/launcher.ts"
import type {
  RuntimeContextError,
} from "../control-plane/runtime-context/errors.ts"
import {
  LocalProcessSandboxProviderLive,
} from "../data-plane/execution/sandbox/providers/local-process.ts"
import {
  RuntimeCaptureJournalLive,
} from "../data-plane/runtime-output/writer.ts"
import {
  asRuntimeContextError,
} from "../control-plane/runtime-context/errors.ts"

export interface RuntimeHostStreams {
  readonly workflow: string
  readonly controlPlane: string
  readonly runtimeOutput: string
}

export interface RuntimeHostOptions {
  readonly streams: RuntimeHostStreams
  readonly workerId?: string
}

export type StartRuntimeOptions = StartRuntimeContextOptions

interface FiregridRuntimeHostService {
  readonly start: (
    options: StartRuntimeOptions,
  ) => Effect.Effect<StartRuntimeResult, RuntimeContextError>
}

export class FiregridRuntimeHost extends Context.Tag("firegrid/runtime/FiregridRuntimeHost")<
  FiregridRuntimeHost,
  FiregridRuntimeHostService
>() {}

const runtimeContextLayer = (
  options: RuntimeHostOptions,
) =>
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.1
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.2
  RuntimeContextWorkflowLayer.pipe(
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: options.streams.workflow,
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    })),
    Layer.provide(RuntimeControlPlaneLive({
      streamUrl: options.streams.controlPlane,
    })),
    Layer.provide(RuntimeCaptureJournalLive({
      streamUrl: options.streams.runtimeOutput,
    })),
    Layer.provide(LocalProcessSandboxProviderLive),
    Layer.provide(NodeContext.layer),
  )

export const FiregridRuntimeHostLive = (
  options: RuntimeHostOptions,
) =>
  Layer.succeed(
    FiregridRuntimeHost,
    FiregridRuntimeHost.of({
      start: request =>
        startRuntimeContext(request).pipe(
          Effect.provide(runtimeContextLayer(options)),
          Effect.catchTags({
            RuntimeControlPlaneError: cause =>
              Effect.fail(asRuntimeContextError(
                `runtime-control-plane.${cause.op}`,
                "failed to initialize runtime control plane",
                request.contextId,
                cause,
              )),
            WorkflowStateStoreError: cause =>
              Effect.fail(asRuntimeContextError(
                `workflow-state.${cause.op}`,
                "failed to run runtime context workflow state",
                request.contextId,
                cause,
              )),
          }),
        ),
    }),
  )

export const startRuntime = (
  options: StartRuntimeOptions,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, FiregridRuntimeHost> =>
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
  FiregridRuntimeHost.pipe(
    Effect.flatMap(host => host.start(options)),
  )
