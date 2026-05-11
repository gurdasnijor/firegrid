import { Activity, Workflow } from "@effect/workflow"
import type { HttpClient } from "@effect/platform"
import {
  RuntimeJournalEventSchema,
  RuntimeContextSchema,
  type RuntimeContext,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeLogLine,
} from "@firegrid/protocol/launch"
import { Effect, Option, Schema, Stream } from "effect"
import type { DurableStream } from "effect-durable-streams"
import { DurableStream as DurableStreamClient } from "effect-durable-streams"
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
  type RuntimeIngressError,
  RuntimeIngressRowSchema,
  type RuntimeIngressRequestedRow,
  runtimeIngressError,
  type RuntimeIngressDeliveryRequest,
  type RuntimeIngressDeliveredRow,
  type RuntimeIngressRow,
} from "../runtime-ingress/index.ts"
import {
  makeRuntimeIngressDeliveredRow,
} from "../runtime-ingress/rows.ts"
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
type PendingIngressState = {
  readonly delivered: Set<string>
  readonly pending: Map<string, RuntimeIngressRequestedRow>
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

const ingressDeliveryKey = (
  row: {
    readonly contextId: string
    readonly ingressId: string
    readonly subscriberId: string
  },
): string =>
  `${row.contextId}:${row.ingressId}:${row.subscriberId}`

const isRuntimeIngressDeliveryFor = (
  row: RuntimeIngressRow,
  options: {
    readonly contextId: string
    readonly subscriberId: string
  },
): row is RuntimeIngressDeliveredRow =>
  row.type === "firegrid.runtime_ingress.delivered" &&
  row.contextId === options.contextId &&
  row.subscriberId === options.subscriberId

const isRuntimeIngressRequestFor = (
  row: RuntimeIngressRow,
  contextId: string,
): row is RuntimeIngressRequestedRow =>
  row.type === "firegrid.runtime_ingress.requested" &&
  row.contextId === contextId

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

const mapRuntimeIngressStreamError = (
  op: string,
  message: string,
  row?: {
    readonly contextId?: string
    readonly ingressId?: string
  },
) =>
  Effect.mapError((cause: DurableStream.ReadError | DurableStream.WriteError) =>
    runtimeIngressError(op, message, row?.contextId, row?.ingressId, cause))

const pendingRuntimeIngressFromStream = (
  options: {
    readonly streamUrl: string
    readonly contextId: string
    readonly subscriberId: string
  },
): Effect.Effect<ReadonlyArray<RuntimeIngressRequestedRow>, RuntimeIngressError, HttpClient.HttpClient> => {
  const initial: PendingIngressState = {
    delivered: new Set<string>(),
    pending: new Map<string, RuntimeIngressRequestedRow>(),
  }
  return DurableStreamClient.define({
    endpoint: { url: options.streamUrl },
    schema: RuntimeIngressRowSchema,
  }).read({ live: false }).pipe(
    Stream.runFold(initial, (state, row): PendingIngressState => {
      if (isRuntimeIngressDeliveryFor(row, options)) {
        const key = ingressDeliveryKey(row)
        state.delivered.add(key)
        state.pending.delete(key)
        return state
      }
      if (!isRuntimeIngressRequestFor(row, options.contextId)) return state
      const key = ingressDeliveryKey({
        contextId: row.contextId,
        ingressId: row.ingressId,
        subscriberId: options.subscriberId,
      })
      if (!state.delivered.has(key) && !state.pending.has(key)) {
        state.pending.set(key, row)
      }
      return state
    }),
    Effect.map(state => Array.from(state.pending.values())),
    mapRuntimeIngressStreamError(
      "pending",
      "failed to read pending runtime ingress durable rows",
      options,
    ),
  )
}

const hasDeliveredRuntimeIngress = (
  options: {
    readonly streamUrl: string
    readonly contextId: string
    readonly ingressId: string
    readonly subscriberId: string
  },
): Effect.Effect<boolean, RuntimeIngressError, HttpClient.HttpClient> =>
  DurableStreamClient.define({
    endpoint: { url: options.streamUrl },
    schema: RuntimeIngressRowSchema,
  }).read({ live: false }).pipe(
    Stream.filter(row =>
      row.type === "firegrid.runtime_ingress.delivered" &&
      row.contextId === options.contextId &&
      row.ingressId === options.ingressId &&
      row.subscriberId === options.subscriberId),
    Stream.runHead,
    Effect.map(Option.isSome),
    mapRuntimeIngressStreamError(
      "delivered.exists",
      "failed to read runtime ingress delivery rows",
      options,
    ),
  )

const appendRuntimeIngressDelivered = (
  options: {
    readonly streamUrl: string
    readonly request: RuntimeIngressDeliveryRequest
  },
): Effect.Effect<RuntimeIngressDeliveredRow, RuntimeIngressError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const delivered = yield* hasDeliveredRuntimeIngress({
      streamUrl: options.streamUrl,
      contextId: options.request.contextId,
      ingressId: options.request.ingressId,
      subscriberId: options.request.subscriberId,
    })
    if (delivered) return makeRuntimeIngressDeliveredRow(options.request)

    const row = makeRuntimeIngressDeliveredRow(options.request)
    // firegrid-agent-ingress.DELIVERY.3
    // firegrid-agent-ingress.SUBSCRIBERS.2
    // effect-native-production-cutover.RUNTIME_IO.2
    yield* DurableStreamClient.define({
      endpoint: { url: options.streamUrl },
      schema: RuntimeIngressRowSchema,
    }).append(row).pipe(
      Effect.asVoid,
      mapRuntimeIngressStreamError(
        "append",
        "failed to append runtime ingress delivery row",
        row,
      ),
    )
    return row
  })

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
  readonly runtimeIngressStreamUrl?: string
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
        const pendingIngress = yield* (options.runtimeIngressStreamUrl === undefined
          ? Effect.succeed([])
          : pendingRuntimeIngressFromStream({
            streamUrl: options.runtimeIngressStreamUrl,
            contextId: context.contextId,
            subscriberId: localProcessIngressSubscriberId,
          })).pipe(mapRuntimeIngressError(context.contextId))
        // firegrid-agent-ingress.DELIVERY.1
        // firegrid-agent-ingress.DELIVERY.2
        // firegrid-agent-ingress.DELIVERY.3
        // firegrid-agent-ingress.SUBSCRIBERS.1
        const stdin = stdinForIngress(pendingIngress)
        const deliveredCommand = {
          ...command,
          ...(stdin === undefined ? {} : { stdin }),
        }
        const runtimeIngressStreamUrl = options.runtimeIngressStreamUrl
        if (runtimeIngressStreamUrl !== undefined) {
          yield* Effect.forEach(pendingIngress, row =>
            appendRuntimeIngressDelivered({
              streamUrl: runtimeIngressStreamUrl,
              request: {
                contextId: row.contextId,
                ingressId: row.ingressId,
                subscriberId: localProcessIngressSubscriberId,
                provider: context.runtime.provider,
              },
            }).pipe(mapRuntimeIngressError(context.contextId)), { discard: true })
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
