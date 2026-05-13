import type { HttpClient } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import {
  RuntimeContextSchema,
  makeRuntimeRunEvent,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { RuntimeControlPlaneTable } from "@firegrid/protocol/launch"
import {
  LocalProcessSandboxProvider,
  SandboxProvider,
  commandForContext,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../providers/sandboxes/index.ts"
import {
  appendRuntimeIngressRequestToTable,
  localProcessStdinForRuntimeIngress,
  sequenceRuntimeIngressInputs,
} from "../runtime-ingress/table-delivery.ts"
import { makeRuntimeOutputJournal } from "../runtime-output/journal.ts"
import {
  asRuntimeContextError,
  RuntimeIngressError,
  type RuntimeContextError,
  runtimeIngressError,
} from "./errors.ts"

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

const trimRightSlash = (value: string): string => value.replace(/\/+$/, "")

const encodeStreamName = (namespace: string, name: string): string =>
  encodeURIComponent(`${namespace}.${name}`)

const runtimeHostStreamUrl = (
  durableStreamsBaseUrl: string,
  namespace: string,
  name: string,
): string =>
  `${trimRightSlash(durableStreamsBaseUrl)}/v1/stream/${encodeStreamName(namespace, name)}`

export {
  RuntimeIngressError,
}

interface RuntimeHostConfigValue {
  readonly runtimeOutputStreamUrl: string
  readonly inputEnabled: boolean
}

export interface StartRuntimeOptions {
  readonly contextId: string
}

export interface StartRuntimeResult {
  readonly contextId: string
  readonly activityAttempt: number
  readonly exitCode: number
  readonly signal?: string
}

export interface RuntimeHostTopologyOptions {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly input?: boolean
}

export class RuntimeHostConfig extends Context.Tag("firegrid/runtime/RuntimeHostConfig")<
  RuntimeHostConfig,
  RuntimeHostConfigValue
>() {}

const mapTableError = (
  op: string,
  message: string,
  contextId: string,
) =>
  Effect.mapError((cause: DurableTableError) =>
    asRuntimeContextError(op, message, contextId, cause))

const runRuntimeContext = (
  request: StartRuntimeOptions,
): Effect.Effect<
  StartRuntimeResult,
  RuntimeContextError,
  RuntimeHostConfig | RuntimeControlPlaneTable | RuntimeIngressTable | SandboxProvider | HttpClient.HttpClient
> => {
  const program = Effect.gen(function* () {
    const options = yield* RuntimeHostConfig
    const table = yield* RuntimeControlPlaneTable
    const maybeContext = yield* table.contexts.get(request.contextId).pipe(
      mapTableError(
        "runtime-control-plane.contexts.get",
        "failed to read runtime context row",
        request.contextId,
      ),
    )
    const context = yield* Option.match(maybeContext, {
      onNone: () =>
        Effect.fail(asRuntimeContextError(
          "runtime-control-plane.contexts.get",
          `runtime context not found: ${request.contextId}`,
          request.contextId,
        )),
      onSome: row =>
        Effect.mapError(
          Schema.decodeUnknown(RuntimeContextSchema)(row),
          cause => asRuntimeContextError(
            "runtime-control-plane.contexts.decode",
            "failed to decode runtime context row",
            request.contextId,
            cause,
          ),
        ),
    })
    const activityAttempt = 1
    // Runtime output is intentionally the raw-stream exception: an append-only
    // process fact journal, not table/query state.
    const outputJournal = yield* makeRuntimeOutputJournal(
      options.runtimeOutputStreamUrl,
      context,
      activityAttempt,
    )
    const command = yield* commandForContext(context)
    const ingressTable = yield* RuntimeIngressTable
    const stdin = options.inputEnabled
      ? localProcessStdinForRuntimeIngress(context.contextId).pipe(
        Stream.provideService(RuntimeIngressTable, ingressTable),
      )
      : undefined
    const inputSequencer = options.inputEnabled
      ? yield* sequenceRuntimeIngressInputs(context.contextId).pipe(
        Stream.runDrain,
        Effect.forkScoped,
      )
      : undefined
    void inputSequencer

    const provider = yield* SandboxProvider
    const sandbox = yield* Effect.acquireRelease(
      provider.getOrCreate({
        labels: {
          firegridRuntimeContextId: context.contextId,
        },
        ...(context.runtime.config.cwd === undefined ? {} : { workingDir: context.runtime.config.cwd }),
        providerConfig: {
          contextId: context.contextId,
        },
      }).pipe(
        Effect.mapError((cause: SandboxProviderError) =>
          asRuntimeContextError(`sandbox.${cause.op}`, cause.message, context.contextId, cause)),
      ),
      sandbox => provider.destroy(sandbox).pipe(Effect.ignore),
    )

    yield* table.runs.upsert(makeRuntimeRunEvent({
      contextId: context.contextId,
      activityAttempt,
      provider: context.runtime.provider,
      status: "started",
    })).pipe(
      mapTableError(
        "runtime-control-plane.runs.started",
        "failed to append runtime started row",
        context.contextId,
      ),
    )

    const appendFailed = (
      message: string,
    ) =>
      table.runs.upsert(makeRuntimeRunEvent({
        contextId: context.contextId,
        activityAttempt,
        provider: context.runtime.provider,
        status: "failed",
        message,
      })).pipe(
        mapTableError(
          "runtime-control-plane.runs.failed",
          "failed to append runtime failed row",
          context.contextId,
        ),
      )

    const providerCommand = {
      ...command,
      ...(stdin === undefined ? {} : { stdin }),
    }
    return yield* provider.stream(sandbox, providerCommand).pipe(
      Stream.mapError((cause: SandboxProviderError) =>
        asRuntimeContextError(`sandbox.${cause.op}`, cause.message, context.contextId, cause)),
      Stream.mapAccum(0, (sequence, chunk): readonly [number, SequencedChunk] => [
        sequence + 1,
        { sequence, chunk },
      ]),
      Stream.tap(({ chunk, sequence }) =>
        chunk.type === "exit"
          ? Effect.void
          : outputJournal.appendChunk(sequence, chunk)),
      Stream.filter((item): item is SequencedChunk & {
        readonly sequence: number
        readonly chunk: Extract<ProcessOutputChunk, { readonly type: "exit" }>
      } =>
        item.chunk.type === "exit",
      ),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(asRuntimeContextError(
            "sandbox.stream",
            "process stream ended without an exit chunk",
            context.contextId,
          )),
        onSome: ({ chunk: exit }) =>
          outputJournal.flush.pipe(
            Effect.zipRight(table.runs.upsert(makeRuntimeRunEvent({
              contextId: context.contextId,
              activityAttempt,
              provider: context.runtime.provider,
              status: "exited",
              exitCode: exit.exitCode,
              ...(exit.signal === undefined ? {} : { signal: exit.signal }),
            })).pipe(
              mapTableError(
                "runtime-control-plane.runs.exited",
                "failed to append runtime exited row",
                context.contextId,
              ),
            )),
            Effect.as({
              contextId: context.contextId,
              activityAttempt,
              exitCode: exit.exitCode,
              ...(exit.signal === undefined ? {} : { signal: exit.signal }),
            }),
          ),
      })),
      Effect.catchAll(error =>
        outputJournal.flush.pipe(
          Effect.ignore,
          Effect.zipRight(appendFailed(error.message)),
          Effect.zipRight(Effect.fail(error)),
        ),
      ),
    )
  })
  return program as Effect.Effect<
    StartRuntimeResult,
    RuntimeContextError,
    RuntimeHostConfig | RuntimeControlPlaneTable | RuntimeIngressTable | SandboxProvider | HttpClient.HttpClient
  >
}

