import { Command } from "@effect/platform"
import {
  CommandExecutor as CommandExecutorTag,
  type CommandExecutor,
} from "@effect/platform/CommandExecutor"
import type { HttpClient } from "@effect/platform"
import {
  RuntimeJournalEventSchema,
  type RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import { Effect, Option, Stream, type Scope } from "effect"
import { DurableStream } from "effect-durable-streams"
import {
  RuntimeIngressRowSchema,
  type RuntimeIngressRequestedRow,
} from "../runtime-ingress/schema.ts"
import {
  retainedIngressFacts,
  selectPendingIngress,
} from "./folds.ts"
import {
  makeRuntimeIngressDeliveredRow,
  runtimeJournalEventFromOutput,
} from "./rows.ts"

export interface LocalProcessRuntimeLoopCommand {
  readonly argv: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Record<string, string>
}

export interface RunStreamNativeRuntimeLoopOptions {
  readonly ingressEndpoint: DurableStream.Endpoint
  readonly outputEndpoint: DurableStream.Endpoint
  readonly contextId: string
  readonly subscriberId: string
  readonly provider: "local-process"
  readonly command: LocalProcessRuntimeLoopCommand
  readonly activityAttempt?: number
  readonly producerId?: string
}

export interface StreamNativeRuntimeLoopSummary {
  readonly contextId: string
  readonly subscriberId: string
  readonly ingressRowsRead: number
  readonly pendingRows: number
  readonly deliveredRowsWritten: number
  readonly promptsDelivered: number
  readonly outputRowsWritten: number
  readonly exitCode?: number
}

type OutputChunk =
  | {
    readonly channel: "stdout" | "stderr"
    readonly text: string
  }

const runtimeIngressStream = (endpoint: DurableStream.Endpoint) =>
  DurableStream.define({
    endpoint,
    schema: RuntimeIngressRowSchema,
  })

const runtimeOutputStream = (endpoint: DurableStream.Endpoint) =>
  DurableStream.define({
    endpoint,
    schema: RuntimeJournalEventSchema,
  })

type RuntimeOutputStream = ReturnType<typeof runtimeOutputStream>

const nowIso = (): string => new Date().toISOString()

const textFromPayloadValue = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).type === "text" &&
        typeof (value as Record<string, unknown>).text === "string"
    ? (value as Record<string, string>).text
    : undefined

const stdinFromIngress = (
  row: RuntimeIngressRequestedRow,
): string => {
  const text = (Array.isArray(row.payload) ? row.payload : [row.payload])
    .flatMap(value => {
      const decoded = textFromPayloadValue(value)
      return decoded === undefined ? [] : [decoded]
    })
    .join("\n")
  return text.length > 0 ? `${text}\n` : `${JSON.stringify(row.payload)}\n`
}

const buildCommand = (
  command: LocalProcessRuntimeLoopCommand,
  stdin: string,
) =>
  Effect.gen(function* () {
    const [executable, ...args] = command.argv
    if (executable === undefined) {
      return yield* Effect.fail(new Error("stream-native runtime loop command argv is empty"))
    }
    let built = Command.make(executable, ...args).pipe(Command.feed(stdin))
    if (command.env !== undefined) built = built.pipe(Command.env(command.env))
    if (command.cwd !== undefined) built = built.pipe(Command.workingDirectory(command.cwd))
    return built
  })

const writeRuntimeOutput = (
  outputStream: RuntimeOutputStream,
  options: RunStreamNativeRuntimeLoopOptions,
  events: Stream.Stream<RuntimeJournalEvent, Error>,
) =>
  // stream-native-runtime-loop.LOOP.2
  Effect.gen(function* () {
    const activityAttempt = options.activityAttempt ?? 1
    const producer = yield* outputStream.producer({
      producerId: options.producerId ??
        `stream-native-runtime-loop:${options.contextId}:${options.subscriberId}:${activityAttempt}`,
      lingerMs: 5,
      maxBatchSize: 16,
    })
    const outputRowsWritten = yield* events.pipe(
      Stream.runFoldEffect(0, (count, event) =>
        producer.append(event).pipe(Effect.as(count + 1))),
    )
    yield* producer.flush
    return outputRowsWritten
  })

