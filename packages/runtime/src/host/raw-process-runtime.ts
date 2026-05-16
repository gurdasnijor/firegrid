import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Option, Stream } from "effect"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
} from "../runtime-errors.ts"
import type { RuntimeContextError } from "../runtime-errors.ts"
import {
  RuntimeEventAppendAndGet,
  RuntimeIngressDeliveryClaimAndComplete,
  RuntimeIngressAppenderLayer,
  RuntimeIngressDeliveryTrackerLayer,
  RuntimeIngressInputStream,
  RuntimeLogLineAppendAndGet,
  RuntimeOutputJournalLayer,
  runtimeIngressSubscriberId,
} from "../authorities/index.ts"
import { runCodecRuntimeEventPipeline } from "../pipeline/index.ts"
import {
  commandForContext,
  localProcessStdinDelivery,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../sources/sandbox/index.ts"
import { RuntimeHostConfig } from "./config.ts"
import { RuntimeCodecToolLoweringLayer } from "./runtime-substrate.ts"

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

const localProcessStdinSubscriberId = runtimeIngressSubscriberId("raw", "stdin")

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
}) =>
  Effect.gen(function* () {
    const toolLoweringLayer = yield* RuntimeCodecToolLoweringLayer
    return yield* runCodecRuntimeEventPipeline({
      context: options.context,
      activityAttempt: options.activityAttempt,
      protocol: options.protocol,
      toolLoweringLayer,
    })
  }).pipe(
    Effect.provide(RuntimeOutputJournalLayer),
    Effect.provide(RuntimeIngressAppenderLayer({
      currentContextId: options.context.contextId,
    })),
    Effect.provide(RuntimeIngressDeliveryTrackerLayer),
  )

export const runRuntimeContext = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3
  // firegrid-workflow-driven-runtime.BOUNDARIES.1
  Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const appendEvent = yield* RuntimeEventAppendAndGet
    const appendLog = yield* RuntimeLogLineAppendAndGet
    const ingressInputStream = yield* RuntimeIngressInputStream
    const ingressDelivery = yield* RuntimeIngressDeliveryClaimAndComplete
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

    const protocol = agentProtocolForContext(context)
    if (protocol !== "raw") {
      return yield* runCodecRuntimeContext({
        context,
        activityAttempt,
        protocol,
      })
    }

    const command = yield* commandForContext(context)
    const stdin = hostConfig.inputEnabled
      ? localProcessStdinDelivery({
        contextId: context.contextId,
        subscriberId: localProcessStdinSubscriberId,
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
        Stream.provideService(RuntimeIngressDeliveryClaimAndComplete, ingressDelivery),
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
  })
