// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
//
// Public Firegrid client. This package is browser/app safe: it writes
// launch/start/permission control requests through protocol channel Tags and
// reads durable control/output projections, but it does not own live runtime
// input delivery. Prompt dispatches through egress channels whose append
// receipts preserve the stored RuntimeInputIntentRow client contract.

import {
  ContextNotFound,
  PublicLaunchRequestSchema,
  PublicLaunchRuntimeIntentSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  local,
  runtimeControlPlaneStreamUrl,
  runtimeContextsView,
  runtimeEventsForContextView,
  runtimeOutputStreamUrl,
  type PublicLaunchRequest,
  type PublicLaunchRuntimeIntent,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import {
  type PermissionRespondInput,
  type SessionCancelToolInput,
  type SessionCancelToolOutput,
  type SessionCloseToolInput,
  type SessionCloseToolOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
} from "@firegrid/protocol/session-facade"
import {
  PublicPromptRequestSchema,
  type PublicPromptRequest,
} from "@firegrid/protocol/runtime-ingress"
import type { EventOffset } from "@firegrid/protocol/channels"
import {
  SessionAgentOutputChannelTarget,
  type BidirectionalChannel,
  type CallableChannel,
  type ChannelRegistration,
  type EgressChannel,
  type IngressChannel,
} from "@firegrid/protocol/channels"
import {
  channelRouteMetadata,
  type ChannelRouteMetadata,
} from "@firegrid/protocol/channels/router"
import {
  runtimeAgentOutputObservationFromRow,
  runtimePermissionRequestObservationFromAgentOutput,
  sessionContextIdForExternalKey,
  type FiregridSessionId,
  type RuntimeAgentOutputObservation,
  type SessionAgentOutputWaitInput,
  type SessionAgentOutputWaitOutput,
  type SessionAttachDecodedInput,
  type SessionAttachInput,
  type SessionCreateOrLoadInput,
  type SessionHandlePromptInput,
  type SessionPermissionRequestWaitInput,
  type SessionPermissionRequestWaitOutput,
  type SessionPermissionRespondInput,
} from "@firegrid/protocol/session-facade"
import type { DurableTableHeaders } from "@firegrid/protocol"
import {
  FiregridAgentToolOperations,
  type WaitAnyToolInput,
  type WaitAnyToolOutput,
  type WaitForToolInput,
  type WaitForToolOutput,
  type WaitUntilToolInput,
  type WaitUntilToolOutput,
} from "@firegrid/protocol/agent-tools"
import { getFiregridProjectionMetadata } from "@firegrid/protocol/projection"
import {
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostPromptChannel,
  HostSessionsCreateOrLoadChannel,
  HostSessionsStartChannel,
  SessionCancelChannel,
  SessionCloseChannel,
  SessionPromptChannel,
} from "@firegrid/protocol/channels"
import { Clock, Context, Data, Duration, Effect, Layer, Option, Ref, Schema, type Scope, Stream } from "effect"
import { projectionWait } from "./internal/projection-wait.ts"
import { FiregridClientOperations } from "./operations.ts"
import {
  autoApproveSessionPermissions,
  type PermissionAutoApproveOptions,
  type PermissionAutoApprovePolicy,
} from "./permission-auto-approve.ts"

export type {
  AgentOutputEvent,
  RuntimeAgentOutputObservation,
  RuntimePermissionRequestObservation,
  SessionAgentOutputWaitInput,
  SessionAgentOutputWaitOutput,
} from "@firegrid/protocol/session-facade"
export type { EventOffset } from "@firegrid/protocol/channels"
export { FiregridClientOperations } from "./operations.ts"

export interface ClientOptions {
  readonly durableStreamsBaseUrl?: string
  readonly namespace?: string
  readonly runtimeStreamUrl?: string
  readonly controlPlaneStreamUrl?: string
  readonly outputStreamUrl?: string
  readonly contentType?: string
  readonly headers?: DurableTableHeaders
  readonly txTimeoutMs?: number
  readonly channels?: ReadonlyArray<ChannelRegistration>
  /**
   * Upper bound (ms) for the reflected-context wait that dependent writes
   * (`firegrid.prompt`, `firegrid.sessions.prompt`, `session.prompt`,
   * `session.start`) perform before writing. A real in-flight context
   * materializes well within this window; an unknown/typo context id never
   * materializes, so the wait is bounded — on timeout the barrier does one
   * authoritative control-plane read and fails with `ContextNotFound`
   * (wrapped in `AppendError`) if the context is absent, instead of hanging
   * forever. Defaults to 30s. tf-1r3h.
   */
  readonly contextReflectionTimeoutMs?: number
}

export class FiregridConfig extends Context.Tag("@firegrid/client/FiregridConfig")<
  FiregridConfig,
  ClientOptions
>() {}

export class PreloadError extends Data.TaggedError("PreloadError")<{
  readonly cause: unknown
}> {}

export class AppendError extends Data.TaggedError("AppendError")<{
  readonly contextId: string
  readonly cause: unknown
}> {}

export class LaunchInputError extends Data.TaggedError("LaunchInputError")<{
  readonly cause: unknown
}> {}

export class FiregridConfigError extends Schema.TaggedError<FiregridConfigError>()(
  "FiregridConfigError",
  {
    cause: Schema.Unknown,
  },
) {}

export class FiregridChannelError extends Schema.TaggedError<FiregridChannelError>()(
  "FiregridChannelError",
  {
    target: Schema.String,
    verb: Schema.Literal("send", "wait_for", "call"),
    cause: Schema.Unknown,
  },
) {}

export type PromptInputError = LaunchInputError

export type FiregridError =
  | PreloadError
  | LaunchInputError
  | AppendError
  | FiregridChannelError
  | FiregridConfigError

const isLaunchInputError = (cause: unknown): cause is LaunchInputError =>
  cause instanceof LaunchInputError

const isAppendError = (cause: unknown): cause is AppendError =>
  cause instanceof AppendError

export type FiregridChannelMatch = Record<string, unknown>

export type FiregridChannelWaitOutput =
  | { readonly matched: true; readonly event: unknown }
  | { readonly matched: false; readonly timedOut: true }

export type FiregridChannelWaitAnyInput = {
  readonly target: string
  readonly match?: FiregridChannelMatch
}

export type FiregridChannelWaitAnyOutput =
  | {
    readonly matched: true
    readonly winnerIndex: number
    readonly target: string
    readonly event: unknown
  }
  | { readonly matched: false; readonly timedOut: true }

export interface FiregridChannelsClient {
  readonly metadata: ReadonlyArray<ChannelRouteMetadata>
  readonly send: (
    target: string,
    payload: unknown,
  ) => Effect.Effect<unknown, FiregridChannelError>
  readonly waitFor: (
    target: string,
    options?: {
      readonly match?: FiregridChannelMatch
      readonly timeoutMs?: number
    },
  ) => Effect.Effect<FiregridChannelWaitOutput, FiregridChannelError>
  readonly waitForAny: (
    inputs: ReadonlyArray<FiregridChannelWaitAnyInput>,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<FiregridChannelWaitAnyOutput, FiregridChannelError>
  readonly call: (
    target: string,
    request: unknown,
  ) => Effect.Effect<unknown, FiregridChannelError>
}

export interface FiregridWaitClient {
  readonly for: (
    request: WaitForToolInput,
  ) => Effect.Effect<WaitForToolOutput, LaunchInputError | FiregridChannelError>
  readonly until: (
    request: WaitUntilToolInput,
  ) => Effect.Effect<WaitUntilToolOutput, LaunchInputError>
  readonly any: (
    request: WaitAnyToolInput,
  ) => Effect.Effect<WaitAnyToolOutput, LaunchInputError | FiregridChannelError>
}

export interface RuntimeContextSnapshot {
  readonly contextId: string
  readonly context?: RuntimeContext
  readonly status?: RuntimeRunEventRow["status"]
  readonly runs: ReadonlyArray<RuntimeRunEventRow>
  readonly events: ReadonlyArray<RuntimeEventRow>
  readonly logs: ReadonlyArray<RuntimeLogLineRow>
  readonly agentOutputs: ReadonlyArray<RuntimeAgentOutputObservation>
}

export interface RuntimeContextHandle {
  readonly contextId: string
  readonly snapshot: Effect.Effect<RuntimeContextSnapshot, PreloadError>
}

export interface FiregridSessionWaitClient {
  readonly forAgentOutput: (
    request?: SessionAgentOutputWaitInput,
  ) => Effect.Effect<
    SessionAgentOutputWaitOutput,
    LaunchInputError | PreloadError
  >
  readonly forPermissionRequest: (
    request?: SessionPermissionRequestWaitInput,
  ) => Effect.Effect<
    SessionPermissionRequestWaitOutput,
    LaunchInputError | PreloadError
  >
}

export interface FiregridSessionPermissionsClient {
  readonly respond: (
    request: SessionPermissionRespondInput,
  ) => Effect.Effect<
    EventOffset,
    LaunchInputError | AppendError
  >
  readonly autoApprove: <E = never, R = never>(
    policy: PermissionAutoApprovePolicy<E, R>,
    options?: PermissionAutoApproveOptions,
  ) => Effect.Effect<void, never, Scope.Scope | R>
}

export interface FiregridSessionHandle {
  readonly sessionId: FiregridSessionId
  readonly contextId: string
  // tf-2osu: no public `whenReady`. "Context materialized" is a substrate
  // detail; the operations that need it (prompt/start, the wait/observe reads,
  // snapshot) own a bounded materialization barrier internally.
  readonly prompt: (
    request: SessionHandlePromptInput,
  ) => Effect.Effect<EventOffset, PromptInputError | AppendError>
  readonly start: () => Effect.Effect<
    EventOffset,
    AppendError
  >
  readonly cancel: (
    request?: Omit<SessionCancelToolInput, "sessionId">,
  ) => Effect.Effect<SessionCancelToolOutput, LaunchInputError | AppendError>
  readonly close: (
    request?: Omit<SessionCloseToolInput, "sessionId">,
  ) => Effect.Effect<SessionCloseToolOutput, LaunchInputError | AppendError>
  readonly snapshot: () => Effect.Effect<RuntimeContextSnapshot, PreloadError>
  readonly wait: FiregridSessionWaitClient
  readonly permissions: FiregridSessionPermissionsClient
}

export interface FiregridSessionsClient {
  readonly attach: (
    request: SessionAttachInput,
  ) => Effect.Effect<
    FiregridSessionHandle,
    LaunchInputError
  >
  readonly createOrLoad: (
    request: SessionCreateOrLoadInput,
  ) => Effect.Effect<
    FiregridSessionHandle,
    LaunchInputError | AppendError
  >
  readonly prompt: (
    request: SessionPromptToolInput,
  ) => Effect.Effect<
    SessionPromptToolOutput,
    PromptInputError | AppendError
  >
  readonly cancel: (
    request: SessionCancelToolInput,
  ) => Effect.Effect<
    SessionCancelToolOutput,
    LaunchInputError | AppendError
  >
  readonly close: (
    request: SessionCloseToolInput,
  ) => Effect.Effect<
    SessionCloseToolOutput,
    LaunchInputError | AppendError
  >
}


export interface FiregridPermissionsClient {
  readonly respond: (
    request: PermissionRespondInput,
  ) => Effect.Effect<
    EventOffset,
    LaunchInputError | AppendError
  >
}

export interface FiregridService {
  readonly launch: (
    request: PublicLaunchRequest,
  ) => Effect.Effect<
    RuntimeContextHandle,
    LaunchInputError | AppendError
  >
  readonly prompt: (
    request: PublicPromptRequest,
  ) => Effect.Effect<EventOffset, PromptInputError | AppendError>
  readonly sessions: FiregridSessionsClient
  readonly permissions: FiregridPermissionsClient
  readonly channels: FiregridChannelsClient
  readonly wait: FiregridWaitClient
  readonly open: (contextId: string) => RuntimeContextHandle
  readonly watchContexts: (
    predicate?: (context: RuntimeContext) => boolean,
  ) => Stream.Stream<RuntimeContext, PreloadError>
}

export class Firegrid extends Context.Tag("@firegrid/client/Firegrid")<
  Firegrid,
  FiregridService
>() {}

export { local, runtimeControlPlaneStreamUrl }

export const FiregridRuntimeTables = {
  ControlPlane: RuntimeControlPlaneTable,
  Output: RuntimeOutputTable,
} as const

export const firegridRuntimeTableTags = [
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
] as const

const latestStatus = (
  events: ReadonlyArray<RuntimeRunEventRow>,
): RuntimeRunEventRow["status"] | undefined => {
  const rank = (status: RuntimeRunEventRow["status"]): number =>
    status === "started" ? 0 : status === "failed" ? 1 : 2
  return [...events].sort((left, right) =>
    left.at.localeCompare(right.at) ||
    rank(left.status) - rank(right.status),
  ).at(-1)?.status
}

const makeContextId = (): string => `ctx_${crypto.randomUUID()}`

const withClientSpan = <A, E, R>(
  name: string,
  attributes: Record<string, unknown>,
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  self.pipe(
    Effect.withSpan(name, {
      kind: "client",
      attributes,
    }),
    Effect.annotateSpans("firegrid.side", "sdk"),
  )

interface FiregridClientOperationGroup<Input> {
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema.Any
}

const projectChannelMethod = <
  Input,
  Output,
  DispatchError,
>(
  operation: FiregridClientOperationGroup<Input>,
  dispatch: (
    input: Input,
  ) => Effect.Effect<Output, unknown>,
  mapDispatchError: (
    input: Input,
    cause: unknown,
  ) => DispatchError,
) => {
  const metadata = Option.getOrThrow(getFiregridProjectionMetadata(operation.input))
  const spanAttributes = {
    "firegrid.operation.id": metadata.operationId,
    ...(metadata.clientName === undefined
      ? {}
      : { "firegrid.client.operation": metadata.clientName }),
  }
  return (
    request: unknown,
  ): Effect.Effect<Output, LaunchInputError | DispatchError> =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(operation.input, {
        onExcessProperty: "error",
      })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))
      yield* Effect.annotateCurrentSpan(spanAttributes)
      return yield* dispatch(input).pipe(
        Effect.mapError(cause => mapDispatchError(input, cause)),
      )
    })
}

