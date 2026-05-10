import { NodeContext } from "@effect/platform-node"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/durable-streams/workflow-engine"
import { Context, Effect, Layer } from "effect"
import {
  RuntimeContextWorkflowLayer,
} from "../runtime-context/workflow.ts"
import {
  RuntimeControlPlaneLive,
} from "../runtime-context/service.ts"
import {
  startRuntimeContext,
  type StartRuntimeContextOptions,
  type StartRuntimeResult,
} from "../runtime-context/launcher.ts"
import type {
  RuntimeContextError,
} from "../runtime-context/errors.ts"
import {
  LocalProcessSandboxProvider,
} from "../providers/sandboxes/index.ts"
import {
  RuntimeCaptureJournalLive,
} from "../runtime-output/writer.ts"
import {
  asRuntimeContextError,
} from "../runtime-context/errors.ts"
import {
  RuntimeIngress,
  RuntimeIngressLive,
  RuntimeIngressUnavailableLive,
  type RuntimeIngressError,
  type RuntimeIngressRequest,
  type RuntimeIngressRequestedRow,
} from "../runtime-ingress/index.ts"

export interface RuntimeHostStreams {
  readonly workflow: string
  readonly controlPlane: string
  readonly runtimeOutput: string
  readonly runtimeIngress?: string
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
  readonly ingress: (
    request: RuntimeIngressRequest,
  ) => Effect.Effect<RuntimeIngressRequestedRow, RuntimeIngressError>
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
    Layer.provide(options.streams.runtimeIngress === undefined
      ? RuntimeIngressUnavailableLive
      : RuntimeIngressLive({
        streamUrl: options.streams.runtimeIngress,
      })),
    Layer.provide(LocalProcessSandboxProvider.layer()),
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
      ingress: request =>
        // firegrid-agent-ingress.HOST.1
        // firegrid-agent-ingress.HOST.2
        RuntimeIngress.pipe(
          Effect.flatMap(ingress => ingress.append(request)),
          Effect.provide(options.streams.runtimeIngress === undefined
            ? RuntimeIngressUnavailableLive
            : RuntimeIngressLive({
              streamUrl: options.streams.runtimeIngress,
            })),
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

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
): Effect.Effect<RuntimeIngressRequestedRow, RuntimeIngressError, FiregridRuntimeHost> =>
  // firegrid-agent-ingress.HOST.1
  FiregridRuntimeHost.pipe(
    Effect.flatMap(host => host.ingress(request)),
  )
