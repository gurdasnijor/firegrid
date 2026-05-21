import * as acp from "@agentclientprotocol/sdk"
import { AiError, IdGenerator, LanguageModel, Prompt, Response } from "@effect/ai"
import {
  Chunk,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Runtime,
  type Scope,
  Stream,
} from "effect"
import type { AgentByteStream } from "../../agent-event-pipeline/sources/byte-stream.ts"
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
  readonly turnId: string | undefined
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
// firegrid-effect-ai-native-agents.ACP_ADAPTER.9
const permissionRequiredError = (
  toolCallId: string | undefined,
  turnId: string | undefined,
): AiError.UnknownError =>
  new AiError.UnknownError({
    module: MODULE,
    method: "streamText",
    description:
      "ACP requested permission but no PermissionedAdapter capability is installed",
    cause: new PermissionRequiredButNotHandled({
      ...(turnId === undefined ? {} : { turnId }),
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
// Aggregate streaming text deltas into non-streaming text parts while
// preserving the relative order between text runs, tool calls, and
// finish. Buffered text MUST be flushed before any non-text-delta
// part is appended; otherwise an ACP turn that streams
// `text-delta -> tool-call -> finish` would surface as
// `[tool-call, finish, text]` because buffered text would only flush
// at end-of-array.
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
  const flushAll = (): void => {
    Array.from(buffers.keys()).forEach(flushBuffer)
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
      flushAll()
      out.push(part)
    }
  })
  flushAll()
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

  // firegrid-effect-ai-native-agents.ACP_ADAPTER.14
  //
  // Optional ACP session setup. Forwarded as-is to
  // `connection.newSession(...)`. Callers that want to expose a
  // Firegrid MCP runtime-context URL to the spawned agent supply it
  // here through ACP's own `mcpServers` field — there is no env
  // coupling and no Firegrid-custom protocol.
  //
  // Defaults preserve the prior behavior: `cwd` defaults to
  // `globalThis.process.cwd()`, `mcpServers` defaults to `[]`.
  readonly session?: {
    readonly cwd?: string
    readonly mcpServers?: ReadonlyArray<acp.McpServer>
  }
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

    const failCurrent = (error: AiError.AiError): Effect.Effect<void> =>
      offerToCurrent({ _tag: "Fail", error })

    const client: acp.Client = {
      // firegrid-effect-ai-native-agents.ACP_ADAPTER.6
      // firegrid-effect-ai-native-agents.ACP_ADAPTER.12
      //
      // Defensive: ACP invokes this callback on its own event loop.
      // If the adapter scope/runtime is already torn down, runPromise
      // will throw; we still owe ACP a response so its prompt() call
      // can resolve. Always reply `cancelled`, even when we cannot
      // notify a (gone) turn queue.
      requestPermission: async params => {
        try {
          const turn = await runPromise(Ref.get(currentTurnRef))
          const turnId = Option.match(turn, {
            onNone: () => undefined,
            onSome: state => state.turnId,
          })
          await runPromise(
            failCurrent(permissionRequiredError(params.toolCall.toolCallId, turnId)),
          )
        } catch {
          // Adapter runtime is gone; nothing to notify. Fall through
          // to the cancelled outcome so ACP does not hang.
        }
        return { outcome: { outcome: "cancelled" } }
      },
      sessionUpdate: async params => {
        try {
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
        } catch {
          // Adapter runtime is gone; the update has no live consumer.
          // ACP notifications are fire-and-forget, so swallowing
          // here keeps ACP's event loop healthy.
        }
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

    // firegrid-effect-ai-native-agents.ACP_ADAPTER.14
    const sessionSetup = options.session
    const newSessionRequest: acp.NewSessionRequest = {
      cwd: sessionSetup?.cwd ?? globalThis.process.cwd(),
      mcpServers: sessionSetup?.mcpServers === undefined
        ? []
        : [...sessionSetup.mcpServers],
    }
    const session = yield* Effect.tryPromise({
      try: () => connection.newSession(newSessionRequest),
      catch: acquireFailed("newSession", "ACP newSession failed"),
    })
    const sessionId = session.sessionId

    yield* Effect.addFinalizer(() =>
      failCurrent(cancelledError()).pipe(
        Effect.zipRight(
          Effect.tryPromise(() => connection.cancel({ sessionId })).pipe(Effect.ignore),
        ),
      ),
    )

    // firegrid-effect-ai-native-agents.ACP_ADAPTER.2
    // firegrid-effect-ai-native-agents.ACP_ADAPTER.13
    //
    // Each turn is a scoped resource. The prompt fiber is tracked
    // explicitly so a stream-interruption teardown can:
    //   1. send `connection.cancel({ sessionId })` to ACP, telling
    //      the agent to abort the in-flight turn
    //   2. await the prompt fiber via Fiber.await, ensuring the ACP
    //      Promise has resolved (with stopReason "cancelled") before
    //      the next turn can acquire the lock
    //   3. clear `currentTurnRef` so late ACP callbacks cannot route
    //      stale updates into a subsequent turn's queue
    //
    // The finalizer is added INSIDE the per-turn scope, while the
    // turn-lock release is added by the outer caller; Effect runs
    // scope finalizers LIFO, so cancel + await + clear-ref complete
    // before the permit is released and the next turn can begin.
    const setupTurn = (
      rawInput: Prompt.RawInput,
    ): Effect.Effect<Queue.Queue<TurnSignal>, AiError.AiError, Scope.Scope> =>
      Effect.gen(function*() {
        // firegrid-effect-ai-native-agents.ACP_ADAPTER.9
        // CurrentAgentTurn is adapter-local correlation only. It is
        // captured into TurnState so Firegrid-side observations (e.g.
        // PermissionRequiredButNotHandled) can carry the active turnId,
        // but it is NEVER sent on the ACP wire: PromptRequest.messageId
        // and PromptResponse.userMessageId are non-spec echo fields and
        // not a portable correlation contract.
        const turnContext = yield* Effect.serviceOption(CurrentAgentTurn)
        const turnId = Option.match(turnContext, {
          onNone: () => undefined,
          onSome: turn => turn.turnId,
        })
        const queue = yield* Queue.unbounded<TurnSignal>()
        yield* Ref.set(currentTurnRef, Option.some({ queue, turnId }))
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

        const sendPrompt = Effect.tryPromise({
          try: () =>
            connection.prompt({
              sessionId,
              prompt: userContent,
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

        const promptFiber = yield* Effect.fork(sendPrompt)

        yield* Effect.addFinalizer(() =>
          Effect.tryPromise(() => connection.cancel({ sessionId })).pipe(
            Effect.ignore,
            Effect.zipRight(Fiber.await(promptFiber).pipe(Effect.ignore)),
            Effect.zipRight(Ref.set(currentTurnRef, Option.none())),
          ),
        )

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
