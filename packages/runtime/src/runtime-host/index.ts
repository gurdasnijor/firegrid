import { NodeContext } from "@effect/platform-node"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Config, Effect, Layer, Option, Stream } from "effect"
import {
  LocalProcessSandboxProvider,
  commandForContext,
  localProcessStdinDelivery,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../providers/sandboxes/index.ts"
import {
  RuntimeIngressError,
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
  runtimeIngressError,
} from "./errors.ts"
import { RuntimeHostConfig } from "./config.ts"
import type {
  RuntimeHostConfigValue,
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
} from "./types.ts"

export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  RuntimeIngressError,
}

const trimRightSlash = (value: string): string => value.replace(/\/+$/, "")

const encodeStreamName = (namespace: string, name: string): string =>
  encodeURIComponent(`${namespace}.${name}`)

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

type RuntimeOutputRow = RuntimeEventRow | RuntimeLogLineRow

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const localProcessStdinSubscriberId = "runtime-context:local-process:stdin"

const outputRowFromProcessChunk = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<RuntimeOutputRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const rule = context.runtime.journal.find(candidate => candidate.source === chunk.channel)
    if (rule === undefined) {
      return yield* Effect.fail(asRuntimeContextError(
        "runtime-output.no-journal-rule",
        `no runtime journal rule for ${chunk.channel}`,
        context.contextId,
      ))
    }

    const receivedAt = yield* nowIso
    if (rule.target === "events" && rule.format === "jsonl" && chunk.channel === "stdout") {
      return {
        eventId: {
          contextId: context.contextId,
          activityAttempt,
          target: "events",
          sequence,
        },
        contextId: context.contextId,
        activityAttempt,
        sequence,
        source: "stdout",
        format: "jsonl",
        receivedAt,
        raw: chunk.text,
      }
    }

    if (rule.target === "logs" && rule.format === "text-lines" && chunk.channel === "stderr") {
      return {
        logLineId: {
          contextId: context.contextId,
          activityAttempt,
          target: "logs",
          sequence,
        },
        contextId: context.contextId,
        activityAttempt,
        sequence,
        source: "stderr",
        format: "text-lines",
        receivedAt,
        raw: chunk.text,
      }
    }

    return yield* Effect.fail(asRuntimeContextError(
      "runtime-output.invalid-journal-rule",
      `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
      context.contextId,
    ))
  })

const runtimeHostLayerFromOptions = (
  options: RuntimeHostConfigValue,
  controlPlaneTableUrl: string,
  ingressTableUrl: string,
  outputTableUrl: string,
) =>
  Layer.mergeAll(
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
    RuntimeOutputTable.layer({
      streamOptions: {
        url: outputTableUrl,
        contentType: "application/json",
      },
    }),
    LocalProcessSandboxProvider.layer().pipe(
      Layer.provide(NodeContext.layer),
    ),
  )

export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
) => {
  const baseUrl = trimRightSlash(options.durableStreamsBaseUrl)
  const streamUrl = (name: string): string =>
    `${baseUrl}/v1/stream/${encodeStreamName(options.namespace, name)}`
  return runtimeHostLayerFromOptions({
    // firegrid-agent-ingress.HOST.7
    inputEnabled: options.input === true,
  }, streamUrl("firegrid.runtime"), streamUrl("firegrid.runtimeIngress"), streamUrl("firegrid.runtimeOutput"))
}

export const FiregridRuntimeHostFromConfig = Layer.unwrapEffect(
  Effect.gen(function* () {
    const durableStreamsBaseUrl = yield* Config.string("DURABLE_STREAMS_BASE_URL")
    const namespace = yield* Config.string("FIREGRID_RUNTIME_NAMESPACE")
    const input = yield* Config.boolean("FIREGRID_RUNTIME_INPUT_ENABLED").pipe(
      Config.withDefault(false),
    )
    return FiregridRuntimeHostLive({
      durableStreamsBaseUrl,
      namespace,
      input,
    })
  }),
)

export const startRuntime = (
  options: StartRuntimeOptions,
) =>
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
  Effect.scoped(Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const table = yield* RuntimeControlPlaneTable
    const maybeContext = yield* table.contexts.get(options.contextId).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.contexts.get",
        "failed to read runtime context row",
        options.contextId,
      ),
    )
    const context = yield* Option.match(maybeContext, {
      onNone: () =>
        Effect.fail(asRuntimeContextError(
          "runtime-control-plane.contexts.get",
          `runtime context not found: ${options.contextId}`,
          options.contextId,
        )),
      onSome: row => Effect.succeed(row),
    })
    // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.7
    const activityAttempt = yield* table.runs.query((coll) =>
      coll.toArray
        .filter(row => row.contextId === context.contextId)
        .reduce((max, row) => Math.max(max, row.activityAttempt + 1), 1),
    ).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.allocate-attempt",
        "failed to allocate runtime activity attempt",
        context.contextId,
      ),
    )

    // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.7
    const startedAt = yield* nowIso
    yield* table.runs.upsert({
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "started",
      },
      contextId: context.contextId,
      activityAttempt,
      provider: context.runtime.provider,
      status: "started",
      at: startedAt,
    }).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.started",
        "failed to append runtime started row",
        context.contextId,
      ),
    )

    const appendFailed = (message: string) =>
      Effect.gen(function* () {
        const failedAt = yield* nowIso
        yield* table.runs.upsert({
          runEventId: {
            contextId: context.contextId,
            activityAttempt,
            status: "failed",
          },
          contextId: context.contextId,
          activityAttempt,
          status: "failed",
          provider: context.runtime.provider,
          message,
          at: failedAt,
        }).pipe(
          mapRuntimeContextError(
            "runtime-control-plane.runs.failed",
            "failed to append runtime failed row",
            context.contextId,
          ),
        )
      })

    const outputTable = yield* RuntimeOutputTable
    const writeOutputChunk = (
      sequence: number,
      chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
    ) =>
      outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
        Effect.flatMap(row =>
          row.source === "stdout"
            ? outputTable.events.upsert(row)
            : outputTable.logs.upsert(row)),
        mapRuntimeContextError(
          "runtime-output.write",
          "failed to write runtime data-plane row",
          context.contextId,
        ),
      )

    const command = yield* commandForContext(context)
    const ingressTable = yield* RuntimeIngressTable
    const stdin = hostConfig.inputEnabled
      ? localProcessStdinDelivery({
        contextId: context.contextId,
        subscriberId: localProcessStdinSubscriberId,
      }).pipe(
        Stream.mapError(cause =>
          asRuntimeContextError(
            `runtime-ingress.${cause.op}`,
            cause.message,
            context.contextId,
            cause,
          )),
        Stream.provideService(RuntimeIngressTable, ingressTable),
      )
      : undefined

    return yield* streamSandboxProcess({
      labels: {
        firegridRuntimeContextId: context.contextId,
      },
      ...(context.runtime.config.cwd === undefined ? {} : { workingDir: context.runtime.config.cwd }),
      providerConfig: {
        contextId: context.contextId,
      },
      command: {
        ...command,
        ...(stdin === undefined ? {} : { stdin }),
      },
    }).pipe(
      Stream.mapError((cause: SandboxProviderError) =>
        asRuntimeContextError(`sandbox.${cause.op}`, cause.message, context.contextId, cause)),
      Stream.mapAccum(0, (sequence, chunk): readonly [number, SequencedChunk] => [
        sequence + 1,
        { sequence, chunk },
      ]),
      Stream.tap(({ chunk, sequence }) =>
        chunk.type === "exit"
          ? Effect.void
          // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.7
          : writeOutputChunk(sequence, chunk)),
      Stream.filter((item): item is SequencedChunk & {
        readonly sequence: number
        readonly chunk: Extract<ProcessOutputChunk, { readonly type: "exit" }>
      } => item.chunk.type === "exit"),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(asRuntimeContextError(
            "sandbox.stream",
            "process stream ended without an exit chunk",
            context.contextId,
          )),
        onSome: ({ chunk }) =>
          Effect.succeed({
            exitCode: chunk.exitCode,
            ...(chunk.signal === undefined ? {} : { signal: chunk.signal }),
          }),
      })),
      Effect.flatMap(exit =>
        Effect.flatMap(nowIso, exitedAt =>
          table.runs.upsert({
            runEventId: {
              contextId: context.contextId,
              activityAttempt,
              status: "exited",
            },
            contextId: context.contextId,
            activityAttempt,
            status: "exited",
            provider: context.runtime.provider,
            at: exitedAt,
            exitCode: exit.exitCode,
            ...(exit.signal === undefined ? {} : { signal: exit.signal }),
          }).pipe(
            mapRuntimeContextError(
              "runtime-control-plane.runs.exited",
              "failed to append runtime exited row",
              context.contextId,
            ),
            Effect.as({
              contextId: context.contextId,
              activityAttempt,
              exitCode: exit.exitCode,
              ...(exit.signal === undefined ? {} : { signal: exit.signal }),
            }),
          ))),
      Effect.catchAll(error =>
        appendFailed(error.message).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    )
  }))

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
) =>
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
    const table = yield* RuntimeIngressTable
    const row = makeRuntimeIngressInputRow(request)
    const existing = yield* table.inputs.get(row.inputId).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to read runtime ingress durable row",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    if (Option.isSome(existing)) {
      return existing.value
    }

    // firegrid-agent-ingress.INGRESS.9
    const nextSequence = yield* table.inputs.query((coll) =>
      coll.toArray
        .filter(candidate => candidate.contextId === row.contextId)
        .reduce(
          (max, candidate) =>
            candidate.sequence === undefined ? max : Math.max(max, candidate.sequence + 1),
          0,
        ),
    ).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to query runtime ingress durable rows",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    const sequenced = {
      ...row,
      status: "sequenced" as const,
      sequence: nextSequence,
      sequencedAt: yield* nowIso,
    }
    // firegrid-agent-ingress.INGRESS.10
    yield* table.inputs.insert(sequenced).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to append runtime ingress durable row",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    return sequenced
  })
