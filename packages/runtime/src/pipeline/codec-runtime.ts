import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeEventRow,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Option, Stream, type Layer } from "effect"
import { FiregridAgentToolkit } from "../agent-tools/tools.ts"
import {
  RuntimeAgentOutputRowSink,
} from "../authorities/index.ts"
import {
  AcpCodec,
  StdioJsonlCodec,
} from "../codecs/index.ts"
import {
  type AgentCodec,
  type AgentOutputEvent,
  encodeRuntimeAgentOutputEnvelope,
} from "../events/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../host/errors.ts"
import {
  SandboxProvider,
  commandForContext,
  type SandboxProviderError,
} from "../sources/sandbox/index.ts"
import {
  runIngressDelivery,
  runStderrJournal,
  runToolRouter,
  runtimeIngressSubscriberId,
} from "../subscribers/index.ts"

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const codecForAgentProtocol = (
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
): AgentCodec => {
  switch (protocol) {
    case "stdio-jsonl":
      return StdioJsonlCodec
    case "acp":
      return AcpCodec
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
  readonly toolLoweringLayer: Layer.Layer<never, unknown, unknown>
}) =>
  Effect.gen(function* () {
    const outputSink = yield* RuntimeAgentOutputRowSink
    const codec = codecForAgentProtocol(options.protocol)
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
    const session = yield* codec.open(bytes, {
      toolkit: FiregridAgentToolkit,
    }).pipe(
      Effect.mapError(cause =>
        asRuntimeContextError(
          `agent-codec.${cause.op}`,
          cause.message,
          options.context.contextId,
          cause,
        )),
    )

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

    return yield* session.outputs.pipe(
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
      Stream.tap(({ sequence, event }) =>
        outputRowFromAgentEvent(
          options.context,
          options.activityAttempt,
          sequence,
          event,
        ).pipe(
          Effect.flatMap(row => Stream.run(Stream.succeed(row), outputSink)),
          mapRuntimeContextError(
            "runtime-output.codec.write",
            "failed to write codec runtime output row",
            options.context.contextId,
          ),
        )),
      Stream.filter((item): item is {
        readonly sequence: number
        readonly event: Extract<AgentOutputEvent, { readonly _tag: "Terminated" }>
      } => item.event._tag === "Terminated"),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(asRuntimeContextError(
            "agent-codec.outputs",
            "codec output stream ended without a Terminated event",
            options.context.contextId,
          )),
        onSome: ({ event }) =>
          Effect.succeed({
            exitCode: event.exitCode ?? 0,
          }),
      })),
    )
  }).pipe(Effect.scoped)
