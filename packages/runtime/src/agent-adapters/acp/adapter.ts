import * as acp from "@agentclientprotocol/sdk"
import { AiError, IdGenerator, LanguageModel, Prompt, Response } from "@effect/ai"
import {
  Chunk,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Runtime,
  type Scope,
  Stream,
} from "effect"
import type { AgentByteStream } from "../../agent-io/index.ts"
import { AgentAdapter, type AgentAdapterCapabilities, type AgentAdapterService } from "../AgentAdapter.ts"
import { CurrentAgentTurn } from "../current-turn.ts"
import {
  AdapterCancelled,
  AdapterProtocolError,
  AdapterUnsupportedFeature,
  PermissionRequiredButNotHandled,
} from "../errors.ts"
import {
  acpSessionUpdateToStreamParts,
  acpStopReasonToFinishReason,
  promptToAcpContent,
} from "./mapping.ts"

const MODULE = "AcpAgentAdapter"

// firegrid-effect-ai-native-agents.ACP_ADAPTER.1
export const AcpAdapterCapabilities = {
  streamingText: true,
  tools: false,
  multiTurn: true,
  mayRequestPermissions: false,
} as const satisfies AgentAdapterCapabilities

type AcpStreamPart = Response.StreamPart<Record<string, never>>
type AcpPart = Response.Part<Record<string, never>>

type TurnSignal =
  | { readonly _tag: "Part"; readonly part: AcpStreamPart }
  | { readonly _tag: "Finish"; readonly reason: Response.FinishReason }
  | { readonly _tag: "Fail"; readonly error: AiError.AiError }

interface TurnState {
  readonly queue: Queue.Queue<TurnSignal>
}

const toolkitUnsupportedError = (method: "generateText" | "streamText"): AiError.UnknownError =>
  new AiError.UnknownError({
    module: MODULE,
    method,
    description: "ACP adapter does not support Effect AI toolkit option",
    cause: new AdapterUnsupportedFeature({
      feature: "toolkit",
      message:
        "ACP has no client-supplied tool-result path; toolkit-based tool resolution is unsupported in Slice 2",
    }),
  })

const generateObjectUnsupportedError = (): AiError.UnknownError =>
  new AiError.UnknownError({
    module: MODULE,
    method: "generateObject",
    description: "ACP adapter does not support generateObject in Slice 2",
    cause: new AdapterUnsupportedFeature({
      feature: "generateObject",
      message: "ACP adapter generateObject is not implemented; use generateText",
    }),
  })

// firegrid-effect-ai-native-agents.ACP_ADAPTER.6
const permissionRequiredError = (toolCallId: string | undefined): AiError.UnknownError =>
  new AiError.UnknownError({
    module: MODULE,
    method: "streamText",
    description:
      "ACP requested permission but no PermissionedAdapter capability is installed",
    cause: new PermissionRequiredButNotHandled({
      ...(toolCallId === undefined ? {} : { toolCallId }),
      message:
        "ACP requestPermission rejected by the base LanguageModel view; permission is never auto-allowed",
    }),
  })

const promptFailedError = (cause: unknown): AiError.UnknownError =>
  new AiError.UnknownError({
    module: MODULE,
    method: "streamText",
    description: "ACP prompt failed",
    cause: new AdapterProtocolError({
      op: "prompt",
      message: "underlying ACP prompt call failed",
      cause,
    }),
  })

const cancelledError = (): AiError.UnknownError =>
  new AiError.UnknownError({
    module: MODULE,
    method: "streamText",
    description: "ACP adapter scope finalized while a turn was active",
    cause: new AdapterCancelled({
      message: "ACP adapter scope closed before the active turn completed",
    }),
  })

// firegrid-effect-ai-native-agents.ACP_ADAPTER.7
const aggregateStreamPartsForGenerateText = (
  parts: ReadonlyArray<AcpStreamPart>,
): Array<AcpPart> => {
  const buffers = new Map<string, string>()
  const out: Array<AcpPart> = []
  const flushBuffer = (id: string): void => {
    const text = buffers.get(id)
    if (text !== undefined && text.length > 0) {
      out.push(Response.textPart({ text }))
    }
    buffers.delete(id)
  }
  parts.forEach(part => {
    if (part.type === "text-delta") {
      const existing = buffers.get(part.id) ?? ""
      buffers.set(part.id, existing + part.delta)
      return
    }
    if (part.type === "text-end") {
      flushBuffer(part.id)
      return
    }
    if (part.type === "tool-call" || part.type === "finish") {
      out.push(part)
    }
  })
  Array.from(buffers.keys()).forEach(flushBuffer)
  return out
}

export interface AcpAgentAdapterOptions {
  /**
   * Duplex byte stream wired to the ACP-speaking process or remote
   * transport. The adapter does not own resource provisioning;
   * callers compose this from a SandboxProvider or a remote
   * connection.
   */
  readonly bytes: AgentByteStream
}