const runLocalProcess = (
  outputStream: RuntimeOutputStream,
  options: RunStreamNativeRuntimeLoopOptions,
  row: RuntimeIngressRequestedRow,
) =>
  // stream-native-runtime-loop.LOOP.5
  Effect.gen(function* () {
    const executor = yield* CommandExecutorTag
    const built = yield* buildCommand(options.command, stdinFromIngress(row))
    const process = yield* executor.start(built)
    const activityAttempt = options.activityAttempt ?? 1
    const stdout = process.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map(text => ({ channel: "stdout" as const, text }) satisfies OutputChunk),
    )
    const stderr = process.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map(text => ({ channel: "stderr" as const, text }) satisfies OutputChunk),
    )
    const outputEvents = Stream.merge(stdout, stderr).pipe(
      Stream.mapError(cause => cause instanceof Error ? cause : new Error(String(cause))),
      Stream.mapAccum(0, (sequence, chunk) => [
        sequence + 1,
        runtimeJournalEventFromOutput({
          contextId: options.contextId,
          activityAttempt,
          sequence,
          channel: chunk.channel,
          raw: chunk.text,
          receivedAt: nowIso(),
        }),
      ] as const),
    )
    const outputRowsWritten = yield* writeRuntimeOutput(
      outputStream,
      options,
      outputEvents,
    )
    const exitCode = yield* process.exitCode
    return { outputRowsWritten, exitCode: Number(exitCode) }
  })

const noPendingSummary = (
  options: RunStreamNativeRuntimeLoopOptions,
  ingressRowsRead: number,
): StreamNativeRuntimeLoopSummary => ({
  contextId: options.contextId,
  subscriberId: options.subscriberId,
  ingressRowsRead,
  pendingRows: 0,
  deliveredRowsWritten: 0,
  promptsDelivered: 0,
  outputRowsWritten: 0,
})

export const runStreamNativeRuntimeLoop = (
  options: RunStreamNativeRuntimeLoopOptions,
): Effect.Effect<
  StreamNativeRuntimeLoopSummary,
  unknown,
  HttpClient.HttpClient | CommandExecutor | Scope.Scope
> =>
  Effect.gen(function* () {
    const ingressStream = runtimeIngressStream(options.ingressEndpoint)
    const outputStream = runtimeOutputStream(options.outputEndpoint)
    // stream-native-runtime-loop.SURFACE.1
    // stream-native-runtime-loop.SURFACE.3
    // stream-native-runtime-loop.SURFACE.4
    // stream-native-runtime-loop.SCOPE.1
    // stream-native-runtime-loop.SCOPE.2
    // stream-native-runtime-loop.LOOP.1
    // stream-native-runtime-loop.SURFACE.2
    const ingressRows = () => ingressStream.read({ live: false })
    const retained = yield* retainedIngressFacts(ingressRows(), {
      contextId: options.contextId,
      subscriberId: options.subscriberId,
    })
    const pending = yield* selectPendingIngress(
      ingressRows(),
      {
        contextId: options.contextId,
        subscriberId: options.subscriberId,
      },
      retained.deliveredKeys,
    )

    return yield* pending.first.pipe(
      Option.match({
        onNone: () => Effect.succeed(noPendingSummary(options, retained.rowsRead)),
        onSome: next =>
          // stream-native-runtime-loop.LOOP.3
          ingressStream.append(makeRuntimeIngressDeliveredRow({
            contextId: next.contextId,
            ingressId: next.ingressId,
            subscriberId: options.subscriberId,
            provider: options.provider,
            deliveredAt: nowIso(),
          })).pipe(
            Effect.zipRight(runLocalProcess(outputStream, options, next)),
            Effect.map(process => ({
              contextId: options.contextId,
              subscriberId: options.subscriberId,
              ingressRowsRead: retained.rowsRead,
              pendingRows: pending.count,
              deliveredRowsWritten: 1,
              promptsDelivered: 1,
              outputRowsWritten: process.outputRowsWritten,
              exitCode: process.exitCode,
            })),
          ),
      }),
    )
  })
