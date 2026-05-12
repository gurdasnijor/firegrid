import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/durable-streams/workflow-engine"
import { Context, Effect, Layer } from "effect"
import { DurableStream } from "effect-durable-streams"
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
  asRuntimeContextError,
} from "../runtime-context/errors.ts"
import {
  type RuntimeIngressError,
  type RuntimeIngressRequest,
  type RuntimeIngressRequestedRow,
  type RuntimeIngressRow,
  RuntimeIngressRowSchema,
  runtimeIngressError,
} from "../runtime-ingress/index.ts"
import {
  makeRuntimeIngressRequestedRow,
} from "../runtime-ingress/rows.ts"

export interface RuntimeHostStreams {
  readonly workflow: string
  readonly controlPlane: string
  readonly runtimeOutput: string
  readonly runtimeIngress?: string
  /**
   * Durable stream URL that backs the runtime-input `DurableConsumer`
   * checkpoint records. Owned by
   * `effect-durable-operators.ConsumerCheckpointStoreLive`; the host
   * never writes to it directly. Required whenever `runtimeIngress` is
   * set — ingress without a checkpoint stream is treated as no-ingress.
   */
  readonly inputCheckpoints?: string
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

const appendRuntimeIngressRequested = (
  streamUrl: string,
  row: RuntimeIngressRow,
): Effect.Effect<void, RuntimeIngressError, HttpClient.HttpClient> =>
  // effect-native-production-cutover.RUNTIME_IO.2
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: RuntimeIngressRowSchema,
  }).append(row).pipe(
    Effect.asVoid,
    Effect.mapError(cause =>
      runtimeIngressError(
        "append",
        "failed to append runtime ingress durable row",
        row.contextId,
        row.ingressId,
        cause,
      )),
  )

const appendRuntimeIngressRequestToStream = (
  streamUrl: string,
  request: RuntimeIngressRequest,
): Effect.Effect<RuntimeIngressRequestedRow, RuntimeIngressError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const row = makeRuntimeIngressRequestedRow(request)
    // firegrid-agent-ingress.INGRESS.1
    // firegrid-agent-ingress.INGRESS.3
    // firegrid-agent-ingress.INGRESS.6
    // firegrid-agent-ingress.HOST.1
    yield* appendRuntimeIngressRequested(streamUrl, row)
    return row
  })

const runtimeContextLayer = (
  options: RuntimeHostOptions,
) =>
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.1
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.2
  // effect-native-production-cutover.RUNTIME_IO.4
  RuntimeContextWorkflowLayer({
    runtimeOutputStreamUrl: options.streams.runtimeOutput,
    ...(options.streams.runtimeIngress === undefined ? {} : { runtimeIngressStreamUrl: options.streams.runtimeIngress }),
    ...(options.streams.inputCheckpoints === undefined ? {} : { inputCheckpointsStreamUrl: options.streams.inputCheckpoints }),
  }).pipe(
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: options.streams.workflow,
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    })),
    Layer.provide(RuntimeControlPlaneLive({
      streamUrl: options.streams.controlPlane,
    })),
    Layer.provide(LocalProcessSandboxProvider.layer()),
    Layer.provide(FetchHttpClient.layer),
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
        options.streams.runtimeIngress === undefined
          ? Effect.fail(runtimeIngressError(
            "append",
            "runtime ingress stream is not configured",
            request.contextId,
            request.ingressId,
          ))
          : appendRuntimeIngressRequestToStream(
            options.streams.runtimeIngress,
            request,
          ).pipe(Effect.provide(FetchHttpClient.layer)),
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