interface ResolvedConfig {
  readonly baseUrl: string
  readonly namespace: string | undefined
  readonly controlPlaneStreamUrl: string
  readonly outputStreamUrl: string
  readonly contentType: string
  readonly headers: DurableTableHeaders | undefined
  readonly txTimeoutMs: number
  readonly contextReflectionTimeoutMs: number
}

const resolveConfig = (
  cfg: ClientOptions,
): Effect.Effect<ResolvedConfig, FiregridConfigError> =>
  Effect.gen(function* () {
    const controlPlaneStreamUrl =
      cfg.controlPlaneStreamUrl ??
      cfg.runtimeStreamUrl ??
      (cfg.durableStreamsBaseUrl !== undefined && cfg.namespace !== undefined
        ? runtimeControlPlaneStreamUrl({
          baseUrl: cfg.durableStreamsBaseUrl,
          namespace: cfg.namespace,
        })
        : undefined)
    const outputStreamUrl =
      cfg.outputStreamUrl ??
      (cfg.durableStreamsBaseUrl !== undefined && cfg.namespace !== undefined
        ? runtimeOutputStreamUrl({
          baseUrl: cfg.durableStreamsBaseUrl,
          namespace: cfg.namespace,
        })
        : undefined)

    if (controlPlaneStreamUrl === undefined || outputStreamUrl === undefined) {
      return yield* new FiregridConfigError({
        cause: new Error(
          "FiregridConfig requires durableStreamsBaseUrl + namespace or explicit control-plane and output stream URLs",
        ),
      })
    }

    return {
      baseUrl: cfg.durableStreamsBaseUrl ?? "",
      namespace: cfg.namespace,
      controlPlaneStreamUrl,
      outputStreamUrl,
      contentType: cfg.contentType ?? "application/json",
      headers: cfg.headers,
      txTimeoutMs: cfg.txTimeoutMs ?? 2_000,
      contextReflectionTimeoutMs: cfg.contextReflectionTimeoutMs ?? 30_000,
    }
  })

