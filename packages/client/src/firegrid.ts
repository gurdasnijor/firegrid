// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
//
// Public Firegrid client. Host authority lives in @firegrid/protocol,
// so the client reads `RuntimeContext.host` off durable rows and
// resolves host-owned ingress / output tables per-call rather than at
// layer-acquire time. Effect-typed: `launch` carries the
// `CurrentHostSession + Clock` requirement on its method signature so
// callers compose the client alongside a runtime host that provides
// those services; read-only consumers (snapshot / watchContexts) do
// not need a host session because the host id is read off the row.

import {
  PublicLaunchRequestSchema,
  PublicLaunchRuntimeIntentSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
  hostOwnedStreamUrl,
  insertLocalRuntimeContext,
  local,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type CurrentHostSession,
  type PublicLaunchRequest,
  type PublicLaunchRuntimeIntent,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
  type RuntimeRunEventRow,
  type RuntimeStartResult,
} from "@firegrid/protocol/launch"
import {
  FiregridAgentToolOperations,
  FiregridRuntimeObservationSourceNames,
  PermissionRespondInputSchema,
  SessionPromptToolInputSchema,
  WaitForToolInputSchema,
  type PermissionRespondInput,
  type PermissionRespondOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
  type WaitForToolInput,
  type WaitForToolOutput,
} from "@firegrid/protocol/agent-tools"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  nextRuntimeIngressSequence,
  promptToRuntimeIngressRequest,
  PublicPromptRequestSchema,
  type PublicPromptRequest,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import {
  SessionAttachInputSchema,
  SessionCreateOrLoadInputSchema,
  SessionHandlePromptInputSchema,
  SessionPermissionRequestWaitInputSchema,
  SessionPermissionRespondInputSchema,
  sessionContextIdForExternalKey,
  type FiregridSessionId,
  type SessionAttachDecodedInput,
  type SessionAttachInput,
  type RuntimePermissionRequestObservation,
  type SessionCreateOrLoadInput,
  type SessionHandlePromptInput,
  type SessionPermissionRequestWaitInput,
  type SessionPermissionRequestWaitOutput,
  type SessionPermissionRespondInput,
} from "@firegrid/protocol/session-facade"
import type { DurableTableHeaders } from "@firegrid/protocol"
import { Clock, Context, Data, Duration, Effect, Layer, Option, Schema, Stream } from "effect"

export interface ClientOptions {
  readonly durableStreamsBaseUrl?: string
  readonly namespace?: string
  readonly runtimeStreamUrl?: string
  readonly controlPlaneStreamUrl?: string
  readonly contentType?: string
  readonly headers?: DurableTableHeaders
  readonly txTimeoutMs?: number
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

export type PromptInputError = LaunchInputError

export type FiregridError =
  | PreloadError
  | LaunchInputError
  | AppendError
  | FiregridConfigError

export interface RuntimeContextSnapshot {
  readonly contextId: string
  readonly context?: RuntimeContext
  readonly status?: RuntimeRunEventRow["status"]
  readonly inputs: ReadonlyArray<RuntimeIngressInputRow>
  readonly runs: ReadonlyArray<RuntimeRunEventRow>
  readonly events: ReadonlyArray<RuntimeEventRow>
  readonly logs: ReadonlyArray<RuntimeLogLineRow>
}

export interface RuntimeContextHandle {
  readonly contextId: string
  readonly snapshot: Effect.Effect<RuntimeContextSnapshot, PreloadError>
}

export interface FiregridSessionWaitClient {
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
    PermissionRespondOutput,
    LaunchInputError | AppendError
  >
}

export interface FiregridSessionHandle {
  readonly sessionId: FiregridSessionId
  readonly contextId: string
  readonly prompt: (
    request: SessionHandlePromptInput,
  ) => Effect.Effect<RuntimeIngressInputRow, PromptInputError | AppendError>
  readonly start: () => Effect.Effect<
    RuntimeStartResult,
    unknown,
    RuntimeStartCapability
  >
  readonly snapshot: () => Effect.Effect<RuntimeContextSnapshot, PreloadError>
  readonly wait: FiregridSessionWaitClient
  readonly permissions: FiregridSessionPermissionsClient
}

export const FiregridClientOperations = {
  sessions: {
    prompt: FiregridAgentToolOperations.sessionPrompt,
  },
  wait: {
    for: FiregridAgentToolOperations.waitFor,
  },
  permissions: {
    respond: FiregridAgentToolOperations.permissionRespond,
  },
} as const

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
    LaunchInputError | AppendError,
    CurrentHostSession
  >
  readonly prompt: (
    request: SessionPromptToolInput,
  ) => Effect.Effect<
    SessionPromptToolOutput,
    PromptInputError | AppendError
  >
}

