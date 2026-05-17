import {
  hostOwnedStreamUrl,
} from "@firegrid/protocol/launch"
import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Layer, Option, Sink, Stream } from "effect"
import {
  RuntimeContextError,
  asRuntimeContextError,
  mapRuntimeContextError,
} from "@firegrid/runtime/host-substrate"
import {
  RuntimeAgentOutputEventsLayer,
  RuntimeAgentOutputRowSink,
  RuntimeLogLineAppendAndGet,
} from "@firegrid/runtime/host-substrate"
import {
  RuntimeIngressAppenderLayer,
  RuntimeIngressInputStream,
} from "@firegrid/runtime/host-substrate"
import {
  RuntimeIngressDeliveryTrackerLayer,
} from "@firegrid/runtime/host-substrate"
import { runCodecRuntimeEventPipeline } from "@firegrid/runtime/host-substrate"
import {
  commandForContext,
  localProcessStdinDelivery,
  SandboxStdinEmissionClaim,
  SandboxStdinEmissionClaimLive,
  SandboxSupervisorCommandTable,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "@firegrid/runtime/sources/sandbox"
import { RuntimeHostConfig } from "./config.ts"
import {
  PerContextRuntimeOutputWriter,
  perContextRuntimeOutputTableLayer,
} from "./per-context-runtime-output.ts"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.1
// Raw local-process execution and output-row construction live outside the
// host barrel; RuntimeContextWorkflow calls this module as the activity effect.
type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

type RuntimeOutputRow = RuntimeEventRow | RuntimeLogLineRow

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const mapRuntimeContextSurfaceError = (
  contextId: string,
) =>
  Effect.mapError((cause: unknown) =>
    cause instanceof RuntimeContextError
      ? cause
      : asRuntimeContextError(
        "runtime-context.surfaces",
        "failed to initialize runtime context durable surfaces",
        contextId,
        cause,
      ))

const sandboxSupervisorCommandTableLayer = (
  hostConfig: RuntimeHostConfig["Type"],
  context: RuntimeContext,
) =>
  SandboxSupervisorCommandTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: hostConfig.durableStreamsBaseUrl,
        prefix: context.host.streamPrefix,
        segment: "durableTools",
      }),
      contentType: "application/json",
      ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
    },
  })

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
    const rowBase = {
      contextId: context.contextId,
      activityAttempt,
      sequence,
      receivedAt,
    }
    if (rule.target === "events" && rule.format === "jsonl" && chunk.channel === "stdout") {
      return {
        ...rowBase,
        eventId: {
          contextId: context.contextId,
          activityAttempt,
          target: "events",
          sequence,
        },
        source: "stdout",
        format: "jsonl",
        raw: chunk.text,
      }
    }

    if (rule.target === "logs" && rule.format === "text-lines" && chunk.channel === "stderr") {
      return {
        ...rowBase,
        logLineId: {
          contextId: context.contextId,
          activityAttempt,
          target: "logs",
          sequence,
        },
        source: "stderr",
        format: "text-lines",
        raw: chunk.text,
      }
    }

    return yield* Effect.fail(asRuntimeContextError(
      "runtime-output.invalid-journal-rule",
      `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
      context.contextId,
    ))
  })

const agentProtocolForContext = (
  context: RuntimeContext,
): RuntimeAgentProtocol => context.runtime.config.agentProtocol ?? "raw"

const runCodecRuntimeContext = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly protocol: Exclude<RuntimeAgentProtocol, "raw">
  readonly hostConfig: RuntimeHostConfig["Type"]
  readonly outputServicesLayer: Layer.Layer<
    RuntimeLogLineAppendAndGet | RuntimeAgentOutputRowSink
  >
}) =>
  runCodecRuntimeEventPipeline({
    context: options.context,
    activityAttempt: options.activityAttempt,
    protocol: options.protocol,
  }).pipe(
    Effect.provide(options.outputServicesLayer),
    Effect.provide(RuntimeAgentOutputEventsLayer),
    Effect.provide(perContextRuntimeOutputTableLayer(options.hostConfig, options.context)),
    Effect.provide(RuntimeIngressAppenderLayer({
      currentContextId: options.context.contextId,
    })),
    Effect.provide(RuntimeIngressDeliveryTrackerLayer),
    mapRuntimeContextSurfaceError(options.context.contextId),
  )

export const runRuntimeContext = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3
  // firegrid-workflow-driven-runtime.BOUNDARIES.1
  Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const outputWriter = yield* PerContextRuntimeOutputWriter
    const outputLayer = perContextRuntimeOutputTableLayer(hostConfig, context)
    const outputServicesLayer = Layer.mergeAll(
      Layer.succeed(
        RuntimeLogLineAppendAndGet,
        RuntimeLogLineAppendAndGet.of({
          append: row => outputWriter.appendLogLine(context, row),
        }),
      ),
      Layer.succeed(
        RuntimeAgentOutputRowSink,
        RuntimeAgentOutputRowSink.of(
          Sink.forEach((row: RuntimeEventRow) =>
            outputWriter.appendEventRow(context, row).pipe(Effect.asVoid)),
        ),
      ),
    )
    const sandboxCommandLayer = sandboxSupervisorCommandTableLayer(hostConfig, context)

    const protocol = agentProtocolForContext(context)
    if (protocol !== "raw") {
      return yield* runCodecRuntimeContext({
        context,
        activityAttempt,
        protocol,
        hostConfig,
        outputServicesLayer,
      })
    }

    return yield* Effect.gen(function* () {
      const ingressInputStream = yield* RuntimeIngressInputStream
      const stdinEmissionClaim = yield* SandboxStdinEmissionClaim
      const writeOutputChunk = (
        sequence: number,
        chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
      ) =>
        outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
          Effect.flatMap((row) => {
            if (row.source === "stdout") {
              return outputWriter.appendEventRow(context, row).pipe(Effect.asVoid)
            }
            return outputWriter.appendLogLine(context, row).pipe(Effect.asVoid)
          }),
          mapRuntimeContextError(
            "runtime-output.write",
            "failed to write runtime data-plane row",
            context.contextId,
          ),
        )

      const command = yield* commandForContext(context)
      const stdin = hostConfig.inputEnabled
        ? localProcessStdinDelivery({
          contextId: context.contextId,
        }).pipe(
          // firegrid-workflow-driven-runtime.BOUNDARIES.5
          Stream.mapError(cause =>
            asRuntimeContextError(
              `runtime-ingress.${cause.op}`,
              cause.message,
              context.contextId,
              cause,
          )),
          Stream.provideService(RuntimeIngressInputStream, ingressInputStream),
          Stream.provideService(SandboxStdinEmissionClaim, stdinEmissionClaim),
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
        Stream.mapError((cause: SandboxProviderError) => {
          const op = `sandbox.${cause.op}`
          return asRuntimeContextError(op, cause.message, context.contextId, cause)
        }),
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
      )
    }).pipe(
      Effect.provide(outputServicesLayer),
      Effect.provide(outputLayer),
      Effect.provide(SandboxStdinEmissionClaimLive),
      Effect.provide(sandboxCommandLayer),
      Effect.scoped,
      mapRuntimeContextSurfaceError(context.contextId),
    )
  })