const decodePublicLaunchRequest = (
  request: PublicLaunchRequest,
): Effect.Effect<PublicLaunchRequest, LaunchInputError> =>
  Schema.decodeUnknown(PublicLaunchRequestSchema, { onExcessProperty: "error" })(request).pipe(
    Effect.mapError(cause => new LaunchInputError({ cause })),
  )

const decodePublicLaunchRuntimeIntent = (
  request: PublicLaunchRuntimeIntent,
): Effect.Effect<PublicLaunchRuntimeIntent, LaunchInputError> =>
  Schema.decodeUnknown(PublicLaunchRuntimeIntentSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodePublicPromptRequest = (
  request: PublicPromptRequest,
): Effect.Effect<PublicPromptRequest, PromptInputError> =>
  Schema.decodeUnknown(PublicPromptRequestSchema, { onExcessProperty: "error" })(request).pipe(
    Effect.mapError(cause => new LaunchInputError({ cause })),
  )

const decodeSessionPromptInput = (
  request: SessionPromptToolInput,
): Effect.Effect<SessionPromptToolInput, PromptInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.sessions.prompt.input, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionAttachInput = (
  request: SessionAttachInput,
): Effect.Effect<SessionAttachDecodedInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.sessions.attach.input, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionHandlePromptInput = (
  request: SessionHandlePromptInput,
): Effect.Effect<SessionHandlePromptInput, PromptInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.sessions.promptScoped.input, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionPermissionRequestWaitInput = (
  request: SessionPermissionRequestWaitInput | undefined,
): Effect.Effect<SessionPermissionRequestWaitInput, LaunchInputError> =>
  request === undefined
    ? Effect.succeed({})
    : Schema.decodeUnknown(FiregridClientOperations.wait.forPermissionRequest.input, {
      onExcessProperty: "error",
    })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionAgentOutputWaitInput = (
  request: SessionAgentOutputWaitInput | undefined,
): Effect.Effect<SessionAgentOutputWaitInput, LaunchInputError> =>
  request === undefined
    ? Effect.succeed({})
    : Schema.decodeUnknown(FiregridClientOperations.wait.forAgentOutput.input, {
      onExcessProperty: "error",
    })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeWaitForInput = (
  request: WaitForToolInput,
): Effect.Effect<WaitForToolInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridAgentToolOperations.waitFor.input, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeWaitUntilInput = (
  request: WaitUntilToolInput,
): Effect.Effect<WaitUntilToolInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridAgentToolOperations.waitUntil.input, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeWaitAnyInput = (
  request: WaitAnyToolInput,
): Effect.Effect<WaitAnyToolInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridAgentToolOperations.waitAny.input, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const relativeWaitTimePattern = /^\+(\d+)(ms|s|m|h|d|w)$/
const relativeWaitUnitMs: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const waitDelayMs = (
  time: string,
): Effect.Effect<number, LaunchInputError> =>
  Effect.gen(function*() {
    const relative = relativeWaitTimePattern.exec(time)
    if (relative !== null) {
      const amount = Number(relative[1])
      const unit = relativeWaitUnitMs[relative[2] ?? ""]
      if (Number.isSafeInteger(amount) && unit !== undefined) return amount * unit
    }
    const absolute = Date.parse(time)
    if (Number.isNaN(absolute)) {
      return yield* new LaunchInputError({
        cause: new Error(
          `invalid wait.until time "${time}"; expected ISO timestamp or relative +Nms|s|m|h|d|w`,
        ),
      })
    }
    const now = yield* Clock.currentTimeMillis
    return Math.max(0, absolute - now)
  })

const channelError = (
  target: string,
  verb: FiregridChannelError["verb"],
  cause: unknown,
) => new FiregridChannelError({ target, verb, cause })

const channelByTarget = (
  channels: ReadonlyArray<ChannelRegistration>,
  target: string,
): Effect.Effect<ChannelRegistration, FiregridChannelError> =>
  Effect.fromNullable(
    channels.find(channel => String(channel.target) === target),
  ).pipe(
    Effect.mapError(() =>
      channelError(target, "wait_for", new Error(`unknown channel: ${target}`))),
  )

const decodeChannelPayload = (
  target: string,
  verb: FiregridChannelError["verb"],
  schema: Schema.Schema.Any,
  payload: unknown,
): Effect.Effect<unknown, FiregridChannelError> =>
  (Schema.decodeUnknown(schema, { onExcessProperty: "error" })(payload) as Effect.Effect<
    unknown,
    unknown,
    never
  >).pipe(
    Effect.mapError(cause => channelError(target, verb, cause)),
  )

const readPath = (
  row: unknown,
  path: ReadonlyArray<string>,
): unknown =>
  path.reduce<unknown>((cursor, segment) =>
    typeof cursor === "object" && cursor !== null
      ? (cursor as Record<string, unknown>)[segment]
      : undefined,
    row,
  )

const matchesChannelRow = (
  row: unknown,
  match: FiregridChannelMatch | undefined,
): boolean => {
  if (match === undefined) return true
  return Object.entries(match).every(([key, value]) =>
    readPath(row, key.split(".").filter(segment => segment.length > 0)) ===
      value)
}

const channelWait = (
  target: string,
  stream: Stream.Stream<unknown, unknown, never>,
  options: {
    readonly match?: FiregridChannelMatch
    readonly timeoutMs?: number
  } = {},
): Effect.Effect<FiregridChannelWaitOutput, FiregridChannelError> => {
  const wait = stream.pipe(
    Stream.filter(row => matchesChannelRow(row, options.match)),
    Stream.runHead,
    Effect.map(Option.match({
      onNone: (): FiregridChannelWaitOutput => ({
        matched: false,
        timedOut: true,
      }),
      onSome: event => ({ matched: true, event }) as const,
    })),
    Effect.mapError(cause => channelError(target, "wait_for", cause)),
  )
  if (options.timeoutMs === undefined) return wait
  return Effect.raceFirst(
    wait,
    Clock.sleep(Duration.millis(options.timeoutMs)).pipe(
      Effect.as<FiregridChannelWaitOutput>({
        matched: false,
        timedOut: true,
      }),
    ),
  )
}

const makeChannelsClient = (
  channels: ReadonlyArray<ChannelRegistration>,
): FiregridChannelsClient => {
  const requireChannel = (
    target: string,
    verb: FiregridChannelError["verb"],
  ): Effect.Effect<ChannelRegistration, FiregridChannelError> =>
    channelByTarget(channels, target).pipe(
      Effect.mapError(error => channelError(target, verb, error.cause)),
    )

  const send = (
    target: string,
    payload: unknown,
  ): Effect.Effect<unknown, FiregridChannelError> =>
    Effect.gen(function*() {
      const channel = yield* requireChannel(target, "send")
      if (channel.direction !== "egress" && channel.direction !== "bidirectional") {
        return yield* channelError(
          target,
          "send",
          new Error(`channel is ${channel.direction}`),
        )
      }
      const decoded = yield* decodeChannelPayload(
        target,
        "send",
        channel.schema,
        payload,
      )
      const appendable = channel as EgressChannel | BidirectionalChannel
      return yield* appendable.binding.append(decoded).pipe(
        Effect.mapError(cause => channelError(target, "send", cause)),
      )
    })

  const waitFor = (
    target: string,
    options: {
      readonly match?: FiregridChannelMatch
      readonly timeoutMs?: number
    } = {},
  ): Effect.Effect<FiregridChannelWaitOutput, FiregridChannelError> =>
    Effect.gen(function*() {
      const channel = yield* requireChannel(target, "wait_for")
      if (channel.direction !== "ingress" && channel.direction !== "bidirectional") {
        return yield* channelError(
          target,
          "wait_for",
          new Error(`channel is ${channel.direction}`),
        )
      }
      const waitable = channel as IngressChannel | BidirectionalChannel
      return yield* channelWait(target, waitable.binding.stream, options)
    })

  const waitForAny = (
    inputs: ReadonlyArray<FiregridChannelWaitAnyInput>,
    options: { readonly timeoutMs?: number } = {},
  ): Effect.Effect<FiregridChannelWaitAnyOutput, FiregridChannelError> => {
    if (inputs.length === 0) {
      return Effect.fail(
        channelError(
          "wait_any",
          "wait_for",
          new Error("at least one channel is required"),
        ),
      )
    }
    const waits = inputs.map((input, winnerIndex) =>
      waitFor(
        input.target,
        input.match === undefined ? {} : { match: input.match },
      ).pipe(
        Effect.flatMap(result =>
          result.matched
            ? Effect.succeed<FiregridChannelWaitAnyOutput>({
              matched: true,
              winnerIndex,
              target: input.target,
              event: result.event,
            })
            : Effect.never,
        ),
      ),
    )
    const wait = Effect.raceAll(waits)
    if (options.timeoutMs === undefined) return wait
    return Effect.raceFirst(
      wait,
      Clock.sleep(Duration.millis(options.timeoutMs)).pipe(
        Effect.as<FiregridChannelWaitAnyOutput>({
          matched: false,
          timedOut: true,
        }),
      ),
    )
  }

  const call = (
    target: string,
    request: unknown,
  ): Effect.Effect<unknown, FiregridChannelError> =>
    Effect.gen(function*() {
      const channel = yield* requireChannel(target, "call")
      if (channel.direction !== "call") {
        return yield* channelError(
          target,
          "call",
          new Error(`channel is ${channel.direction}`),
        )
      }
      const callable = channel as CallableChannel
      const decoded = yield* decodeChannelPayload(
        target,
        "call",
        callable.requestSchema,
        request,
      )
      const response: unknown = yield* (callable.binding.call(decoded) as Effect.Effect<
        unknown,
        unknown,
        never
      >).pipe(
        Effect.mapError(cause => channelError(target, "call", cause)),
      )
      return response
    })

  return {
    metadata: channels.map(channelRouteMetadata),
    send,
    waitFor,
    waitForAny,
    call,
  }
}

const makeWaitClient = (
  channels: FiregridChannelsClient,
): FiregridWaitClient => {
  const waitFor = (
    request: WaitForToolInput,
  ): Effect.Effect<WaitForToolOutput, LaunchInputError | FiregridChannelError> =>
    Effect.gen(function*() {
      const decoded = yield* decodeWaitForInput(request)
      const match = decoded.match ?? decoded.event.match
      const timeoutMs = decoded.timeoutMs ?? decoded.event.timeoutMs
      const result = yield* channels.waitFor(decoded.event.channel, {
        ...(match === undefined ? {} : { match }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      return result
    })

  const waitUntil = (
    request: WaitUntilToolInput,
  ): Effect.Effect<WaitUntilToolOutput, LaunchInputError> =>
    Effect.gen(function*() {
      const decoded = yield* decodeWaitUntilInput(request)
      const delay = yield* waitDelayMs(decoded.time)
      yield* Clock.sleep(Duration.millis(delay))
      return { waited: true, firedAt: new Date().toISOString() } as const
    })

  const waitAny = (
    request: WaitAnyToolInput,
  ): Effect.Effect<WaitAnyToolOutput, LaunchInputError | FiregridChannelError> =>
    Effect.gen(function*() {
      const decoded = yield* decodeWaitAnyInput(request)
      const result = yield* channels.waitForAny(
        decoded.events.map(event => ({
          target: event.channel,
          ...(event.match === undefined ? {} : { match: event.match }),
        })),
        decoded.timeoutMs === undefined ? {} : { timeoutMs: decoded.timeoutMs },
      )
      return result.matched
        ? {
          winnerIndex: result.winnerIndex,
          channel: result.target,
          result: result.event,
        }
        : { timedOut: true }
    })

  return {
    for: waitFor,
    until: waitUntil,
    any: waitAny,
  }
}

const snapshotFromJournal = (
  contextId: string,
  inputs: {
    readonly context?: RuntimeContext
    readonly runs: ReadonlyArray<RuntimeRunEventRow>
    readonly events: ReadonlyArray<RuntimeEventRow>
    readonly logs: ReadonlyArray<RuntimeLogLineRow>
  },
): RuntimeContextSnapshot => {
  const events = inputs.events
    .filter(row => row.contextId === contextId)
  const agentOutputs = events.flatMap(row => {
    const observation = runtimeAgentOutputObservationFromRow(row)
    return Option.isSome(observation) ? [observation.value] : []
  })
  const logs = inputs.logs
    .filter(row => row.contextId === contextId)
  const runs = [...inputs.runs].sort((left, right) =>
    left.at.localeCompare(right.at))
  const status = latestStatus(runs)
  return {
    contextId,
    ...(inputs.context === undefined ? {} : { context: inputs.context }),
    ...(status === undefined ? {} : { status }),
    runs,
    events,
    logs,
    agentOutputs,
  }
}

const make = (
  config: ResolvedConfig,
  channels: ReadonlyArray<ChannelRegistration>,
) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable
    const output = yield* RuntimeOutputTable
    // tf-35f4 Sim 2: createOrLoad now dispatches via the protocol-owned
    // HostSessionsCreateOrLoadChannel Tag. Capturing the resolved channel
    // here keeps the requirement at make-time (Layer composition), so the
    // public FiregridSessionsClient.createOrLoad signature stays unchanged
    // for callers.
    const hostSessionsCreateOrLoadChannel =
      yield* HostSessionsCreateOrLoadChannel
    // tf-aago: launch / start / permissions.respond dispatch through their
    // protocol-owned callable channel Tags. Captured at make-time so the
    // public method signatures stay unchanged; the standalone-default
    // bindings (HostControlChannelsStandaloneLive) or a host-sdk Live Layer
    // provide them.
    const hostContextsCreateChannel = yield* HostContextsCreateChannel
    const hostPromptChannel = yield* HostPromptChannel
    const sessionPromptChannel = yield* SessionPromptChannel
    const hostSessionsStartChannel = yield* HostSessionsStartChannel
    const sessionCancelChannel = yield* SessionCancelChannel
    const sessionCloseChannel = yield* SessionCloseChannel
    const hostPermissionRespondChannel = yield* HostPermissionRespondChannel
    const contextRows = runtimeContextsView(control)

    /**
     * Resolve a context row from the namespace-scoped control plane.
     * Read paths use this once and then dispatch to host-owned
     * ingress / output streams; cross-host reads work uniformly
     * because the host binding is on the row.
     */
    const resolveContext = (
      contextId: string,
    ): Effect.Effect<RuntimeContext | undefined, PreloadError> =>
      control.contexts.get(contextId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(cause => new PreloadError({ cause })),
      )

    const readSnapshot = (
      contextId: string,
    ): Effect.Effect<RuntimeContextSnapshot, PreloadError> =>
      Effect.gen(function* () {
        // tf-2osu: snapshot owns its readiness — bounded wait for the context
        // to materialize (callers no longer gate this with whenReady). A
        // provably-absent id errors bounded rather than hanging.
        yield* awaitContextMaterializedForRead(contextId)
        const context = yield* resolveContext(contextId)
        const runs = yield* control.runs.query((coll) =>
          coll.toArray.filter(row => row.contextId === contextId)).pipe(
            Effect.mapError(cause => new PreloadError({ cause })),
          )

        if (context === undefined) {
          return snapshotFromJournal(contextId, {
            runs,
            events: [],
            logs: [],
          })
        }

        const events = yield* output.events.query((coll) =>
          coll.toArray.filter(row => row.contextId === contextId)).pipe(
            Effect.mapError(cause => new PreloadError({ cause })),
          )
        const logs = yield* output.logs.query((coll) =>
          coll.toArray.filter(row => row.contextId === contextId)).pipe(
            Effect.mapError(cause => new PreloadError({ cause })),
          )

        return snapshotFromJournal(contextId, {
          context,
          runs,
          events,
          logs,
        })
      })

    const open = (contextId: string): RuntimeContextHandle => ({
      contextId,
      snapshot: readSnapshot(contextId),
    })

    const watchContexts = (
      predicate: (context: RuntimeContext) => boolean = () => true,
    ): Stream.Stream<RuntimeContext, PreloadError> =>
      contextRows.pipe(
        Stream.filter(predicate),
        Stream.mapError(cause => new PreloadError({ cause })),
      )

    const waitForAgentOutputObservation = (
      contextId: string,
      input: SessionAgentOutputWaitInput,
      predicate: (
        observation: RuntimeAgentOutputObservation,
      ) => boolean = () => true,
    ): Effect.Effect<
      Option.Option<RuntimeAgentOutputObservation>,
      LaunchInputError | PreloadError
    > =>
      Effect.gen(function* () {
        // tf-2osu: the wait/observe read owns its readiness — bounded wait for
        // the context to materialize before resolving the output stream. This
        // is why a forked permissions.autoApprove loop no longer needs an
        // explicit whenReady before it; a provably-absent id errors bounded.
        yield* awaitContextMaterializedForRead(contextId)
        if ((yield* resolveContext(contextId)) === undefined) {
          return yield* new PreloadError({
            cause: new Error(`runtime context ${contextId} not found`),
          })
        }
        const run = runtimeEventsForContextView(output, contextId).pipe(
          Stream.filterMap(runtimeAgentOutputObservationFromRow),
          Stream.filter(observation =>
            (input.afterSequence === undefined ||
              observation.sequence > input.afterSequence) &&
            predicate(observation),
          ),
          Stream.runHead,
          Effect.withSpan("firegrid.client.channel.wait_for", {
            kind: "client",
            attributes: {
              "firegrid.channel.target": String(SessionAgentOutputChannelTarget),
              "firegrid.channel.direction": "ingress",
              "firegrid.wait.bucket": "projection",
            },
          }),
          Effect.mapError(cause => new PreloadError({ cause })),
        )
        const awaited = input.timeoutMs === undefined
          ? run
          : Effect.raceFirst(
            run,
            Clock.sleep(Duration.millis(input.timeoutMs)).pipe(
              Effect.as(Option.none<RuntimeAgentOutputObservation>()),
            ),
          )
        return yield* awaited
      })

    const waitForAgentOutput = (
      contextId: string,
      request?: SessionAgentOutputWaitInput,
    ): Effect.Effect<
      SessionAgentOutputWaitOutput,
      LaunchInputError | PreloadError
    > =>
      Effect.gen(function* () {
        const input = yield* decodeSessionAgentOutputWaitInput(request)
        const matched = yield* waitForAgentOutputObservation(contextId, input)
        return Option.match(matched, {
          onNone: () => ({ matched: false, timedOut: true }) as const,
          onSome: output => ({ matched: true, output }) as const,
        })
      })

    const waitForPermissionRequest = (
      contextId: string,
      request?: SessionPermissionRequestWaitInput,
    ): Effect.Effect<
      SessionPermissionRequestWaitOutput,
      LaunchInputError | PreloadError
    > =>
      Effect.gen(function* () {
        const input = yield* decodeSessionPermissionRequestWaitInput(request)
        const matched = yield* waitForAgentOutputObservation(
          contextId,
          input,
          observation =>
            Option.isSome(runtimePermissionRequestObservationFromAgentOutput(observation)),
        )
        return Option.match(matched, {
          onNone: () => ({ matched: false, timedOut: true }) as const,
          onSome: output => {
            const permission = runtimePermissionRequestObservationFromAgentOutput(output)
            return Option.isSome(permission)
              ? ({ matched: true, request: permission.value } as const)
              : ({ matched: false, timedOut: true } as const)
          },
        })
      })

    const waitUntilContextReady = (
      contextId: string,
    ): Effect.Effect<void, PreloadError> =>
      projectionWait(
        contextRows,
        context => context.contextId === contextId,
      ).pipe(
        Effect.mapError(cause => new PreloadError({ cause })),
      )

    // tf-2osu: internal substrate plumbing — NOT exported, NOT a public
    // readiness primitive (that was `whenReady`, now deleted). The operations
    // that need a materialized context (prompt/start, the wait/observe reads,
    // snapshot) call this internally so callers never wait on "context
    // materialized" themselves.
    //
    // tf-1r3h (#587): BOUNDED. A real in-flight context materializes within the
    // window and the wait completes normally; an unknown/typo context id never
    // materializes, so an unbounded wait would hang forever. On timeout we do
    // one authoritative control-plane read: present (projection merely lagged
    // the table) -> proceed; absent -> fail with ContextNotFound so the calling
    // op surfaces a bounded error instead of hanging. (Subsumes tf-5sb7: with no
    // public whenReady, there is no unbounded absent-id readiness wait left.)
    const awaitContextMaterialized = (
      contextId: string,
    ): Effect.Effect<void, AppendError> =>
      Effect.gen(function* () {
        const ready = yield* Effect.timeoutOption(
          waitUntilContextReady(contextId),
          Duration.millis(config.contextReflectionTimeoutMs),
        ).pipe(Effect.mapError(cause => new AppendError({ contextId, cause })))
        if (Option.isSome(ready)) return
        const existing = yield* control.contexts.get(contextId).pipe(
          Effect.mapError(cause => new AppendError({ contextId, cause })),
        )
        if (Option.isNone(existing)) {
          return yield* new AppendError({
            contextId,
            cause: new ContextNotFound({ contextId }),
          })
        }
      })

    // PreloadError-typed view for read/observe paths (snapshot, waits) whose
    // error channel is PreloadError; preserves the ContextNotFound cause.
    const awaitContextMaterializedForRead = (
      contextId: string,
    ): Effect.Effect<void, PreloadError> =>
      awaitContextMaterialized(contextId).pipe(
        Effect.mapError(error => new PreloadError({ cause: error.cause })),
      )

    const appendHostPrompt = (
      request: PublicPromptRequest,
    ): Effect.Effect<EventOffset, AppendError> =>
      hostPromptChannel.binding.append(request).pipe(
        Effect.mapError(cause =>
          new AppendError({ contextId: request.contextId, cause })),
        Effect.withSpan("firegrid.client.channel.host_prompt.append", {
          kind: "producer",
          attributes: {
            "firegrid.channel.target": String(hostPromptChannel.target),
            "firegrid.channel.direction": hostPromptChannel.direction,
            "firegrid.context.id": request.contextId,
            "firegrid.input.kind": "message",
            "firegrid.input.idempotency_key": request.idempotencyKey ?? "",
          },
        }),
      )

    const appendSessionPrompt = (
      sessionId: string,
      request: SessionHandlePromptInput,
    ): Effect.Effect<EventOffset, AppendError> => {
      const channel = sessionPromptChannel.forSession(sessionId)
      return channel.binding.append(request).pipe(
        Effect.mapError(cause => new AppendError({ contextId: sessionId, cause })),
        Effect.withSpan("firegrid.client.channel.session_prompt.append", {
          kind: "producer",
          attributes: {
            "firegrid.channel.target": String(channel.target),
            "firegrid.channel.direction": channel.direction,
            "firegrid.context.id": sessionId,
            "firegrid.input.kind": "message",
            "firegrid.input.idempotency_key": request.idempotencyKey ?? "",
          },
        }),
      )
    }

    const cancelSession = projectChannelMethod(
      FiregridClientOperations.sessions.cancel,
      request =>
        Effect.gen(function*() {
          yield* awaitContextMaterialized(request.sessionId)
          return yield* sessionCancelChannel.binding.append(request).pipe(
            Effect.as({
              cancelled: true,
              sessionId: request.sessionId,
            } satisfies SessionCancelToolOutput),
            Effect.withSpan("firegrid.client.session.cancel.append", {
              kind: "producer",
              attributes: {
                "firegrid.channel.target": String(sessionCancelChannel.target),
                "firegrid.channel.direction": sessionCancelChannel.direction,
                "firegrid.context.id": request.sessionId,
                "firegrid.session.id": request.sessionId,
              },
            }),
          )
        }),
      (request, cause) =>
        isAppendError(cause)
          ? cause
          : new AppendError({ contextId: request.sessionId, cause }),
    )

    const closeSession = projectChannelMethod(
      FiregridClientOperations.sessions.close,
      request =>
        Effect.gen(function*() {
          yield* awaitContextMaterialized(request.sessionId)
          return yield* sessionCloseChannel.binding.append(request).pipe(
            Effect.as({
              closed: true,
              sessionId: request.sessionId,
            } satisfies SessionCloseToolOutput),
            Effect.withSpan("firegrid.client.session.close.append", {
              kind: "producer",
              attributes: {
                "firegrid.channel.target": String(sessionCloseChannel.target),
                "firegrid.channel.direction": sessionCloseChannel.direction,
                "firegrid.context.id": request.sessionId,
                "firegrid.session.id": request.sessionId,
              },
            }),
          )
        }),
      (request, cause) =>
        isAppendError(cause)
          ? cause
          : new AppendError({ contextId: request.sessionId, cause }),
    )

    // tf-fyyk: contexts.create / sessions.start / permissions.respond and
    // prompt write helpers now all dispatch through channel Tags. Prompt
    // remains EgressChannel direction, but the append binding returns the
    // producer-side durable receipt row so the public client contract keeps
    // returned === stored, createdAt, and _otel.

    const makeSessionHandle = (
      sessionId: FiregridSessionId,
    ): Effect.Effect<FiregridSessionHandle> =>
      Effect.gen(function* () {
        // Per-session-handle tracking of the last agent-output sequence
        // observed by wait.forAgentOutput. Defaultizes afterSequence so a
        // driver loop ("give me the next agent output") actually waits
        // instead of immediately re-matching the first observation. An
        // explicit request.afterSequence still overrides the tracked value
        // so callers can rewind/replay (structural readiness pattern, PR #435).
        const lastAgentOutputSequence = yield* Ref.make<number | undefined>(undefined)
        const forAgentOutput = (
          request?: SessionAgentOutputWaitInput,
        ): Effect.Effect<
          SessionAgentOutputWaitOutput,
          LaunchInputError | PreloadError
        > =>
          withClientSpan("firegrid.client.session.wait.for_agent_output", {
            "firegrid.session.id": sessionId,
            "firegrid.context.id": sessionId,
            "firegrid.wait.bucket": "projection",
          }, Effect.gen(function* () {
            const tracked = yield* Ref.get(lastAgentOutputSequence)
            const effective: SessionAgentOutputWaitInput | undefined =
              request?.afterSequence !== undefined || tracked === undefined
                ? request
                : { ...request, afterSequence: tracked }
            const result = yield* waitForAgentOutput(sessionId, effective)
            if (result.matched) {
              yield* Ref.set(lastAgentOutputSequence, result.output.sequence)
            }
            return result
          }))
        const waitClient: FiregridSessionWaitClient = {
          forAgentOutput,
          forPermissionRequest: request =>
            withClientSpan("firegrid.client.session.wait.for_permission_request", {
              "firegrid.session.id": sessionId,
              "firegrid.context.id": sessionId,
              "firegrid.wait.bucket": "projection",
            }, waitForPermissionRequest(sessionId, request)),
        }
        // tf-aago: session-scoped respond dispatches through the same
        // host-scoped HostPermissionRespondChannel, supplying the
        // handle's sessionId as contextId.
        const respondScoped = projectChannelMethod(
          FiregridClientOperations.permissions.respondScoped,
          decoded =>
            hostPermissionRespondChannel.binding.append({
              contextId: sessionId,
              permissionRequestId: decoded.permissionRequestId,
              decision: decoded.decision,
              ...(decoded.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: decoded.idempotencyKey }),
            }),
          (_decoded, cause) => new AppendError({ contextId: sessionId, cause }),
        )
        const respond = (
          request: SessionPermissionRespondInput,
        ): Effect.Effect<
          EventOffset,
          LaunchInputError | AppendError
        > => respondScoped(request)
        const permissionsClient: FiregridSessionPermissionsClient = {
          respond,
          autoApprove: (policy, options) =>
            autoApproveSessionPermissions({
              wait: waitClient,
              permissions: { respond },
            }, policy, options),
        }
        return {
          // firegrid-session-fact-client-surfaces.SESSION_IDENTITY.1
          // firegrid-session-fact-client-surfaces.CLIENT_SESSION.4
          sessionId,
          contextId: sessionId,
          prompt: request =>
            withClientSpan("firegrid.client.session.prompt", {
              "firegrid.session.id": sessionId,
            }, Effect.gen(function* () {
              const decoded = yield* decodeSessionHandlePromptInput(request)
              yield* awaitContextMaterialized(sessionId)
              yield* Effect.annotateCurrentSpan({
                "firegrid.context.id": sessionId,
                "firegrid.input.idempotency_key": decoded.idempotencyKey ?? "",
              })
              return yield* appendSessionPrompt(sessionId, decoded)
            })),
          start: () =>
            withClientSpan("firegrid.client.session.start", {
              "firegrid.session.id": sessionId,
              "firegrid.context.id": sessionId,
            }, Effect.gen(function*() {
              yield* awaitContextMaterialized(sessionId)
              return yield* hostSessionsStartChannel.binding.append({ sessionId }).pipe(
                Effect.mapError(cause => new AppendError({ contextId: sessionId, cause })),
              )
            })),
          cancel: request =>
            withClientSpan("firegrid.client.session.cancel", {
              "firegrid.session.id": sessionId,
              "firegrid.context.id": sessionId,
            }, cancelSession({
              sessionId,
              ...(request?.reason === undefined ? {} : { reason: request.reason }),
            })),
          close: request =>
            withClientSpan("firegrid.client.session.close", {
              "firegrid.session.id": sessionId,
              "firegrid.context.id": sessionId,
            }, closeSession({
              sessionId,
              ...(request?.reason === undefined ? {} : { reason: request.reason }),
            })),
          snapshot: () => readSnapshot(sessionId),
          wait: waitClient,
          permissions: permissionsClient,
        }
      })

    const createOrLoadSessionMethod = projectChannelMethod(
      FiregridClientOperations.sessions.createOrLoad,
      decoded =>
        Effect.gen(function* () {
          const runtime = yield* decodePublicLaunchRuntimeIntent(decoded.runtime)
          // tf-35f4 Sim 2: dispatch via the protocol-owned channel binding
          // instead of the in-client appendRuntimeContextRequest path. The
          // binding's call() writes the same contextRequests row through
          // RuntimeControlPlaneTable.insertOrGet — only the layer of
          // indirection changes. Same substrate, same idempotency, same row
          // shape; agent-tool / MCP projections share the same Tag.
          const response = yield* hostSessionsCreateOrLoadChannel.binding.call({
            externalKey: decoded.externalKey,
            runtime,
            ...(decoded.createdBy === undefined
              ? {}
              : { createdBy: decoded.createdBy }),
          })
          yield* Effect.annotateCurrentSpan({
            "firegrid.context.id": response.contextId,
            "firegrid.runtime.agent": runtime.config.agent ?? "",
            "firegrid.runtime.agent_protocol": runtime.config.agentProtocol ?? "",
            "firegrid.runtime_context_mcp.enabled": runtime.config.runtimeContextMcp?.enabled === true,
            "firegrid.channel.target": "host.sessions.create_or_load",
            "firegrid.channel.direction": "call",
          })
          return yield* makeSessionHandle(response.contextId)
        }),
      (decoded, cause) =>
        isLaunchInputError(cause)
          ? cause
          : new AppendError({
            contextId: sessionContextIdForExternalKey(decoded.externalKey),
            cause,
          }),
    )

    const createOrLoadSession = (
      request: SessionCreateOrLoadInput,
    ): Effect.Effect<
      FiregridSessionHandle,
      LaunchInputError | AppendError
    > =>
      withClientSpan("firegrid.client.session.create_or_load", {
        "firegrid.external_key.source": request.externalKey.source,
        "firegrid.external_key.id": request.externalKey.id,
      }, createOrLoadSessionMethod(request))

    const attachSession = (
      request: SessionAttachInput,
    ): Effect.Effect<FiregridSessionHandle, LaunchInputError> =>
      // firegrid-session-fact-client-surfaces.CLIENT_SESSION.1
      // firegrid-session-fact-client-surfaces.SESSION_IDENTITY.3
      Effect.flatMap(decodeSessionAttachInput(request), decoded =>
        makeSessionHandle(decoded.sessionId))

    const channelsClient = makeChannelsClient(channels)

    return Firegrid.of({
      launch: (request) => Effect.gen(function* () {
        // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1
        // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6
        // tf-aago: dispatch through HostContextsCreateChannel (callable).
        const decoded = yield* decodePublicLaunchRequest(request)
        const contextId = makeContextId()
        yield* hostContextsCreateChannel.binding.call({
          contextId,
          runtime: decoded.runtime,
          ...(decoded.requestedBy === undefined
            ? {}
            : { createdBy: decoded.requestedBy }),
        }).pipe(Effect.mapError(cause => new AppendError({ contextId, cause })))
        return open(contextId)
      }),
      prompt: request => Effect.gen(function* () {
        // firegrid-agent-ingress.INGRESS.6
        const decoded = yield* decodePublicPromptRequest(request)
        yield* awaitContextMaterialized(decoded.contextId)
        return yield* appendHostPrompt(decoded)
      }),
      sessions: {
        attach: attachSession,
        createOrLoad: createOrLoadSession,
        prompt: request => withClientSpan("firegrid.client.session.prompt", {
          "firegrid.session.id": request.sessionId,
        }, Effect.gen(function* () {
          const decoded = yield* decodeSessionPromptInput(request)
          yield* awaitContextMaterialized(decoded.sessionId)
          const inputId = decoded.inputId ?? `input_${crypto.randomUUID()}`
          yield* Effect.annotateCurrentSpan({
            "firegrid.context.id": decoded.sessionId,
            "firegrid.input.id": inputId,
          })
          yield* appendSessionPrompt(decoded.sessionId, {
            payload: decoded.prompt,
            inputId,
            idempotencyKey: inputId,
            ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }),
          })
          return {
            appended: true,
            sessionId: decoded.sessionId,
            inputId,
          }
        })),
        cancel: request => withClientSpan("firegrid.client.session.cancel", {
          "firegrid.session.id": request.sessionId,
        }, cancelSession(request)),
        close: request => withClientSpan("firegrid.client.session.close", {
          "firegrid.session.id": request.sessionId,
        }, closeSession(request)),
      },
      permissions: {
        respond: projectChannelMethod(
          FiregridClientOperations.permissions.respond,
          // tf-aago: dispatch through HostPermissionRespondChannel (callable,
          // host-scoped — contextId travels in the request).
          decoded =>
            hostPermissionRespondChannel.binding.append({
              contextId: decoded.contextId,
              permissionRequestId: decoded.permissionRequestId,
              decision: decoded.decision,
              ...(decoded.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: decoded.idempotencyKey }),
            }),
          (decoded, cause) => new AppendError({ contextId: decoded.contextId, cause }),
        ),
      },
      channels: channelsClient,
      wait: makeWaitClient(channelsClient),
      open,
      watchContexts,
    })
  })

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
//
// Namespace-scoped control plane layer. Consumed by the Firegrid
// client and host runtime; co-locating them on a single layer
// instance gives both sides one materialized RuntimeContext index
// so durable context/start requests and runtime projections share one
// materialized namespace view with the runtime host layer.
const configuredFiregridControlPlaneLayer = (
  cfg: ClientOptions,
) =>
  Effect.map(resolveConfig(cfg), (resolved) =>
    RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: resolved.controlPlaneStreamUrl,
        contentType: resolved.contentType,
        ...(resolved.headers === undefined ? {} : { headers: resolved.headers }),
      },
      txTimeoutMs: resolved.txTimeoutMs,
    }))

