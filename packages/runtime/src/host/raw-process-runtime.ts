import {
  RuntimeOutputTable,
  hostOwnedStreamUrl,
  runtimeContextOutputStreamUrl,
} from "@firegrid/protocol/launch"
import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Option, Stream } from "effect"
import {
  RuntimeContextError,
  asRuntimeContextError,
  mapRuntimeContextError,
} from "../runtime-errors.ts"
import {
  RuntimeEventAppendAndGet,
  RuntimeLogLineAppendAndGet,
  RuntimeOutputJournalLayer,
} from "../agent-event-pipeline/authorities/runtime-output-journal.ts"
import {
  RuntimeIngressAppenderLayer,
  RuntimeIngressInputStream,
} from "../agent-event-pipeline/authorities/runtime-ingress-appender.ts"
import {
  RuntimeIngressDeliveryTrackerLayer,
} from "../agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts"
import { runCodecRuntimeEventPipeline } from "../agent-event-pipeline/session-runtime.ts"
import {
  commandForContext,
  localProcessStdinDelivery,
  SandboxStdinEmissionClaim,
  SandboxStdinEmissionClaimLive,
  SandboxSupervisorCommandTable,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../agent-event-pipeline/sources/sandbox/index.ts"
import { RuntimeHostConfig } from "./config.ts"

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

const runtimeContextOutputTableLayer = (
  hostConfig: RuntimeHostConfig["Type"],
  context: RuntimeContext,
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: hostConfig.durableStreamsBaseUrl,
        prefix: context.host.streamPrefix,
        contextId: context.contextId,
      }),
      contentType: "application/json",
      ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
    },
  })

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
}) =>
  runCodecRuntimeEventPipeline({
    context: options.context,
    activityAttempt: options.activityAttempt,
    protocol: options.protocol,
  }).pipe(
    Effect.provide(RuntimeOutputJournalLayer),
    Effect.provide(runtimeContextOutputTableLayer(options.hostConfig, options.context)),
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
    const outputLayer = runtimeContextOutputTableLayer(hostConfig, context)
    const sandboxCommandLayer = sandboxSupervisorCommandTableLayer(hostConfig, context)

    const protocol = agentProtocolForContext(context)
    if (protocol !== "raw") {
      return yield* runCodecRuntimeContext({
        context,
        activityAttempt,
        protocol,
        hostConfig,
      })
    }

    return yield* Effect.gen(function* () {
      const appendEvent = yield* RuntimeEventAppendAndGet
      const appendLog = yield* RuntimeLogLineAppendAndGet
      const ingressInputStream = yield* RuntimeIngressInputStream
      const stdinEmissionClaim = yield* SandboxStdinEmissionClaim
      const writeOutputChunk = (
        sequence: number,
        chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
      ) =>
        outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
          Effect.flatMap((row) => {
            if (row.source === "stdout") {
              return appendEvent.append(row).pipe(Effect.asVoid)
            }
            return appendLog.append(row).pipe(Effect.asVoid)
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
      Effect.provide(RuntimeOutputJournalLayer),
      Effect.provide(outputLayer),
      Effect.provide(SandboxStdinEmissionClaimLive),
      Effect.provide(sandboxCommandLayer),
      Effect.scoped,
      mapRuntimeContextSurfaceError(context.contextId),
    )
  })
