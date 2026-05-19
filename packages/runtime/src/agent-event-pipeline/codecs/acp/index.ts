import * as acp from "@agentclientprotocol/sdk"
import { IdGenerator, Prompt, Response } from "@effect/ai"
import { Deferred, Effect, Layer, Match, Queue, Ref, Runtime, Stream } from "effect"
import type {
  AgentCapabilities,
  AgentInputEvent,
  AgentOutputEvent,
  PermissionDecision,
  PermissionOption,
} from "../../events/index.ts"
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

// tf-ds2: a thrown ACP failure carries the real reason in a JSON-RPC
// `{ code, message, data }` error (jsonrpc.d.ts) or a plain `Error`. The
// static op message ("ACP prompt failed") is not legible in the trace; the
// underlying agent message (e.g. a provider quota error) lives in `cause`.
// Extract it so it can be composed into the human-readable message
// additively — `cause` is still preserved unchanged.
const jsonRpcErrorMessage = (cause: unknown): string | undefined => {
  if (typeof cause === "string") return cause.length > 0 ? cause : undefined
  if (typeof cause !== "object" || cause === null) return undefined
  const record = cause as {
    readonly message?: unknown
    readonly code?: unknown
    readonly data?: unknown
  }
  const message = typeof record.message === "string" && record.message.length > 0
    ? record.message
    : undefined
  if (message === undefined) return undefined
  const code = typeof record.code === "number" ? ` (code ${record.code})` : ""
  const data = record.data === undefined
    ? ""
    : `: ${typeof record.data === "string" ? record.data : JSON.stringify(record.data)}`
  return `${message}${code}${data}`
}