export interface FiregridWaitClient {
  readonly for: (
    request: WaitForToolInput,
  ) => Effect.Effect<WaitForToolOutput, LaunchInputError | PreloadError>
}

export interface FiregridPermissionsClient {
  readonly respond: (
    request: PermissionRespondInput,
  ) => Effect.Effect<
    PermissionRespondOutput,
    LaunchInputError | AppendError
  >
}

export interface FiregridService {
  readonly launch: (
    request: PublicLaunchRequest,
  ) => Effect.Effect<
    RuntimeContextHandle,
    LaunchInputError | AppendError,
    CurrentHostSession
  >
  readonly prompt: (
    request: PublicPromptRequest,
  ) => Effect.Effect<RuntimeIngressInputRow, PromptInputError | AppendError>
  readonly sessions: FiregridSessionsClient
  readonly wait: FiregridWaitClient
  readonly permissions: FiregridPermissionsClient
  readonly open: (contextId: string) => RuntimeContextHandle
  readonly watchContexts: (
    predicate?: (context: RuntimeContext) => boolean,
  ) => Stream.Stream<RuntimeContext, PreloadError>
}

export class Firegrid extends Context.Tag("@firegrid/client/Firegrid")<
  Firegrid,
  FiregridService
>() {}

export { local }

export const FiregridRuntimeTables = {
  ControlPlane: RuntimeControlPlaneTable,
  Ingress: RuntimeIngressTable,
  Output: RuntimeOutputTable,
} as const

export const firegridRuntimeTableTags = [
  RuntimeControlPlaneTable,
  RuntimeIngressTable,
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

const compareJournalRows = (
  left: { readonly activityAttempt: number; readonly sequence: number },
  right: { readonly activityAttempt: number; readonly sequence: number },
): number =>
  left.activityAttempt - right.activityAttempt || left.sequence - right.sequence

const makeContextId = (): string => `ctx_${crypto.randomUUID()}`

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

interface ResolvedConfig {
  readonly baseUrl: string
  readonly namespace: string | undefined
  readonly controlPlaneStreamUrl: string
  readonly contentType: string
  readonly headers: DurableTableHeaders | undefined
  readonly txTimeoutMs: number
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

    if (controlPlaneStreamUrl === undefined) {
      return yield* Effect.fail(new FiregridConfigError({
        cause: new Error(
          "FiregridConfig requires durableStreamsBaseUrl + namespace or a runtime/control-plane stream URL",
        ),
      }))
    }

    return {
      baseUrl: cfg.durableStreamsBaseUrl ?? "",
      namespace: cfg.namespace,
      controlPlaneStreamUrl,
      contentType: cfg.contentType ?? "application/json",
      headers: cfg.headers,
      txTimeoutMs: cfg.txTimeoutMs ?? 2_000,
    }
  })

/**
 * Build the stream options for a host-owned table layer scoped to a
 * specific runtime context. The host stream prefix is read off the
 * context row, so the URL is never composed at scenario sites.
 *
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
 */
const hostOwnedStreamOptions = (
  config: ResolvedConfig,
  context: RuntimeContext,
  segment: "runtimeIngress" | "runtimeOutput",
) => ({
  streamOptions: {
    url: hostOwnedStreamUrl({
      baseUrl: config.baseUrl,
      prefix: context.host.streamPrefix,
      segment,
    }),
    contentType: config.contentType,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  },
  txTimeoutMs: config.txTimeoutMs,
})

