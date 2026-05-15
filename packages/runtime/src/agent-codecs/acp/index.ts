import * as acp from "@agentclientprotocol/sdk"
import { IdGenerator, Prompt, Response } from "@effect/ai"
import { Effect, Match, Queue, Ref, Runtime, Stream } from "effect"
import type {
  AgentByteStream,
  AgentCapabilities,
  AgentCodec,
  AgentMcpServerDeclaration,
  AgentInputEvent,
  AgentOutputEvent,
  PermissionDecision,
  PermissionOption,
} from "../../agent-io/index.ts"
import { AgentCodecError } from "../../agent-io/index.ts"
import {
  acpStopReasonToFinishReason,
  acpUserPromptPartToContentBlock,
} from "./mapping.ts"

const codec = "acp"

export const AcpCapabilities: AgentCapabilities = {
  streamingText: true,
  tools: true,
  permissions: true,
  images: false,
  structuredInput: false,
  cancellation: true,
  multiTurn: true,
  customStatus: ["tool_call_update"],
}

const codecError = (op: string, message: string, cause?: unknown): AgentCodecError => {
  const details = cause === undefined ? {} : { cause }
  return new AgentCodecError({
    codec,
    op,
    message,
    ...details,
  })
}

const acpPromise = <A>(
  op: string,
  message: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, AgentCodecError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: cause => codecError(op, message, cause),
  })

const recoverableError = (message: string, cause?: unknown): AgentOutputEvent => {
  const eventCause = cause === undefined ? { message } : { message, cause }
  return {
    _tag: "Error",
    cause: eventCause,
    recoverable: true,
  }
}

const promptUserParts = (
  event: Extract<AgentInputEvent, { _tag: "Prompt" }>,
): ReadonlyArray<Prompt.UserMessagePart> =>
  event.prompt.content

const mapUserPromptPart = (
  part: Prompt.UserMessagePart,
): Effect.Effect<acp.ContentBlock, AgentCodecError> =>
  acpUserPromptPartToContentBlock(part).pipe(
    Effect.mapError(error =>
      codecError("send", `ACP codec does not support ${error.partType} prompt parts`),
    ),
  )

const mapPromptContent = (
  event: Extract<AgentInputEvent, { _tag: "Prompt" }>,
): Effect.Effect<Array<acp.ContentBlock>, AgentCodecError> =>
  Effect.forEach(promptUserParts(event), mapUserPromptPart)

const mapPermissionOptions = (
  options: ReadonlyArray<acp.PermissionOption>,
): Array<PermissionOption> =>
  options.map(option => ({
    optionId: option.optionId,
    kind: option.kind,
    name: option.name,
  }))

const lowerMcpServerDeclaration = (
  declaration: AgentMcpServerDeclaration,
): acp.McpServer => ({
  type: "http",
  name: declaration.name,
  url: declaration.server.url,
  headers: declaration.server.headers === undefined
    ? []
    : declaration.server.headers.map(header => ({
      name: header.name,
      value: header.value,
    })),
})

const selectedOptionId = (
  decision: PermissionDecision,
  options: ReadonlyArray<acp.PermissionOption>,
): string | undefined =>
  Match.value(decision).pipe(
    Match.tag("Allow", allow =>
      allow.optionId ??
        options.find(option => option.kind === "allow_once" || option.kind === "allow_always")
          ?.optionId),
    Match.tag("Deny", () =>
      options.find(option => option.kind === "reject_once" || option.kind === "reject_always")
        ?.optionId),
    Match.tag("Cancelled", () => undefined),
    Match.exhaustive,
  )

const permissionResponse = (
  decision: PermissionDecision,
  options: ReadonlyArray<acp.PermissionOption>,
): acp.RequestPermissionResponse => {
  const optionId = selectedOptionId(decision, options)
  if (optionId === undefined) {
    return { outcome: { outcome: "cancelled" } }
  }
  return { outcome: { outcome: "selected", optionId } }
}

const status = (
  kind: string,
  payload?: unknown,
): AgentOutputEvent => ({
  _tag: "Status",
  kind,
  ...(payload === undefined ? {} : { payload }),
})

