import type {
  RuntimeContext,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Effect, Ref, Stream } from "effect"
import { RuntimeLogLineAppendAndGet } from "../authorities/runtime-output-journal.ts"
import type { AgentByteStream } from "../sources/byte-stream.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../../runtime-errors.ts"

const codecStderrLines = (
  contextId: string,
  stderr: ReadableStream<Uint8Array>,
): Stream.Stream<string, RuntimeContextError> =>
  Stream.fromReadableStream({
    evaluate: () => stderr,
    onError: cause =>
      asRuntimeContextError(
        "sandbox.codec.stderr",
        "failed reading codec process stderr",
        contextId,
        cause,
      ),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
  )

const logLineRowFromCodecStderr = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly sequence: number
  readonly raw: string
  readonly receivedAt: string
}): RuntimeLogLineRow => ({
  logLineId: {
    contextId: options.context.contextId,
    activityAttempt: options.activityAttempt,
    target: "logs",
    sequence: options.sequence,
  },
  contextId: options.context.contextId,
  activityAttempt: options.activityAttempt,
  sequence: options.sequence,
  source: "stderr",
  format: "text-lines",
  receivedAt: options.receivedAt,
  raw: options.raw,
})

export const runStderrJournal = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly bytes: AgentByteStream
  readonly nowIso: Effect.Effect<string>
}): Effect.Effect<void, RuntimeContextError, RuntimeLogLineAppendAndGet> =>
  Effect.gen(function* () {
    const logLines = yield* RuntimeLogLineAppendAndGet
    const sequenceRef = yield* Ref.make(0)
    yield* codecStderrLines(options.context.contextId, options.bytes.stderr).pipe(
      Stream.mapEffect(line =>
        Effect.gen(function* () {
          const sequence = yield* Ref.getAndUpdate(sequenceRef, value => value + 1)
          const receivedAt = yield* options.nowIso
          const row = logLineRowFromCodecStderr({
            context: options.context,
            activityAttempt: options.activityAttempt,
            sequence,
            raw: line,
            receivedAt,
          })
          yield* logLines.append(row).pipe(
            mapRuntimeContextError(
              "runtime-output.codec.stderr.write",
              "failed to write codec stderr runtime log row",
              options.context.contextId,
            ),
          )
        })),
      Stream.runDrain,
    )
  })