// firegrid-effect-ai-native-agents.ACP_ADAPTER.1
// firegrid-effect-ai-native-agents.ACP_ADAPTER.2
const makeAcpAgentAdapter = (
  options: AcpAgentAdapterOptions,
) =>
  Effect.gen(function*() {
    const bytes = options.bytes
    const runtime = yield* Effect.runtime<never>()
    const runPromise = Runtime.runPromise(runtime)

    const currentTurnRef = yield* Ref.make<Option.Option<TurnState>>(Option.none())
    const textDeltaIdRef = yield* Ref.make<string | undefined>(undefined)
    const turnLock = yield* Effect.makeSemaphore(1)

    const allocateTextDeltaId = (
      messageId: string | undefined,
    ): Effect.Effect<string> => {
      if (messageId !== undefined) {
        return Effect.succeed(messageId)
      }
      return Ref.get(textDeltaIdRef).pipe(
        Effect.flatMap(existing => {
          if (existing !== undefined) {
            return Effect.succeed(existing)
          }
          return IdGenerator.defaultIdGenerator.generateId().pipe(
            Effect.tap(id => Ref.set(textDeltaIdRef, id)),
          )
        }),
      )
    }

    const offerToCurrent = (signal: TurnSignal): Effect.Effect<void> =>
      Ref.get(currentTurnRef).pipe(
        Effect.flatMap(maybe =>
          Option.match(maybe, {
            onNone: () => Effect.void,
            onSome: turn => Queue.offer(turn.queue, signal).pipe(Effect.asVoid),
          }),
        ),
      )

    const client: acp.Client = {
      requestPermission: async params => {
        await runPromise(
          offerToCurrent({
            _tag: "Fail",
            error: permissionRequiredError(params.toolCall.toolCallId),
          }),
        )
        return { outcome: { outcome: "cancelled" } }
      },
      sessionUpdate: async params => {
        await runPromise(
          acpSessionUpdateToStreamParts(params, allocateTextDeltaId).pipe(
            Effect.flatMap(parts =>
              Effect.forEach(
                parts,
                part => offerToCurrent({ _tag: "Part", part }),
                { discard: true },
              )),
          ),
        )
      },
    }

    const stream = acp.ndJsonStream(bytes.stdin, bytes.stdout)
    const connection = new acp.ClientSideConnection(() => client, stream)

    const acquireFailed = (op: string, description: string) => (cause: unknown) =>
      new AiError.UnknownError({
        module: MODULE,
        method: "acquire",
        description,
        cause: new AdapterProtocolError({ op, message: description, cause }),
      })

    yield* Effect.tryPromise({
      try: () =>
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
      catch: acquireFailed("initialize", "ACP initialize failed"),
    })

    const session = yield* Effect.tryPromise({
      try: () =>
        connection.newSession({
          cwd: globalThis.process.cwd(),
          mcpServers: [],
        }),
      catch: acquireFailed("newSession", "ACP newSession failed"),
    })
    const sessionId = session.sessionId

    yield* Effect.addFinalizer(() =>
      Ref.get(currentTurnRef).pipe(
        Effect.flatMap(maybe =>
          Option.match(maybe, {
            onNone: () => Effect.void,
            onSome: turn =>
              Queue.offer(turn.queue, { _tag: "Fail", error: cancelledError() }).pipe(
                Effect.asVoid,
              ),
          }),
        ),
        Effect.zipRight(
          Effect.tryPromise(() => connection.cancel({ sessionId })).pipe(Effect.ignore),
        ),
      ),
    )

    // firegrid-effect-ai-native-agents.ACP_ADAPTER.2
    // Each turn is a scoped resource: the lock + ref + spawned prompt
    // fiber are tied to the stream's scope, so multi-turn calls
    // serialize cleanly and a stream interruption tears down its
    // turn before the next turn can acquire the lock.
    const setupTurn = (
      rawInput: Prompt.RawInput,
    ): Effect.Effect<Queue.Queue<TurnSignal>, AiError.AiError, Scope.Scope> =>
      Effect.gen(function*() {
        const queue = yield* Queue.unbounded<TurnSignal>()
        yield* Ref.set(currentTurnRef, Option.some({ queue }))
        yield* Ref.set(textDeltaIdRef, undefined)

        const promptValue = Prompt.make(rawInput)
        const userContent = yield* promptToAcpContent(promptValue).pipe(
          Effect.mapError(cause =>
            new AiError.MalformedInput({
              module: MODULE,
              method: "streamText",
              description: cause.message,
              cause,
            })),
        )

        // firegrid-effect-ai-native-agents.ACP_ADAPTER.9
        const turnContext = yield* Effect.serviceOption(CurrentAgentTurn)
        const correlationId = Option.match(turnContext, {
          onNone: () => undefined,
          onSome: turn => turn.turnId,
        })

        const sendPrompt = Effect.tryPromise({
          try: () =>
            connection.prompt({
              sessionId,
              prompt: userContent,
              ...(correlationId === undefined ? {} : { messageId: correlationId }),
            }),
          catch: promptFailedError,
        }).pipe(
          Effect.matchEffect({
            onFailure: error =>
              Queue.offer(queue, { _tag: "Fail", error }).pipe(Effect.asVoid),
            onSuccess: response =>
              Queue.offer(queue, {
                _tag: "Finish",
                reason: acpStopReasonToFinishReason(response.stopReason),
              }).pipe(Effect.asVoid),
          }),
        )

        yield* Effect.forkScoped(sendPrompt)

        return queue
      })

    const consumeTurn = (
      queue: Queue.Queue<TurnSignal>,
    ): Stream.Stream<AcpStreamPart, AiError.AiError> =>
      Stream.fromQueue(queue).pipe(
        Stream.takeUntil(signal => signal._tag !== "Part"),
        Stream.mapEffect((signal): Effect.Effect<AcpStreamPart, AiError.AiError> => {
          if (signal._tag === "Fail") {
            return Effect.fail(signal.error)
          }
          if (signal._tag === "Finish") {
            return Effect.succeed(
              Response.finishPart({
                reason: signal.reason,
                usage: new Response.Usage({
                  inputTokens: undefined,
                  outputTokens: undefined,
                  totalTokens: undefined,
                }),
              }),
            )
          }
          return Effect.succeed(signal.part)
        }),
        Stream.ensuring(Ref.set(currentTurnRef, Option.none())),
      )

    // firegrid-effect-ai-native-agents.ACP_ADAPTER.7
    const generateText = (
      options: { readonly prompt: Prompt.RawInput; readonly toolkit?: unknown },
    ): Effect.Effect<LanguageModel.GenerateTextResponse<Record<string, never>>, AiError.AiError> =>
      Effect.gen(function*() {
        if (options.toolkit !== undefined) {
          return yield* toolkitUnsupportedError("generateText")
        }
        return yield* turnLock.withPermits(1)(
          Effect.scoped(
            Effect.gen(function*() {
              const queue = yield* setupTurn(options.prompt)
              const collected = yield* consumeTurn(queue).pipe(Stream.runCollect)
              return new LanguageModel.GenerateTextResponse(
                aggregateStreamPartsForGenerateText(Chunk.toReadonlyArray(collected)),
              )
            }),
          ),
        )
      })

    // firegrid-effect-ai-native-agents.ACP_ADAPTER.8
    const generateObject = (): Effect.Effect<never, AiError.AiError> =>
      Effect.fail(generateObjectUnsupportedError())

    // firegrid-effect-ai-native-agents.ACP_ADAPTER.3
    // firegrid-effect-ai-native-agents.ACP_ADAPTER.4
    // firegrid-effect-ai-native-agents.ACP_ADAPTER.5
    const streamText = (
      options: { readonly prompt: Prompt.RawInput; readonly toolkit?: unknown },
    ): Stream.Stream<AcpStreamPart, AiError.AiError> => {
      if (options.toolkit !== undefined) {
        return Stream.fail(toolkitUnsupportedError("streamText"))
      }
      return Stream.unwrapScoped(
        Effect.gen(function*() {
          yield* Effect.acquireRelease(
            turnLock.take(1),
            () => turnLock.release(1),
          )
          const queue = yield* setupTurn(options.prompt)
          return consumeTurn(queue)
        }),
      )
    }

    const languageModel: LanguageModel.Service = {
      generateText: generateText as LanguageModel.Service["generateText"],
      generateObject: generateObject as LanguageModel.Service["generateObject"],
      streamText: streamText as LanguageModel.Service["streamText"],
    }

    return {
      capabilities: AcpAdapterCapabilities,
      languageModel,
    } satisfies AgentAdapterService
  })

export const AcpAgentAdapter = {
  /**
   * Layer that acquires an ACP `ClientSideConnection` + session over
   * the supplied `AgentByteStream` and exposes it as an
   * `AgentAdapter` whose `languageModel` is an Effect AI
   * `LanguageModel.Service`.
   *
   * Acquisition failures surface as `AiError.UnknownError`. The
   * session is cancelled when the adapter scope finalizes.
   */
  // firegrid-effect-ai-native-agents.ACP_ADAPTER.1
  // firegrid-effect-ai-native-agents.ACP_ADAPTER.2
  layer: (
    options: AcpAgentAdapterOptions,
  ): Layer.Layer<AgentAdapter, AiError.AiError, never> =>
    Layer.scoped(AgentAdapter, makeAcpAgentAdapter(options)),
} as const