const ingressLayerForContext = (
  config: ResolvedConfig,
  context: RuntimeContext,
) =>
  RuntimeIngressTable.layer(
    hostOwnedStreamOptions(config, context, "runtimeIngress"),
  )

const outputLayerForContext = (
  config: ResolvedConfig,
  context: RuntimeContext,
) =>
  RuntimeOutputTable.layer(
    hostOwnedStreamOptions(config, context, "runtimeOutput"),
  )

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
  Schema.decodeUnknown(SessionPromptToolInputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionCreateOrLoadInput = (
  request: SessionCreateOrLoadInput,
): Effect.Effect<SessionCreateOrLoadInput, LaunchInputError> =>
  Schema.decodeUnknown(SessionCreateOrLoadInputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionAttachInput = (
  request: SessionAttachInput,
): Effect.Effect<SessionAttachDecodedInput, LaunchInputError> =>
  Schema.decodeUnknown(SessionAttachInputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionHandlePromptInput = (
  request: SessionHandlePromptInput,
): Effect.Effect<SessionHandlePromptInput, PromptInputError> =>
  Schema.decodeUnknown(SessionHandlePromptInputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodePermissionRespondInput = (
  request: PermissionRespondInput,
): Effect.Effect<PermissionRespondInput, LaunchInputError> =>
  Schema.decodeUnknown(PermissionRespondInputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionPermissionRespondInput = (
  request: SessionPermissionRespondInput,
): Effect.Effect<SessionPermissionRespondInput, LaunchInputError> =>
  Schema.decodeUnknown(SessionPermissionRespondInputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionPermissionRequestWaitInput = (
  request: SessionPermissionRequestWaitInput | undefined,
): Effect.Effect<SessionPermissionRequestWaitInput, LaunchInputError> =>
  request === undefined
    ? Effect.succeed({})
    : Schema.decodeUnknown(SessionPermissionRequestWaitInputSchema, {
      onExcessProperty: "error",
    })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeWaitForInput = (
  request: WaitForToolInput,
): Effect.Effect<WaitForToolInput, LaunchInputError> =>
  Schema.decodeUnknown(WaitForToolInputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const sessionPromptToRuntimeIngressRequest = (
  input: SessionPromptToolInput,
): RuntimeIngressRequest => ({
  ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
  contextId: input.sessionId,
  kind: "message",
  authoredBy: "client",
  payload: input.prompt,
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
})

const permissionRespondToRuntimeIngressRequest = (
  input: PermissionRespondInput,
): RuntimeIngressRequest => ({
  contextId: input.contextId,
  kind: "control",
  authoredBy: "client",
  payload: {
    _tag: "PermissionResponse",
    permissionRequestId: input.permissionRequestId,
    decision: input.decision,
  },
  idempotencyKey:
    input.idempotencyKey ??
    `permission-response:${input.contextId}:${input.permissionRequestId}`,
})

const snapshotFromJournal = (
  contextId: string,
  inputs: {
    readonly context?: RuntimeContext
    readonly runs: ReadonlyArray<RuntimeRunEventRow>
    readonly ingressInputs: ReadonlyArray<RuntimeIngressInputRow>
    readonly events: ReadonlyArray<RuntimeEventRow>
    readonly logs: ReadonlyArray<RuntimeLogLineRow>
  },
): RuntimeContextSnapshot => {
  const events = inputs.events
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
  const logs = inputs.logs
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
  const runs = [...inputs.runs].sort((left, right) =>
    left.at.localeCompare(right.at))
  const promptInputs = [...inputs.ingressInputs]
    .filter(row => row.contextId === contextId)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
  const status = latestStatus(runs)
  return {
    contextId,
    ...(inputs.context === undefined ? {} : { context: inputs.context }),
    ...(status === undefined ? {} : { status }),
    inputs: promptInputs,
    runs,
    events,
    logs,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const matchesWhereFields = (
  row: unknown,
  whereFields: Readonly<Record<string, unknown>>,
): boolean =>
  isRecord(row) &&
  Object.entries(whereFields).every(([field, expected]) =>
    row[field] === expected)

const contextIdFromWhereFields = (
  input: WaitForToolInput,
): Effect.Effect<string, LaunchInputError> => {
  const contextId = input.eventQuery.whereFields.contextId
  if (typeof contextId === "string" && contextId.length > 0) {
    return Effect.succeed(contextId)
  }
  return Effect.fail(new LaunchInputError({
    cause: new Error(
      `wait.for source ${input.eventQuery.stream} requires whereFields.contextId`,
    ),
  }))
}

const mapWaitError = (cause: unknown): LaunchInputError | PreloadError => {
  if (isRecord(cause) && cause._tag === "LaunchInputError") {
    return cause as unknown as LaunchInputError
  }
  if (isRecord(cause) && cause._tag === "PreloadError") {
    return cause as unknown as PreloadError
  }
  return new PreloadError({ cause })
}

const agentOutputObservationFromRow = (
  row: RuntimeEventRow,
): Option.Option<Readonly<Record<string, unknown>>> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.raw)
  } catch {
    return Option.none()
  }
  if (!isRecord(parsed) || parsed.type !== "firegrid.agent-output") {
    return Option.none()
  }
  const event = parsed.event
  if (!isRecord(event) || typeof event._tag !== "string") {
    return Option.none()
  }
  const base = {
    contextId: row.contextId,
    activityAttempt: row.activityAttempt,
    sequence: row.sequence,
    _tag: event._tag,
    event,
  }
  if (event._tag === "PermissionRequest") {
    return Option.some({
      ...base,
      permissionRequestId: event.permissionRequestId,
      toolUseId: event.toolUseId,
    })
  }
  if (event._tag === "ToolUse" && isRecord(event.part)) {
    return Option.some({
      ...base,
      toolUseId: event.part.id,
      toolName: event.part.name,
    })
  }
  return Option.some(base)
}

const permissionRequestObservationFromRow = (
  row: RuntimeEventRow,
): Option.Option<RuntimePermissionRequestObservation> =>
  Option.flatMap(agentOutputObservationFromRow(row), (observation) => {
    if (observation._tag !== "PermissionRequest") return Option.none()
    if (typeof observation.permissionRequestId !== "string") return Option.none()
    if (typeof observation.toolUseId !== "string") return Option.none()
    if (!isRecord(observation.event)) return Option.none()
    return Option.some({
      source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
      contextId: row.contextId,
      activityAttempt: row.activityAttempt,
      sequence: row.sequence,
      _tag: "PermissionRequest",
      permissionRequestId: observation.permissionRequestId,
      toolUseId: observation.toolUseId,
      event: observation.event,
    })
  })

const waitForFirstMatch = (
  stream: Stream.Stream<unknown, PreloadError>,
  input: WaitForToolInput,
): Effect.Effect<WaitForToolOutput, PreloadError> => {
  const run = Stream.runHead(
    stream.pipe(
      Stream.filter(row => matchesWhereFields(
        row,
        input.eventQuery.whereFields,
      )),
    ),
  )
  const awaited = input.timeoutMs === undefined
    ? run
    : Effect.raceFirst(
      run,
      Clock.sleep(Duration.millis(input.timeoutMs)).pipe(
        Effect.as(Option.none<unknown>()),
      ),
    )
  return Effect.map(awaited, Option.match({
    onNone: () => ({ matched: false, timedOut: true }) as const,
    onSome: event => ({ matched: true, event }) as const,
  }))
}

const make = (config: ResolvedConfig) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable

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
        const context = yield* resolveContext(contextId)
        const runs = yield* control.runs.query((coll) =>
          coll.toArray.filter(row => row.contextId === contextId)).pipe(
            Effect.mapError(cause => new PreloadError({ cause })),
          )

        if (context === undefined) {
          return snapshotFromJournal(contextId, {
            runs,
            ingressInputs: [],
            events: [],
            logs: [],
          })
        }

        // firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
        // Host-owned ingress and output tables are opened per snapshot
        // using the context's host binding. The control plane stays
        // namespace-scoped (the RuntimeContext index is global).
        const hostOwned = yield* Effect.gen(function* () {
          const ingressTable = yield* RuntimeIngressTable
          const outputTable = yield* RuntimeOutputTable
          const ingressInputs = yield* ingressTable.inputs.query((coll) =>
            coll.toArray.filter(row => row.contextId === contextId))
          const events = yield* outputTable.events.query((coll) =>
            coll.toArray.filter(row => row.contextId === contextId))
          const logs = yield* outputTable.logs.query((coll) =>
            coll.toArray.filter(row => row.contextId === contextId))
          return { ingressInputs, events, logs }
        }).pipe(
          Effect.provide(ingressLayerForContext(config, context)),
          Effect.provide(outputLayerForContext(config, context)),
          Effect.scoped,
          Effect.mapError(cause => new PreloadError({ cause })),
        )

        return snapshotFromJournal(contextId, {
          context,
          runs,
          ingressInputs: hostOwned.ingressInputs,
          events: hostOwned.events,
          logs: hostOwned.logs,
        })
      })

    const open = (contextId: string): RuntimeContextHandle => ({
      contextId,
      snapshot: readSnapshot(contextId),
    })

    const watchContexts = (
      predicate: (context: RuntimeContext) => boolean = () => true,
    ): Stream.Stream<RuntimeContext, PreloadError> =>
      control.contexts.subscribe<RuntimeContext>((coll, emit) => {
        const sub = coll.subscribeChanges(
          changes => {
            for (const change of changes) {
              if (change.value !== undefined && predicate(change.value)) {
                emit(change.value)
              }
            }
          },
          { includeInitialState: true },
        )
        return () => sub.unsubscribe()
      }).pipe(
        Stream.mapError(cause => new PreloadError({ cause })),
      )

    const appendPrompt = (
      contextId: string,
      row: RuntimeIngressInputRow,
    ): Effect.Effect<RuntimeIngressInputRow, AppendError> =>
      Effect.gen(function* () {
        const context = yield* resolveContext(contextId).pipe(
          Effect.mapError(cause =>
            new AppendError({ contextId, cause })),
        )
        if (context === undefined) {
          return yield* Effect.fail(
            new AppendError({
              contextId,
              cause: new Error(`runtime context ${contextId} not found`),
            }),
          )
        }

        return yield* Effect.gen(function* () {
          const ingress = yield* RuntimeIngressTable
          const existing = yield* ingress.inputs.get(row.inputId)
          if (Option.isSome(existing)) return existing.value
          // firegrid-agent-ingress.INGRESS.9
          const nextSequence = yield* nextRuntimeIngressSequence(
            ingress,
            row.contextId,
          )
          const sequenced = {
            ...row,
            // firegrid-agent-ingress.INGRESS.9
            status: "sequenced" as const,
            sequence: nextSequence,
            sequencedAt: yield* nowIso,
          }
          yield* ingress.inputs.insert(sequenced)
          return sequenced
        }).pipe(
          Effect.provide(ingressLayerForContext(config, context)),
          Effect.scoped,
          Effect.mapError(cause =>
            new AppendError({ contextId, cause })),
        )
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
        const context = yield* resolveContext(contextId)
        if (context === undefined) {
          return yield* Effect.fail(new PreloadError({
            cause: new Error(`runtime context ${contextId} not found`),
          }))
        }
        const run = Effect.gen(function* () {
          const output = yield* RuntimeOutputTable
          return yield* Stream.runHead(
            output.events.rows().pipe(
              Stream.mapError(cause => new PreloadError({ cause })),
              Stream.filterMap(permissionRequestObservationFromRow),
              Stream.filter(observation =>
                observation.contextId === contextId &&
                (input.afterSequence === undefined ||
                  observation.sequence > input.afterSequence),
              ),
            ),
          )
        }).pipe(
          Effect.provide(outputLayerForContext(config, context)),
          Effect.scoped,
          Effect.mapError(cause => new PreloadError({ cause })),
        )
        const awaited = input.timeoutMs === undefined
          ? run
          : Effect.raceFirst(
            run,
            Clock.sleep(Duration.millis(input.timeoutMs)).pipe(
              Effect.as(Option.none<RuntimePermissionRequestObservation>()),
            ),
          )
        const matched = yield* awaited
        return Option.match(matched, {
          onNone: () => ({ matched: false, timedOut: true }) as const,
          onSome: request => ({ matched: true, request }) as const,
        })
      })

    const makeSessionHandle = (
      sessionId: FiregridSessionId,
    ): FiregridSessionHandle => ({
      // firegrid-session-fact-client-surfaces.SESSION_IDENTITY.1
      // firegrid-session-fact-client-surfaces.CLIENT_SESSION.4
      sessionId,
      contextId: sessionId,
      prompt: request =>
        Effect.gen(function* () {
          const decoded = yield* decodeSessionHandlePromptInput(request)
          const row = makeRuntimeIngressInputRow({
            contextId: sessionId,
            kind: "message",
            authoredBy: "client",
            payload: decoded.payload,
            idempotencyKey: decoded.idempotencyKey,
            ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }),
          })
          return yield* appendPrompt(sessionId, row)
        }),
      start: () =>
        Effect.gen(function* () {
          const starter = yield* RuntimeStartCapability
          return yield* starter.start({ contextId: sessionId })
        }),
      snapshot: () => readSnapshot(sessionId),
      wait: {
        forPermissionRequest: request =>
          waitForPermissionRequest(sessionId, request),
      },
      permissions: {
        respond: request =>
          Effect.gen(function* () {
            const decoded = yield* decodeSessionPermissionRespondInput(request)
            const row = makeRuntimeIngressInputRow({
              contextId: sessionId,
              kind: "control",
              authoredBy: "client",
              payload: {
                _tag: "PermissionResponse",
                permissionRequestId: decoded.permissionRequestId,
                decision: decoded.decision,
              },
              idempotencyKey:
                decoded.idempotencyKey ??
                `permission-response:${sessionId}:${decoded.permissionRequestId}`,
            })
            const appended = yield* appendPrompt(sessionId, row)
            return {
              responded: true,
              contextId: sessionId,
              permissionRequestId: decoded.permissionRequestId,
              inputId: appended.inputId,
            }
          }),
      },
    })

    const createOrLoadSession = (
      request: SessionCreateOrLoadInput,
    ): Effect.Effect<
      FiregridSessionHandle,
      LaunchInputError | AppendError,
      CurrentHostSession
    > =>
      Effect.gen(function* () {
        const decoded = yield* decodeSessionCreateOrLoadInput(request)
        const runtime = yield* decodePublicLaunchRuntimeIntent(decoded.runtime)
        const contextId = sessionContextIdForExternalKey(decoded.externalKey)
        const existing = yield* resolveContext(contextId).pipe(
          Effect.mapError(cause =>
            new AppendError({ contextId, cause })),
        )
        if (existing === undefined) {
          yield* insertLocalRuntimeContext(normalizeRuntimeIntent(runtime), {
            contextId,
            ...(decoded.createdBy === undefined ? {} : { createdBy: decoded.createdBy }),
          }).pipe(
            Effect.provideService(RuntimeControlPlaneTable, control),
            Effect.mapError(cause =>
              new AppendError({ contextId, cause })),
          )
        }
        return makeSessionHandle(contextId)
      })

    const attachSession = (
      request: SessionAttachInput,
    ): Effect.Effect<FiregridSessionHandle, LaunchInputError> =>
      // firegrid-session-fact-client-surfaces.CLIENT_SESSION.1
      // firegrid-session-fact-client-surfaces.SESSION_IDENTITY.3
      Effect.map(decodeSessionAttachInput(request), decoded =>
        makeSessionHandle(decoded.sessionId))

    const waitForControlRows = (
      input: WaitForToolInput,
    ): Effect.Effect<WaitForToolOutput, PreloadError> =>
      waitForFirstMatch(
        control.runs.rows().pipe(
          Stream.mapError(cause => new PreloadError({ cause })),
        ),
        input,
      )

    const waitContextFor = (
      input: WaitForToolInput,
    ): Effect.Effect<RuntimeContext, LaunchInputError | PreloadError> =>
      Effect.gen(function* () {
        const contextId = yield* contextIdFromWhereFields(input)
        const context = yield* resolveContext(contextId)
        if (context === undefined) {
          return yield* Effect.fail(new PreloadError({
            cause: new Error(`runtime context ${contextId} not found`),
          }))
        }
        return context
      })

    const waitForRowsInLayer = <R>(
      input: WaitForToolInput,
      layer: Layer.Layer<R, unknown, never>,
      stream: Effect.Effect<Stream.Stream<unknown, unknown>, never, R>,
    ): Effect.Effect<WaitForToolOutput, LaunchInputError | PreloadError> =>
      Effect.flatMap(stream, rows =>
        waitForFirstMatch(
          rows.pipe(Stream.mapError(cause => new PreloadError({ cause }))),
          input,
        )).pipe(
          Effect.provide(layer),
          Effect.scoped,
          Effect.mapError(mapWaitError),
        )

    const waitForHostRows = <R>(
      input: WaitForToolInput,
      layerForContext: (context: RuntimeContext) => Layer.Layer<R, unknown, never>,
      stream: Effect.Effect<Stream.Stream<unknown, unknown>, never, R>,
    ): Effect.Effect<WaitForToolOutput, LaunchInputError | PreloadError> =>
      Effect.gen(function* () {
        const context = yield* waitContextFor(input)
        return yield* waitForRowsInLayer(
          input,
          layerForContext(context),
          stream,
        )
      })

    const waitFor = (
      request: WaitForToolInput,
    ): Effect.Effect<WaitForToolOutput, LaunchInputError | PreloadError> =>
      Effect.gen(function* () {
        const input = yield* decodeWaitForInput(request)
        switch (input.eventQuery.stream) {
          case FiregridRuntimeObservationSourceNames.runtimeRuns:
            return yield* waitForControlRows(input)
          case FiregridRuntimeObservationSourceNames.runtimeOutputEvents:
            return yield* waitForHostRows(
              input,
              context => outputLayerForContext(config, context),
              Effect.map(RuntimeOutputTable, table => table.events.rows()),
            )
          case FiregridRuntimeObservationSourceNames.runtimeOutputLogs:
            return yield* waitForHostRows(
              input,
              context => outputLayerForContext(config, context),
              Effect.map(RuntimeOutputTable, table => table.logs.rows()),
            )
          case FiregridRuntimeObservationSourceNames.runtimeIngressInputs:
            return yield* waitForHostRows(
              input,
              context => ingressLayerForContext(config, context),
              Effect.map(RuntimeIngressTable, table => table.inputs.rows()),
            )
          case FiregridRuntimeObservationSourceNames.runtimeIngressDeliveries:
            return yield* waitForHostRows(
              input,
              context => ingressLayerForContext(config, context),
              Effect.map(RuntimeIngressTable, table => table.deliveries.rows()),
            )
          case FiregridRuntimeObservationSourceNames.agentOutputEvents:
            return yield* waitForHostRows(
              input,
              context => outputLayerForContext(config, context),
              Effect.map(RuntimeOutputTable, table =>
                table.events.rows().pipe(
                  Stream.filterMap(agentOutputObservationFromRow),
                )),
            )
          default:
            return yield* Effect.fail(new LaunchInputError({
              cause: new Error(
                `unsupported wait.for source ${input.eventQuery.stream}`,
              ),
            }))
        }
      })

    return Firegrid.of({
      launch: (request) => Effect.gen(function* () {
        // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1
        // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6
        // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
        //
        // Routed through the shared `insertLocalRuntimeContext`
        // primitive (from @firegrid/protocol). The method requires
        // `CurrentHostSession` at the call site, so the launched row
        // carries the same host binding the runtime host will
        // recognize via `requireLocalContext`.
        const decoded = yield* decodePublicLaunchRequest(request)
        const intent = {
          provider: "local-process" as const,
          config: {
            argv: [...decoded.runtime.config.argv],
            ...(decoded.runtime.config.cwd === undefined
              ? {}
              : { cwd: decoded.runtime.config.cwd }),
            ...(decoded.runtime.config.envBindings === undefined
              ? {}
              : {
                envBindings: decoded.runtime.config.envBindings.map(b => ({
                  name: b.name,
                  ref: b.ref,
                })),
              }),
          },
          journal: [
            { source: "stdout" as const, format: "jsonl" as const, target: "events" as const },
            { source: "stderr" as const, format: "text-lines" as const, target: "logs" as const },
          ],
        }
        const contextId = makeContextId()
        const context = yield* insertLocalRuntimeContext(intent, {
          contextId,
          ...(decoded.requestedBy === undefined ? {} : { createdBy: decoded.requestedBy }),
        }).pipe(
          Effect.mapError(cause => new AppendError({ contextId, cause })),
        )
        return open(context.contextId)
      }),
      prompt: request => Effect.gen(function* () {
        // firegrid-agent-ingress.INGRESS.6
        const decoded = yield* decodePublicPromptRequest(request)
        const row = makeRuntimeIngressInputRow(promptToRuntimeIngressRequest(decoded))
        return yield* appendPrompt(decoded.contextId, row)
      }),
      sessions: {
        attach: attachSession,
        createOrLoad: createOrLoadSession,
        prompt: request => Effect.gen(function* () {
          const decoded = yield* decodeSessionPromptInput(request)
          const row = makeRuntimeIngressInputRow(
            sessionPromptToRuntimeIngressRequest(decoded),
          )
          const appended = yield* appendPrompt(decoded.sessionId, row)
          return {
            appended: true,
            sessionId: decoded.sessionId,
            inputId: appended.inputId,
          }
        }),
      },
      wait: {
        for: waitFor,
      },
      permissions: {
        respond: request => Effect.gen(function* () {
          const decoded = yield* decodePermissionRespondInput(request)
          const row = makeRuntimeIngressInputRow(
            permissionRespondToRuntimeIngressRequest(decoded),
          )
          const appended = yield* appendPrompt(decoded.contextId, row)
          return {
            responded: true,
            contextId: decoded.contextId,
            permissionRequestId: decoded.permissionRequestId,
            inputId: appended.inputId,
          }
        }),
      },
      open,
      watchContexts,
    })
  })

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
//
// Namespace-scoped control plane layer. Consumed by the Firegrid
// client and host runtime; co-locating them on a single layer
// instance gives both sides one materialized RuntimeContext index
// so an `insertLocalRuntimeContext` write is observable from a
// subsequent client `prompt` / `snapshot` without cross-instance
// replication latency.
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

const firegridServiceLayer = Layer.scoped(
  Firegrid,
  Effect.flatMap(FiregridConfig, (cfg) =>
    Effect.flatMap(resolveConfig(cfg), make)),
)

/**
 * The Firegrid client service layer. Requires
 * `RuntimeControlPlaneTable` from scope so it shares one materialized
 * RuntimeContext index with the runtime host layer when both are
 * composed in the same scope. Standalone consumers can fall back to
 * `FiregridControlPlaneTableLive`.
 */
export const FiregridLive = firegridServiceLayer

/**
 * Standalone wiring: FiregridLive plus its own control-plane layer.
 * Suitable for clients that do not also run a runtime host in
 * process (e.g. a scenario that reads durable state through the
 * snapshot surface only).
 */
export const FiregridStandaloneLive = FiregridLive.pipe(
  Layer.provide(FiregridControlPlaneTableLive),
)
