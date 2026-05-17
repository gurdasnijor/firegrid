import * as acp from "@agentclientprotocol/sdk"
import { IdGenerator, Prompt, Response } from "@effect/ai"
import { DurableDeferred, WorkflowEngine } from "@effect/workflow"
import { Effect, Exit, Layer, Match, Option, Queue, Ref, Runtime, Stream } from "effect"
import type {
  AgentCapabilities,
  AgentInputEvent,
  AgentOutputEvent,
  PermissionDecision,
  PermissionOption,
} from "../../events/index.ts"
import { PermissionDecisionSchema } from "../../events/index.ts"
import type { AgentByteStream } from "../../sources/byte-stream.ts"
import { AgentCodecError, AgentSession } from "../contract.ts"
import {
  acpStopReasonToFinishReason,
  acpUserPromptPartToContentBlock,
} from "./mapping.ts"

const codec = "acp"

export interface AcpMcpServerDeclaration {
  readonly name: string
  readonly server: {
    readonly type: "url"
    readonly url: string
    readonly headers?: ReadonlyArray<{
      readonly name: string
      readonly value: string
    }>
  }
}

export interface AcpSessionOptions {
  readonly cwd?: string
  readonly mcpServers?: ReadonlyArray<AcpMcpServerDeclaration>
}

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
  declaration: AcpMcpServerDeclaration,
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

const makePermissionRequestId = (
  idGenerator: IdGenerator.Service,
): Effect.Effect<string> =>
  idGenerator.generateId().pipe(
    Effect.map(id => `permission_${id}`),
  )

const permissionDeferred = (permissionRequestId: string) =>
  DurableDeferred.make(`permission-${permissionRequestId}`, {
    success: PermissionDecisionSchema,
  })

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
          providerExecuted: true,
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

export const AcpSessionLive = (
  bytes: AgentByteStream,
  options: AcpSessionOptions = {},
): Layer.Layer<AgentSession, AgentCodecError, IdGenerator.IdGenerator> =>
  Layer.scoped(
    AgentSession,
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const idGenerator = yield* IdGenerator.IdGenerator
      const workflowEngine = yield* Effect.serviceOption(WorkflowEngine.WorkflowEngine)
      const workflowInstance = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance)
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)
      const outputEvents = yield* Queue.unbounded<AgentOutputEvent>()
      const currentTextDeltaId = yield* Ref.make<string | undefined>(undefined)
      const pendingPermissionIds = yield* Ref.make<ReadonlySet<string>>(new Set())
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
            return idGenerator.generateId().pipe(
              Effect.tap(id => Ref.set(currentTextDeltaId, id)),
            )
          }),
        )
      }

      const durablePermissionContext = (): Effect.Effect<
        {
          readonly engine: WorkflowEngine.WorkflowEngine["Type"]
          readonly instance: WorkflowEngine.WorkflowInstance["Type"]
        },
        AgentCodecError
      > =>
        Option.match(workflowEngine, {
          onNone: () =>
            Effect.fail(codecError(
              "permission",
              "ACP durable permission continuation requires WorkflowEngine",
            )),
          onSome: engine =>
            Option.match(workflowInstance, {
              onNone: () =>
                Effect.fail(codecError(
                  "permission",
                  "ACP durable permission continuation requires WorkflowInstance",
                )),
              onSome: instance => Effect.succeed({ engine, instance }),
            }),
        })

      const awaitPermissionDecision = (
        permissionRequestId: string,
      ): Effect.Effect<PermissionDecision, AgentCodecError> =>
        Effect.gen(function*() {
          const { engine, instance } = yield* durablePermissionContext()
          const deferred = permissionDeferred(permissionRequestId)
          const poll = (): Effect.Effect<PermissionDecision, AgentCodecError> => Effect.gen(function*() {
            const exit = yield* engine.deferredResult(deferred).pipe(
              Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
            )
            if (exit === undefined) {
              yield* Effect.sleep("20 millis")
              return yield* poll()
            }
            return yield* exit
          })
          return yield* poll().pipe(
            Effect.ensuring(Ref.update(pendingPermissionIds, ids => {
              const next = new Set(ids)
              next.delete(permissionRequestId)
              return next
            })),
          )
        })

      const completePermissionDecision = (
        permissionRequestId: string,
        decision: PermissionDecision,
      ): Effect.Effect<void, AgentCodecError> =>
        Effect.gen(function*() {
          const { engine, instance } = yield* durablePermissionContext()
          const deferred = permissionDeferred(permissionRequestId)
          const token = DurableDeferred.tokenFromExecutionId(deferred, {
            workflow: instance.workflow,
            executionId: instance.executionId,
          })
          yield* DurableDeferred.done(deferred, {
            token,
            exit: Exit.succeed(decision),
          }).pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            Effect.orDie,
          )
        })

      const cancelPendingPermissions = Effect.gen(function*() {
        const ids = yield* Ref.get(pendingPermissionIds)
        yield* Effect.forEach(
          ids,
          id => completePermissionDecision(id, { _tag: "Cancelled" }),
          { discard: true },
        )
        yield* Ref.set(pendingPermissionIds, new Set())
      })

      const client: acp.Client = {
        requestPermission: async params => {
          const permissionRequestId = await runPromise(makePermissionRequestId(idGenerator))
          await runPromise(Ref.update(pendingPermissionIds, ids => new Set(ids).add(permissionRequestId)))
          await emit({
            _tag: "PermissionRequest",
            permissionRequestId,
            toolUseId: params.toolCall.toolCallId,
            options: mapPermissionOptions(params.options),
          })
          const decision = await runPromise(awaitPermissionDecision(permissionRequestId))
          return permissionResponse(decision, params.options)
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
          cwd: options.cwd ?? globalThis.process.cwd(),
          // firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.7
          // firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.9
          // ACP does not consume FiregridAgentToolkit directly.
          // Tool execution is owned by the ACP agent process or delegated
          // through ACP session.mcpServers/MCP.
          mcpServers: (options.mcpServers ?? []).map(lowerMcpServerDeclaration),
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
          yield* completePermissionDecision(event.permissionRequestId, event.decision)
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

      return {
        meta: {
          kind: codec,
          capabilities: AcpCapabilities,
        },
        toolUseMode: "observation_only",
        send,
        outputs,
      }
    }),
  )
