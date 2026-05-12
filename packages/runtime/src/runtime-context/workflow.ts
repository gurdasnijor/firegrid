import { Activity, Workflow } from "@effect/workflow"
import { FetchHttpClient } from "@effect/platform"
import {
  RuntimeJournalEventSchema,
  RuntimeContextSchema,
  type RuntimeContext,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeLogLine,
} from "@firegrid/protocol/launch"
import { Effect, Match, Option, Schema, Stream } from "effect"
import type { DurableStream } from "effect-durable-streams"
import { DurableStream as DurableStreamClient } from "effect-durable-streams"
import { commandForContext } from "./command.ts"
import {
  type RuntimeInputStreams,
} from "../runtime-host/input.ts"
import {
  localProcessStdinDelivery,
  RuntimeInputDeliveryTable,
  runtimeInputDeliveryLayer,
  SandboxProvider,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../providers/sandboxes/index.ts"
import {
  asRuntimeContextError,
  RuntimeContextError,
} from "./errors.ts"
import {
  RuntimeControlPlane,
} from "./service.ts"
import {
  ProcessAttemptResultSchema,
  RuntimeContextTerminalStateSchema,
} from "./schema.ts"
import {
  outputRowId,
} from "./ids.ts"

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

type RuntimeOutputRow = RuntimeEvent | RuntimeLogLine

const nowIso = (): string => new Date().toISOString()
const localProcessIngressSubscriberId = "runtime-context:local-process:stdin"

const runtimeJournalEventForOutput = (
  row: RuntimeOutputRow,
): RuntimeJournalEvent =>
  row.source === "stdout"
    ? {
      type: "firegrid.runtime.output.stdout",
      id: row.eventId,
      at: row.receivedAt,
      event: row,
    }
    : {
      type: "firegrid.runtime.output.stderr",
      id: row.logLineId,
      at: row.receivedAt,
      log: row,
    }

const mapRuntimeOutputError = (
  contextId: string,
) =>
  Effect.mapError((cause: DurableStream.ProducerFailure) =>
    asRuntimeContextError(
      "runtime-output.write",
      "failed to write runtime data-plane journal event",
      contextId,
      cause,
    ))


const outputRowFromChunk = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<RuntimeOutputRow, RuntimeContextError> => {
  const rule = context.runtime.journal.find(candidate => candidate.source === chunk.channel)
  if (rule === undefined) {
    return Effect.fail(asRuntimeContextError(
      "runtime-output.no-journal-rule",
      `no runtime journal rule for ${chunk.channel}`,
      context.contextId,
    ))
  }

  const receivedAt = nowIso()
  if (rule.target === "events" && rule.format === "jsonl" && chunk.channel === "stdout") {
    // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.1
    // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.3
    return Effect.succeed({
      eventId: outputRowId(context.contextId, activityAttempt, "events", sequence),
      contextId: context.contextId,
      activityAttempt,
      sequence,
      source: "stdout",
      format: "jsonl",
      receivedAt,
      raw: chunk.text,
    })
  }

  if (rule.target === "logs" && rule.format === "text-lines" && chunk.channel === "stderr") {
    // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.2
    return Effect.succeed({
      logLineId: outputRowId(context.contextId, activityAttempt, "logs", sequence),
      contextId: context.contextId,
      activityAttempt,
      sequence,
      source: "stderr",
      format: "text-lines",
      receivedAt,
      raw: chunk.text,
    })
  }

  return Effect.fail(asRuntimeContextError(
    "runtime-output.invalid-journal-rule",
    `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
    context.contextId,
  ))
}

export const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: Schema.Struct({
    contextId: Schema.String,
  }),
  success: RuntimeContextTerminalStateSchema,
  error: RuntimeContextError,
  // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.8
  idempotencyKey: ({ contextId }) => contextId,
})

interface RuntimeContextWorkflowOptions {
  readonly runtimeOutputStreamUrl: string
  /**
   * Tagged runtime input capability. `RuntimeInputDisabled` means no
   * stdin source is wired; `RuntimeInputDurableStreams` carries the
   * ingress + checkpoint URLs as one indivisible value, so the
   * misconfiguration "ingress without checkpoints" is unrepresentable.
   */
  readonly input: RuntimeInputStreams
}

export const RuntimeContextWorkflowLayer = (
  options: RuntimeContextWorkflowOptions,
) => RuntimeContextWorkflow.toLayer(
  Effect.fn(function* runRuntimeContext({ contextId }) {
    const controlPlane = yield* RuntimeControlPlane

    const context = yield* Activity.make({
      name: "firegrid.runtime-context.read-context",
      success: RuntimeContextSchema,
      error: RuntimeContextError,
      // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.1
      execute: controlPlane.getContext(contextId).pipe(
        Option.match({
          onNone: () =>
            Effect.fail(asRuntimeContextError("readContext", `runtime context not found: ${contextId}`, contextId)),
          onSome: Effect.succeed,
        }),
      ),
    })

    const processAttempt = yield* Activity.make({
      name: "firegrid.runtime-context.run-process-attempt",
      success: ProcessAttemptResultSchema,
      error: RuntimeContextError,
      execute: Effect.gen(function* () {
        const activityAttempt = yield* Activity.CurrentAttempt
        const provider = yield* SandboxProvider
        // effect-native-production-cutover.RUNTIME_IO.3
        const outputProducer = yield* DurableStreamClient.define({
          endpoint: { url: options.runtimeOutputStreamUrl },
          schema: RuntimeJournalEventSchema,
        }).producer({
          // effect-native-production-cutover.RUNTIME_IO.1
          producerId: `firegrid-runtime-output:${context.contextId}:${activityAttempt}`,
          lingerMs: 10,
        }).pipe(mapRuntimeOutputError(context.contextId))
        const command = yield* commandForContext(context)
        // Misconfiguration is unrepresentable: `options.input` is a
        // tagged `RuntimeInputStreams`. Match it to decide whether to
        // wire a stdin source.
        const stdin = Match.value(options.input).pipe(
          Match.tag("RuntimeInputDisabled", () => undefined),
          Match.tag("RuntimeInputDurableStreams", (durable) =>
            localProcessStdinDelivery({
              streamUrl: durable.ingress,
              contextId: context.contextId,
              subscriberId: localProcessIngressSubscriberId,
            }).pipe(
              Stream.mapError(cause =>
                asRuntimeContextError(
                  `runtime-ingress.${cause.op}`,
                  cause.message,
                  context.contextId,
                  cause,
                )),
              Stream.provideLayer(
                runtimeInputDeliveryLayer({
                  checkpointStreamUrl: durable.checkpoints,
                }),
              ),
              Stream.provideLayer(FetchHttpClient.layer),
            ),
          ),
          Match.exhaustive,
        )
        // firegrid-agent-ingress.DELIVERY.1
        // firegrid-agent-ingress.DELIVERY.2
        // firegrid-agent-ingress.DELIVERY.3
        // firegrid-agent-ingress.DELIVERY.5
        // firegrid-agent-ingress.SUBSCRIBERS.1
        const providerCommand = {
          ...command,
          ...(stdin === undefined ? {} : { stdin }),
        }
        // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.3
        // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.5
        const sandbox = yield* Effect.acquireRelease(
          provider.getOrCreate({
            labels: {
              firegridRuntimeContextId: context.contextId,
            },
            ...(context.runtime.config.cwd === undefined ? {} : { workingDir: context.runtime.config.cwd }),
            providerConfig: {
              contextId: context.contextId,
            },
          }),
          sandbox => provider.destroy(sandbox).pipe(Effect.ignore),
        )

        // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.2
        // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.4
        yield* controlPlane.appendRunStarted({
          contextId: context.contextId,
          activityAttempt,
          provider: context.runtime.provider,
        })

        const appendFailed = (
          message: string,
        ) =>
          controlPlane.appendRunFailed({
            contextId: context.contextId,
            activityAttempt,
            provider: context.runtime.provider,
            message,
          })

        const streamProcess = provider.stream(sandbox, providerCommand).pipe(
          Stream.mapAccum(0, (sequence, chunk): readonly [number, SequencedChunk] => [
            sequence + 1,
            { sequence, chunk },
          ]),
          Stream.tap(({ chunk, sequence }) => {
            if (chunk.type === "exit") return Effect.void
            // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7
            return outputRowFromChunk(context, activityAttempt, sequence, chunk).pipe(
              Effect.flatMap(row =>
                outputProducer.append(runtimeJournalEventForOutput(row)).pipe(
                  mapRuntimeOutputError(context.contextId),
                )),
            )
          }),
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
              // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.4
              outputProducer.flush.pipe(
                mapRuntimeOutputError(context.contextId),
                Effect.zipRight(controlPlane.appendRunExited({
                  contextId: context.contextId,
                  activityAttempt,
                  provider: context.runtime.provider,
                  exitCode: exit.exitCode,
                  ...(exit.signal === undefined ? {} : { signal: exit.signal }),
                })),
                Effect.as({
                  activityAttempt,
                  exitCode: exit.exitCode,
                  ...(exit.signal === undefined ? {} : { signal: exit.signal }),
                }),
              ),
          })),
          Effect.catchAll(error =>
            outputProducer.flush.pipe(
              mapRuntimeOutputError(context.contextId),
              Effect.ignore,
              Effect.zipRight(appendFailed(error.message)),
              Effect.zipRight(Effect.fail(error)),
            ),
          ),
        )

        return yield* streamProcess
      }).pipe(
        Effect.catchTag("SandboxProviderError", (cause: SandboxProviderError) =>
          Effect.fail(asRuntimeContextError(`sandbox.${cause.op}`, cause.message, context.contextId, cause))),
      ),
    })

    return {
      contextId,
      status: processAttempt.exitCode === 0 ? "completed" as const : "failed" as const,
      activityAttempt: processAttempt.activityAttempt,
      exitCode: processAttempt.exitCode,
    }
  }),
)
