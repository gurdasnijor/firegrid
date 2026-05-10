import { Activity, Workflow } from "@effect/workflow"
import {
  RuntimeContextSchema,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Effect, Option, Schema, Stream } from "effect"
import { commandForContext } from "./command.ts"
import {
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
  type RuntimeOutputRow,
  RuntimeCaptureJournal,
  type RuntimeCaptureJournalError,
} from "../runtime-output/writer.ts"
import {
  RuntimeIngress,
  type RuntimeIngressError,
  type RuntimeIngressRequestedRow,
} from "../runtime-ingress/index.ts"
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

const nowIso = (): string => new Date().toISOString()
const localProcessIngressSubscriberId = "runtime-context:local-process:stdin"

const textFromPayloadValue = (
  value: unknown,
): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined
}

const providerInputFromIngress = (
  row: RuntimeIngressRequestedRow,
): string => {
  if (Array.isArray(row.payload)) {
    const text = row.payload.flatMap(value => {
      const decoded = textFromPayloadValue(value)
      return decoded === undefined ? [] : [decoded]
    })
    if (text.length > 0) return text.join("\n")
  }
  const text = textFromPayloadValue(row.payload)
  return text ?? JSON.stringify(row.payload)
}

const stdinForIngress = (
  rows: ReadonlyArray<RuntimeIngressRequestedRow>,
): string | undefined =>
  rows.length === 0
    ? undefined
    : `${rows.map(providerInputFromIngress).join("\n")}\n`

const mapCaptureJournalError = (
  contextId: string,
) =>
  Effect.mapError((cause: RuntimeCaptureJournalError) =>
    asRuntimeContextError(
      `runtime-capture.${cause.op}`,
      "failed to write runtime data-plane journal event",
      contextId,
      cause,
    ))

const mapRuntimeIngressError = (
  contextId: string,
) =>
  Effect.mapError((cause: RuntimeIngressError) =>
    asRuntimeContextError(
      `runtime-ingress.${cause.op}`,
      cause.message,
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

export const RuntimeContextWorkflowLayer = RuntimeContextWorkflow.toLayer(
  Effect.fn(function* runRuntimeContext({ contextId }) {
    const controlPlane = yield* RuntimeControlPlane
    const captureJournal = yield* RuntimeCaptureJournal
    const runtimeIngress = yield* RuntimeIngress

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
        const output = yield* captureJournal.openAttempt({
          contextId: context.contextId,
          activityAttempt,
        })
        const command = yield* commandForContext(context)
        const pendingIngress = yield* runtimeIngress.pending({
          contextId: context.contextId,
          subscriberId: localProcessIngressSubscriberId,
        }).pipe(mapRuntimeIngressError(context.contextId))
        // firegrid-agent-ingress.DELIVERY.1
        // firegrid-agent-ingress.DELIVERY.2
        // firegrid-agent-ingress.DELIVERY.3
        // firegrid-agent-ingress.SUBSCRIBERS.1
        const stdin = stdinForIngress(pendingIngress)
        const deliveredCommand = {
          ...command,
          ...(stdin === undefined ? {} : { stdin }),
        }
        yield* Effect.forEach(pendingIngress, row =>
          runtimeIngress.markDelivered({
            contextId: row.contextId,
            ingressId: row.ingressId,
            subscriberId: localProcessIngressSubscriberId,
            provider: context.runtime.provider,
          }).pipe(mapRuntimeIngressError(context.contextId)), { discard: true })
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

        const streamProcess = provider.stream(sandbox, deliveredCommand).pipe(
          Stream.mapAccum(0, (sequence, chunk): readonly [number, SequencedChunk] => [
            sequence + 1,
            { sequence, chunk },
          ]),
          Stream.tap(({ chunk, sequence }) => {
            if (chunk.type === "exit") return Effect.void
            // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7
            return outputRowFromChunk(context, activityAttempt, sequence, chunk).pipe(
              Effect.flatMap(row =>
                output.write(row).pipe(mapCaptureJournalError(context.contextId))),
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
              output.flush.pipe(
                mapCaptureJournalError(context.contextId),
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
            output.flush.pipe(
              mapCaptureJournalError(context.contextId),
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