const codecError = (op: string, message: string, cause?: unknown): AgentCodecError => {
  const details = cause === undefined ? {} : { cause }
  const underlying = cause === undefined ? undefined : jsonRpcErrorMessage(cause)
  return new AgentCodecError({
    codec,
    op,
    // tf-ds2: surface the underlying agent/JSON-RPC reason in the message
    // so the trace artifact is legible (factory-vision §7.7). Additive —
    // no behavior change; `cause` is unchanged.
    message: underlying === undefined ? message : `${message}: ${underlying}`,
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

// tf-b6n / A1 (#408 tf-p9s): claude-agent-acp (Claude Agent SDK) defers MCP
// tools behind a `ToolSearch` discovery indirection; the §6 planner stalls
// after ToolSearch and never issues a Firegrid `tools/call` (#405). The
// Claude Agent SDK's only no-defer lever is per-MCP-server
// `McpHttpServerConfig.alwaysLoad:true` ("all tools … always included …
// never deferred behind tool search"), but claude-agent-acp strips
// `alwaysLoad` from the ACP-advertised `mcpServers` and its
// `mcpServers: {...userProvidedOptions, ...acpDerived}` merge overrides any
// `_meta.claudeCode.options` entry that COLLIDES by server name.
//
// So we additively attach an ACP `_meta` payload (reserved namespace; other
// ACP agents MUST NOT assume values at `_meta` keys, so non-claude paths are
// unchanged) that re-advertises the same runtime-context MCP server under a
// NON-COLLIDING alias with `alwaysLoad:true`, and sets `disableBuiltInTools`
// so the planner's tool set is just the Firegrid catalog (no claude_code
// built-ins inflating the set past the tool-search threshold). Both are the
// documented Claude Agent SDK / claude-agent-acp levers; this is the minimal
// fix fully in Firegrid's control to make §6 actually run.
const claudeAgentAcpAlwaysLoadMeta = (
  declarations: ReadonlyArray<AcpMcpServerDeclaration>,
): { readonly [key: string]: unknown } | undefined => {
  if (declarations.length === 0) return undefined
  const mcpServers = Object.fromEntries(
    declarations.map(declaration => {
      const headers = declaration.server.headers === undefined
        ? undefined
        : Object.fromEntries(
          declaration.server.headers.map(header => [header.name, header.value]),
        )
      return [
        `${declaration.name}-alwaysload`,
        {
          type: "http" as const,
          url: declaration.server.url,
          ...(headers === undefined ? {} : { headers }),
          alwaysLoad: true as const,
        },
      ] as const
    }),
  )
  return {
    // Shrink the planner tool set to the Firegrid catalog so tool-search
    // does not engage (documented fallback per the A1 finding).
    disableBuiltInTools: true,
    claudeCode: { options: { mcpServers } },
  }
}

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

const status = (
  kind: string,
  payload?: unknown,
): AgentOutputEvent => ({
  _tag: "Status",
  kind,
  ...(payload === undefined ? {} : { payload }),
})

// tf-2p4: ACP `tool_call`/`tool_call_update` carry no canonical tool-name
// field — only a human `title` (mapping.ts documents this). For
// MCP-bridged tools the ACP client uses the standard
// `mcp__<server>__<tool>` identifier convention (source-verified:
// docs/investigations/2026-05-19-s6-dark-factory-live-run.md observed
// `mcp__firegrid-runtime-context__wait_for`). Surface the CANONICAL MCP
// tool name (the `<tool>` segment) so strict, exact-match harnesses
// (the #401 §6 proof) see the truth instead of the display title.
// Deterministic + backward-compatible: a non-`mcp__` title (e.g.
// "lookup", "edit config") is returned unchanged. No matcher loosening
// — the codec emits the canonical identifier; the harness stays strict.
const canonicalAcpToolName = (title: string): string => {
  const segments = title.split("__")
  return segments.length >= 3 && segments[0] === "mcp"
    ? segments.slice(2).join("__")
    : title
}

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
          name: canonicalAcpToolName(update.title),
          params: update.rawInput,
          providerExecuted: true,
        }),
      }])),
    // tf-ds2: ACP agents commonly send the initial `tool_call` with status
    // `pending` and NO `rawInput`, then stream the real arguments (and
    // `rawOutput`) in subsequent `tool_call_update` notifications
    // (schema/types.gen: ToolCallUpdate.rawInput?). Collapsing every update
    // to an opaque `status` dropped those arguments, so the trace showed
    // tool inputs as `{}`. When an update carries `rawInput`, also emit a
    // ToolUse so `observedToolInputs` is real. This is observation-only:
    // the runtime-context workflow skips the tool executor for the `acp`
    // protocol (ACP tool calls are provider-executed), so this changes
    // nothing but observability.
    Match.when({ sessionUpdate: "tool_call_update" }, update =>
      Effect.succeed(
        update.rawInput === undefined
          ? [status("tool_call_update", update)]
          : [
            {
              _tag: "ToolUse" as const,
              part: Prompt.toolCallPart({
                id: update.toolCallId,
                name: update.title === undefined || update.title === null
                  ? "tool_call"
                  : canonicalAcpToolName(update.title),
                params: update.rawInput,
                providerExecuted: true,
              }),
            },
            status("tool_call_update", update),
          ],
      )),
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
    Effect.withSpan("firegrid.agent_event_pipeline.acp.exit", {
      kind: "consumer",
    }),
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
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)
      const outputEvents = yield* Queue.unbounded<AgentOutputEvent>()
      const currentTextDeltaId = yield* Ref.make<string | undefined>(undefined)
      const pendingPermissions = yield* Ref.make<
        ReadonlyMap<string, Deferred.Deferred<PermissionDecision>>
      >(new Map())
      const emitEffect = (event: AgentOutputEvent): Effect.Effect<void> =>
        Queue.offer(outputEvents, event).pipe(Effect.asVoid)
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

      const openPermissionDecision = (
        permissionRequestId: string,
      ): Effect.Effect<Deferred.Deferred<PermissionDecision>> =>
        Effect.gen(function*() {
          const deferred = yield* Deferred.make<PermissionDecision>()
          yield* Ref.update(pendingPermissions, pending =>
            new Map(pending).set(permissionRequestId, deferred),
          )
          return deferred
        })

      const awaitPermissionDecision = (
        permissionRequestId: string,
        deferred: Deferred.Deferred<PermissionDecision>,
      ): Effect.Effect<PermissionDecision> =>
        Deferred.await(deferred).pipe(
          Effect.ensuring(Ref.update(pendingPermissions, pending => {
            const next = new Map(pending)
            next.delete(permissionRequestId)
            return next
          })),
        )

      const completePermissionDecision = (
        permissionRequestId: string,
        decision: PermissionDecision,
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          const pending = yield* Ref.get(pendingPermissions)
          const deferred = pending.get(permissionRequestId)
          if (deferred === undefined) return
          yield* Deferred.succeed(deferred, decision).pipe(Effect.asVoid)
        })

      const cancelPendingPermissions = Effect.gen(function*() {
        const pending = yield* Ref.get(pendingPermissions)
        yield* Effect.forEach(
          pending.values(),
          deferred => Deferred.succeed(deferred, { _tag: "Cancelled" as const }),
          { discard: true },
        )
        yield* Ref.set(pendingPermissions, new Map())
      })

      const client: acp.Client = {
        requestPermission: params =>
          runPromise(
            Effect.gen(function*() {
              const permissionRequestId = yield* makePermissionRequestId(idGenerator)
              const deferred = yield* openPermissionDecision(permissionRequestId)
              yield* emitEffect({
                _tag: "PermissionRequest",
                permissionRequestId,
                toolUseId: params.toolCall.toolCallId,
                options: mapPermissionOptions(params.options),
              })
              const decision = yield* awaitPermissionDecision(permissionRequestId, deferred)
              return permissionResponse(decision, params.options)
            }).pipe(
              Effect.withSpan("firegrid.agent_event_pipeline.acp.permission_request", {
                kind: "consumer",
                attributes: {
                  "firegrid.agent_output.tool_id": params.toolCall.toolCallId,
                },
              }),
            ),
          ),
        sessionUpdate: async params => {
          await runPromise(
            mapSessionUpdate(params, textDeltaId).pipe(
              Effect.tap(events =>
                Effect.annotateCurrentSpan({
                  "firegrid.agent_output.tag": events.map(event => event._tag).join(","),
                  "firegrid.acp.session_update": params.update.sessionUpdate,
                })),
              Effect.flatMap(events => Effect.forEach(events, emitEffect, { discard: true })),
              Effect.withSpan("firegrid.agent_event_pipeline.acp.session_update", {
                kind: "consumer",
                attributes: {
                  "firegrid.acp.session_update": params.update.sessionUpdate,
                },
              }),
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
        })).pipe(
          Effect.withSpan("firegrid.agent_event_pipeline.acp.initialize", {
            kind: "client",
          }),
        )

      const session = yield* acpPromise("newSession", "failed to create ACP session", () =>
        connection.newSession({
          cwd: options.cwd ?? globalThis.process.cwd(),
          // firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.7
          // firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.9
          // ACP does not consume FiregridAgentToolkit directly.
          // Tool execution is owned by the ACP agent process or delegated
          // through ACP session.mcpServers/MCP.
          mcpServers: (options.mcpServers ?? []).map(lowerMcpServerDeclaration),
          // tf-b6n / A1: additive ACP `_meta` so claude-agent-acp loads the
          // runtime-context MCP tools directly instead of deferring them
          // behind ToolSearch. Reserved-namespace metadata; non-claude ACP
          // agents ignore it (no behavior change). Omitted when there are
          // no MCP servers.
          ...(() => {
            const meta = claudeAgentAcpAlwaysLoadMeta(options.mcpServers ?? [])
            return meta === undefined ? {} : { _meta: meta }
          })(),
        })).pipe(
          Effect.tap(session =>
            Effect.annotateCurrentSpan({
              "firegrid.acp.session_id": session.sessionId,
              "firegrid.acp.mcp_server_count": options.mcpServers?.length ?? 0,
              "firegrid.acp.mcp_server_names": (options.mcpServers ?? []).map(server => server.name).join(","),
            })),
          Effect.withSpan("firegrid.agent_event_pipeline.acp.new_session", {
            kind: "client",
            attributes: {
              "firegrid.acp.mcp_server_count": options.mcpServers?.length ?? 0,
            },
          }),
        )
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
              Effect.withSpan("firegrid.agent_event_pipeline.acp.prompt", {
                kind: "client",
                attributes: {
                  "firegrid.acp.session_id": sessionId,
                  "firegrid.input.correlation_id": event.correlationId,
                },
              }),
              Effect.matchEffect({
                onFailure: error =>
                  Ref.set(currentTextDeltaId, undefined).pipe(
                    // tf-ds2: `error.message` is now the enriched
                    // "ACP prompt failed: <underlying JSON-RPC message>"
                    // (codecError), so the surfaced Error event / trace
                    // `agentError` carries the real reason, not the static
                    // op string. `error.cause` preserved unchanged.
                    Effect.zipRight(emitEffect(recoverableError(error.message, error.cause))),
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
        }).pipe(
          Effect.withSpan("firegrid.agent_event_pipeline.acp.permission_response", {
            kind: "producer",
            attributes: {
              "firegrid.agent_input.tag": event._tag,
            },
          }),
        )

      const sendCancel = (): Effect.Effect<void, AgentCodecError> =>
        Effect.gen(function*() {
          yield* cancelPendingPermissions
          yield* acpPromise("cancel", "failed to cancel ACP session", () =>
            connection.cancel({ sessionId }))
        }).pipe(
          Effect.withSpan("firegrid.agent_event_pipeline.acp.cancel", {
            kind: "producer",
          }),
        )

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
        ).pipe(
          Effect.withSpan("firegrid.agent_event_pipeline.acp.terminate", {
            kind: "producer",
          }),
        )

      const sendToolResult = (): Effect.Effect<void, AgentCodecError> =>
        Effect.fail(
          codecError(
            "send",
            "ACP ToolResult input is out-of-band for this codec slice",
          ),
        ).pipe(
          Effect.withSpan("firegrid.agent_event_pipeline.acp.tool_result", {
            kind: "producer",
          }),
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
            Stream.withSpan("firegrid.agent_event_pipeline.acp.output_queue"),
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