const mapSessionUpdate = (
  params: acp.SessionNotification,
  textDeltaId: (messageId: string | undefined) => Effect.Effect<string>,
): Effect.Effect<ReadonlyArray<AgentOutputEvent>> => {
  const update = params.update
  return Match.value(update).pipe(
    Match.when({ sessionUpdate: "agent_message_chunk" }, update => {
      const content = update.content
      if (content.type !== "text") {
        return Effect.succeed([status("agent_message_chunk", update)])
      }
      return textDeltaId(update.messageId ?? undefined).pipe(
        Effect.map(id => [{
          _tag: "TextChunk" as const,
          part: Response.textDeltaPart({
            id,
            delta: content.text,
          }),
        }]),
      )
    }),
    Match.when({ sessionUpdate: "tool_call" }, update =>
      Effect.succeed([{
        _tag: "ToolUse" as const,
        part: Prompt.toolCallPart({
          id: update.toolCallId,
          name: update.title,
          params: update.rawInput,
          providerExecuted: false,
        }),
      }])),
    Match.when({ sessionUpdate: "tool_call_update" }, update =>
      Effect.succeed([status("tool_call_update", update)])),
    Match.orElse(update => Effect.succeed([status(update.sessionUpdate, update)])),
  )
}

const terminatedEvent = (
  bytes: AgentByteStream,
): Stream.Stream<AgentOutputEvent, AgentCodecError> =>
  bytes.exit.pipe(
    Effect.map(exit => {
      const maybeCode = exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }
      return {
        _tag: "Terminated" as const,
        ...maybeCode,
      }
    }),
    Effect.mapError(cause =>
      codecError("exit", "failed waiting for ACP process exit", cause),
    ),
    Stream.fromEffect,
  )