export const FiregridControlPlaneTableLive = Layer.unwrapEffect(
  Effect.flatMap(FiregridConfig, configuredFiregridControlPlaneLayer),
)

const configuredFiregridOutputLayer = (
  cfg: ClientOptions,
) =>
  Effect.map(resolveConfig(cfg), (resolved) =>
    RuntimeOutputTable.layer({
      streamOptions: {
        url: resolved.outputStreamUrl,
        contentType: resolved.contentType,
        ...(resolved.headers === undefined ? {} : { headers: resolved.headers }),
      },
      txTimeoutMs: resolved.txTimeoutMs,
    }))

export const FiregridOutputTableLive = Layer.unwrapEffect(
  Effect.flatMap(FiregridConfig, configuredFiregridOutputLayer),
)

const firegridServiceLayer = Layer.scoped(
  Firegrid,
  Effect.flatMap(FiregridConfig, (cfg) =>
    Effect.flatMap(resolveConfig(cfg), config => make(config, cfg.channels ?? []))),
)

/**
 * The Firegrid client service layer.
 *
 * Requires from scope:
 *   - `RuntimeControlPlaneTable`
 *   - `RuntimeOutputTable`
 *   - the protocol-owned channel Tags the rewired methods dispatch
 *     through (createOrLoad / contexts.create / sessions.start /
 *     permissions.respond), provided below by the client-sdk
 *     standalone-default Layers. Production hosts may override by
 *     providing the host-sdk-owned channel Live Layers upstream.
 *
 * Standalone consumers can fall back to the exported table Lives.
 */
// `FiregridLive` no longer provides standalone channel defaults — the
// host-side unified channel-bindings module is the canonical source of
// the channel Tags. Standalone client composition must compose the
// unified bindings explicitly (or run against a real host).
export const FiregridLive = firegridServiceLayer

/**
 * Standalone wiring: FiregridLive plus its own control-plane layer.
 * Suitable for clients that do not also run a runtime host in process
 * (e.g. a scenario that reads durable state through the snapshot
 * surface only).
 */
export const FiregridStandaloneLive = FiregridLive.pipe(
  Layer.provide(Layer.mergeAll(
    FiregridControlPlaneTableLive,
    FiregridOutputTableLive,
  )),
)