const runtimeHostLayerFromOptions = (
  options: RuntimeHostConfigValue,
  controlPlaneTableUrl: string,
  ingressTableUrl: string,
) => {
  return Layer.mergeAll(
    Layer.succeed(RuntimeHostConfig, options),
    RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: controlPlaneTableUrl,
        contentType: "application/json",
      },
    }),
    RuntimeIngressTable.layer({
      streamOptions: {
        url: ingressTableUrl,
        contentType: "application/json",
      },
    }),
    LocalProcessSandboxProvider.layer().pipe(
      Layer.provide(NodeContext.layer),
    ),
  )
}

export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
) => {
  const controlPlaneTableUrl = runtimeHostStreamUrl(options.durableStreamsBaseUrl, options.namespace, "firegrid.runtime")
  const ingressTableUrl = runtimeHostStreamUrl(options.durableStreamsBaseUrl, options.namespace, "firegrid.runtimeIngress")
  return runtimeHostLayerFromOptions({
    // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.12
    runtimeOutputStreamUrl: runtimeHostStreamUrl(options.durableStreamsBaseUrl, options.namespace, "firegrid.runtimeOutput"),
    // firegrid-agent-ingress.HOST.7
    inputEnabled: options.input === true,
  }, controlPlaneTableUrl, ingressTableUrl)
}

export const startRuntime = (
  options: StartRuntimeOptions,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, RuntimeHostConfig | RuntimeControlPlaneTable | RuntimeIngressTable | SandboxProvider | HttpClient.HttpClient> =>
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
  Effect.scoped(runRuntimeContext(options))

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
): Effect.Effect<RuntimeIngressInputRow, RuntimeIngressError, RuntimeHostConfig | RuntimeIngressTable> =>
  Effect.gen(function* () {
    const options = yield* RuntimeHostConfig
    if (!options.inputEnabled) {
      return yield* runtimeIngressError(
        "append",
        "runtime ingress table is not configured",
        request.contextId,
        request.inputId,
      )
    }
    return yield* appendRuntimeIngressRequestToTable(request)
  })