export const AcpCodec: AgentCodec = {
  kind: codec,
  capabilities: AcpCapabilities,
  open: (bytes, options = {}) =>
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)
      const outputEvents = yield* Queue.unbounded<AgentOutputEvent>()
      const currentTextDeltaId = yield* Ref.make<string | undefined>(undefined)
      const emitEffect = (event: AgentOutputEvent): Effect.Effect<void> =>
        Queue.offer(outputEvents, event).pipe(Effect.asVoid)
      const emit = (event: AgentOutputEvent): Promise<void> =>
        runPromise(emitEffect(event))
      const textDeltaId = (
        messageId: string | undefined,
      ): Effect.Effect<string> => {
        if (messageId !== undefined) {
          return Effect.succeed(messageId)
        }
        return Ref.get(currentTextDeltaId).pipe(
          Effect.flatMap(existing => {
            if (existing !== undefined) {
              return Effect.succeed(existing)
            }
            return IdGenerator.defaultIdGenerator.generateId().pipe(
              Effect.tap(id => Ref.set(currentTextDeltaId, id)),
            )
          }),
        )
      }

      const pendingPermissions = new Map<
        string,
        {
          readonly options: ReadonlyArray<acp.PermissionOption>
          readonly resolve: (response: acp.RequestPermissionResponse) => void
        }
      >()
      let permissionCounter = 0

      const registerPermission = (
        permissionRequestId: string,
        entry: {
          readonly options: ReadonlyArray<acp.PermissionOption>
          readonly resolve: (response: acp.RequestPermissionResponse) => void
        },
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          pendingPermissions.set(permissionRequestId, entry)
        })

      const takePermission = (
        permissionRequestId: string,
      ): Effect.Effect<
        | {
          readonly options: ReadonlyArray<acp.PermissionOption>
          readonly resolve: (response: acp.RequestPermissionResponse) => void
        }
        | undefined
      > =>
        Effect.sync(() => {
          const pending = pendingPermissions.get(permissionRequestId)
          if (pending !== undefined) {
            pendingPermissions.delete(permissionRequestId)
          }
          return pending
        })

      const cancelPendingPermissions = Effect.sync(() => {
        for (const { resolve } of pendingPermissions.values()) {
          resolve({ outcome: { outcome: "cancelled" } })
        }
        pendingPermissions.clear()
      })

      const client: acp.Client = {
        requestPermission: async params => {
          const permissionRequestId = `permission-${++permissionCounter}`
          let resolveResponse: (response: acp.RequestPermissionResponse) => void = () => {}
          const response = new Promise<acp.RequestPermissionResponse>(resolve => {
            resolveResponse = resolve
          })
          await runPromise(
            registerPermission(permissionRequestId, {
              options: params.options,
              resolve: resolveResponse,
            }),
          )
          await emit({
            _tag: "PermissionRequest",
            permissionRequestId,
            toolUseId: params.toolCall.toolCallId,
            options: mapPermissionOptions(params.options),
          })
          return await response
        },
        sessionUpdate: async params => {
          await runPromise(
            mapSessionUpdate(params, textDeltaId).pipe(
              Effect.flatMap(events => Effect.forEach(events, emitEffect, { discard: true })),
            ),
          )
        },
      }

      const stream = acp.ndJsonStream(bytes.stdin, bytes.stdout)
      const connection = new acp.ClientSideConnection(() => client, stream)

      yield* acpPromise("initialize", "failed to initialize ACP connection", () =>
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }))

      const session = yield* acpPromise("newSession", "failed to create ACP session", () =>
        connection.newSession({
          cwd: options.session?.cwd ?? globalThis.process.cwd(),
          mcpServers: (options.session?.mcpServers ?? []).map(lowerMcpServerDeclaration),
        }))
      const sessionId = session.sessionId

      const sendPrompt = (
        event: Extract<AgentInputEvent, { _tag: "Prompt" }>,
      ): Effect.Effect<void, AgentCodecError> =>
        Effect.gen(function*() {
          const prompt = yield* mapPromptContent(event)
          yield* acpPromise("prompt", "ACP prompt failed", () =>
            connection.prompt({
              sessionId,
              messageId: event.correlationId,
              prompt,
            })).pipe(
              Effect.matchEffect({
                onFailure: error =>
                  Ref.set(currentTextDeltaId, undefined).pipe(
                    Effect.zipRight(emitEffect(recoverableError("ACP prompt failed", error.cause))),
                  ),
                onSuccess: response =>
                  Ref.set(currentTextDeltaId, undefined).pipe(
                    Effect.zipRight(
                      emitEffect({
                        _tag: "TurnComplete",
                        finishReason: acpStopReasonToFinishReason(response.stopReason),
                        ...(response.userMessageId === undefined || response.userMessageId === null
                          ? {}
                          : { messageId: response.userMessageId }),
                      }),
                    ),
                  ),
              }),
              Effect.forkIn(scope),
            )
        }).pipe(Effect.asVoid)

      const sendPermissionResponse = (
        event: Extract<AgentInputEvent, { _tag: "PermissionResponse" }>,
      ): Effect.Effect<void, AgentCodecError> =>
        Effect.gen(function*() {
          const pending = yield* takePermission(event.permissionRequestId)
          if (pending === undefined) {
            return yield* Effect.fail(
              codecError(
                "send",
                `unknown ACP permission request ${event.permissionRequestId}`,
              ),
            )
          }
          yield* Effect.sync(() => {
            pending.resolve(permissionResponse(event.decision, pending.options))
          })
        })

      const sendCancel = (): Effect.Effect<void, AgentCodecError> =>
        Effect.gen(function*() {
          yield* cancelPendingPermissions
          yield* acpPromise("cancel", "failed to cancel ACP session", () =>
            connection.cancel({ sessionId }))
        })

      const sendTerminate = (): Effect.Effect<void, AgentCodecError> =>
        Effect.acquireUseRelease(
          Effect.sync(() => bytes.stdin.getWriter()),
          writer =>
            Effect.tryPromise({
              try: () => writer.close(),
              catch: cause =>
                codecError("terminate", "failed to close ACP byte stream stdin", cause),
            }),
          writer => Effect.sync(() => writer.releaseLock()),
        )

      const sendToolResult = (): Effect.Effect<void, AgentCodecError> =>
        Effect.fail(
          codecError(
            "send",
            "ACP ToolResult input is out-of-band for this codec slice",
          ),
        )

      const send = (event: AgentInputEvent): Effect.Effect<void, AgentCodecError> =>
        Match.value(event).pipe(
          Match.tag("Prompt", sendPrompt),
          Match.tag("PermissionResponse", sendPermissionResponse),
          Match.tag("Cancel", sendCancel),
          Match.tag("Terminate", sendTerminate),
          Match.tag("ToolResult", sendToolResult),
          Match.exhaustive,
        )

      const outputs = Stream.succeed<AgentOutputEvent>({
        _tag: "Ready",
        capabilities: AcpCapabilities,
      }).pipe(
        Stream.concat(
          Stream.fromQueue(outputEvents).pipe(
            Stream.merge(terminatedEvent(bytes)),
            Stream.takeUntil(event => event._tag === "Terminated"),
          ),
        ),
      )

      return { send, outputs }
    }),
}
