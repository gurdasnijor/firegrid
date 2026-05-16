import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeEventRow,
} from "@firegrid/protocol/launch"
import { IdGenerator } from "@effect/ai"
import { Clock, Effect, Layer, Option, Ref, Stream } from "effect"
import { RuntimeAgentOutputRowSink } from "./authorities/runtime-output-journal.ts"
import {
  AcpSessionLive,
  AgentCodecError,
  AgentSession,
  StdioJsonlSessionLive,
} from "./codecs/index.ts"
import {
  type AgentOutputEvent,
  encodeRuntimeAgentOutputEnvelope,
} from "./events/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../runtime-errors.ts"
import {
  SandboxProvider,
  commandForContext,
  type SandboxProviderError,
} from "./sources/sandbox/index.ts"
import type { AgentByteStream } from "./sources/byte-stream.ts"
import {
  runIngressDelivery,
  runStderrJournal,
  runToolRouter,
  runtimeIngressSubscriberId,
} from "./subscribers/index.ts"

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const codecForAgentProtocol = (
  bytes: AgentByteStream,
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
): Layer.Layer<AgentSession, AgentCodecError> => {
  // firegrid-runtime-boundary-reconciliation.CODEC_SESSION.7
  switch (protocol) {
    case "stdio-jsonl":
      return StdioJsonlSessionLive(bytes)
    case "acp":
      return AcpSessionLive(bytes).pipe(
        Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
      )
    default:
      return protocol satisfies never
  }
}

const agentCodecSubscriberId = (
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
) => runtimeIngressSubscriberId(protocol, "codec")

const runtimeOutputRawFromAgentEvent = (
  contextId: string,
  event: AgentOutputEvent,
): Effect.Effect<string, RuntimeContextError> =>
  Effect.try({
    try: () => encodeRuntimeAgentOutputEnvelope(event),
    catch: cause =>
      asRuntimeContextError(
        "runtime-output.agent-event.encode",
        "failed to encode agent output event",
        contextId,
        cause,
      ),
  })

const outputRowFromAgentEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  event: AgentOutputEvent,
): Effect.Effect<RuntimeEventRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const receivedAt = yield* nowIso
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
      raw: yield* runtimeOutputRawFromAgentEvent(context.contextId, event),
    }
  })

const mapSandboxProviderError = (
  contextId: string,
) =>
  Effect.mapError((cause: SandboxProviderError) =>
    asRuntimeContextError(
      `sandbox.${cause.op}`,
      cause.message,
      contextId,
      cause,
    ))

export const runCodecRuntimeEventPipeline = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly protocol: Exclude<RuntimeAgentProtocol, "raw">
  readonly toolLoweringLayer: Layer.Layer<unknown, unknown, unknown>
}) =>
  Effect.gen(function* () {
    const outputSink = yield* RuntimeAgentOutputRowSink
    const command = yield* commandForContext(options.context)
    const provider = yield* SandboxProvider
    const sandbox = yield* provider.getOrCreate({
      labels: {
        firegridRuntimeContextId: options.context.contextId,
      },
      ...(options.context.runtime.config.cwd === undefined ? {} : {
        workingDir: options.context.runtime.config.cwd,
      }),
      providerConfig: {
        contextId: options.context.contextId,
      },
    }).pipe(mapSandboxProviderError(options.context.contextId))
    const bytes = yield* provider.openBytePipe(sandbox, command).pipe(
      mapSandboxProviderError(options.context.contextId),
    )

    const runActiveSession = Effect.gen(function* () {
      const session = yield* AgentSession

      // firegrid-runtime-boundary-reconciliation.CODEC_SESSION.4
      yield* runStderrJournal({
        context: options.context,
        activityAttempt: options.activityAttempt,
        bytes,
        nowIso,
      }).pipe(Effect.forkScoped)

      yield* runIngressDelivery({
        contextId: options.context.contextId,
        subscriberId: agentCodecSubscriberId(options.protocol),
        send: session.send,
      }).pipe(Effect.forkScoped)

      yield* runToolRouter({
        context: options.context,
        activityAttempt: options.activityAttempt,
        toolUseMode: session.toolUseMode,
      }).pipe(
        Effect.provide(options.toolLoweringLayer),
        Effect.forkScoped,
      )

      const terminal = yield* Ref.make<Option.Option<
        Extract<AgentOutputEvent, { readonly _tag: "Terminated" }>
      >>(Option.none())

      yield* session.outputs.pipe(
        Stream.mapError(cause =>
          asRuntimeContextError(
            `agent-codec.${cause.op}`,
            cause.message,
            options.context.contextId,
            cause,
          )),
        Stream.mapAccum(0, (sequence, event) => [
          sequence + 1,
          { sequence, event },
        ] as const),
        Stream.mapEffect(({ sequence, event }) =>
          outputRowFromAgentEvent(
            options.context,
            options.activityAttempt,
            sequence,
            event,
          ).pipe(Effect.map(row => ({ row, event })))),
        Stream.takeUntil(({ event }) => event._tag === "Terminated"),
        Stream.tap(({ event }) =>
          event._tag === "Terminated"
            ? Ref.set(terminal, Option.some(event))
            : Effect.void),
        Stream.map(({ row }) => row),
        Stream.run(outputSink),
        mapRuntimeContextError(
          "runtime-output.codec.write",
          "failed to write codec runtime output row",
          options.context.contextId,
        ),
      )

      return yield* Ref.get(terminal).pipe(
        Effect.flatMap(Option.match({
          onNone: () =>
            Effect.fail(asRuntimeContextError(
              "agent-codec.outputs",
              "codec output stream ended without a Terminated event",
              options.context.contextId,
            )),
          onSome: (event) =>
            Effect.succeed({
              exitCode: event.exitCode ?? 0,
            }),
        })),
      )
    })

    return yield* runActiveSession.pipe(
      Effect.provide(codecForAgentProtocol(bytes, options.protocol)),
      Effect.mapError(cause =>
        cause instanceof AgentCodecError
          ? asRuntimeContextError(
            `agent-codec.${cause.op}`,
            cause.message,
            options.context.contextId,
            cause,
          )
          : cause),
    )
  }).pipe(Effect.scoped)
