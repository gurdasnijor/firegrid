// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
//
// Public Firegrid client. This package is browser/app safe: it writes
// launch/start/permission control requests through protocol channel Tags and
// reads durable control/output projections, but it does not own live runtime
// input delivery. Prompt still writes runtime-input intents directly pending
// tf-fyyk's prompt egress-return decision.

import {
  PublicLaunchRequestSchema,
  PublicLaunchRuntimeIntentSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  type RuntimeOutputTableService,
  local,
  runtimeControlPlaneStreamUrl,
  runtimeContextOutputStreamUrl,
  type PublicLaunchRequest,
  type PublicLaunchRuntimeIntent,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
  type RuntimeRunEventRow,
  type RuntimeStartRequestAck,
} from "@firegrid/protocol/launch"
import {
  type PermissionRespondInput,
  type PermissionRespondOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
} from "@firegrid/protocol/session-facade"
import {
  makeRuntimeInputIntentRow,
  PublicPromptRequestSchema,
  promptToRuntimeIngressRequest,
  type PublicPromptRequest,
  type RuntimeInputIntentRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { stampRowOtel } from "@firegrid/protocol/otel"
import {
  makeIngressChannel,
  SessionAgentOutputChannelTarget,
  type IngressChannel,
} from "@firegrid/protocol/channels"
import {
  runtimeAgentOutputObservationFromRow,
  runtimePermissionRequestObservationFromAgentOutput,
  RuntimeAgentOutputObservationSchema,
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
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostSessionsCreateOrLoadChannel,
  HostSessionsStartChannel,
} from "@firegrid/protocol/channels"
import { Clock, Context, Data, Duration, Effect, Exit, Layer, Option, Ref, Schema, Scope, Stream } from "effect"
import { HostControlChannelsStandaloneLive } from "./channels/host-control-default.ts"
import { HostSessionsCreateOrLoadChannelStandaloneLive } from "./channels/host-sessions-create-or-load-default.ts"
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
export type { RuntimeStartRequestAck } from "@firegrid/protocol/launch"
export { FiregridClientOperations } from "./operations.ts"

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
    PermissionRespondOutput,
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
  readonly whenReady: Effect.Effect<void, PreloadError>
  readonly prompt: (
    request: SessionHandlePromptInput,
  ) => Effect.Effect<RuntimeInputIntentRow, PromptInputError | AppendError>
  readonly start: () => Effect.Effect<
    RuntimeStartRequestAck,
    AppendError
  >
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
    LaunchInputError | AppendError
  >
  readonly prompt: (
    request: PublicPromptRequest,
  ) => Effect.Effect<RuntimeInputIntentRow, PromptInputError | AppendError>
  readonly sessions: FiregridSessionsClient
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

const compareJournalRows = (
  left: { readonly activityAttempt: number; readonly sequence: number },
  right: { readonly activityAttempt: number; readonly sequence: number },
): number =>
  left.activityAttempt - right.activityAttempt || left.sequence - right.sequence

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
      return yield* new FiregridConfigError({
        cause: new Error(
          "FiregridConfig requires durableStreamsBaseUrl + namespace or a runtime/control-plane stream URL",
        ),
      })
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

const durableTableOptions = (
  config: ResolvedConfig,
  url: string,
) => ({
  streamOptions: {
    url,
    contentType: config.contentType,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  },
  txTimeoutMs: config.txTimeoutMs,
})

const outputLayerForContext = (
  config: ResolvedConfig,
  context: RuntimeContext,
) =>
  RuntimeOutputTable.layer(
    durableTableOptions(
      config,
      runtimeContextOutputStreamUrl({
        baseUrl: config.baseUrl,
        prefix: context.host.streamPrefix,
        contextId: context.contextId,
      }),
    ),
  )

const clientSessionAgentOutputChannel = (
  output: RuntimeOutputTableService,
): IngressChannel<typeof RuntimeAgentOutputObservationSchema> =>
  makeIngressChannel({
    target: SessionAgentOutputChannelTarget,
    schema: RuntimeAgentOutputObservationSchema,
    sourceClass: "static-source",
    stream: output.events.rows().pipe(
      Stream.filterMap(runtimeAgentOutputObservationFromRow),
      Stream.withSpan("firegrid.client.channel.session_agent_output", {
        kind: "client",
        attributes: {
          "firegrid.channel.target": String(SessionAgentOutputChannelTarget),
          "firegrid.channel.direction": "ingress",
        },
      }),
    ),
  })

const waitForIngressChannelProjection = (
  channel: IngressChannel<typeof RuntimeAgentOutputObservationSchema>,
  predicate: (observation: RuntimeAgentOutputObservation) => boolean,
): Effect.Effect<void, unknown> =>
  projectionWait(channel.binding.stream, predicate).pipe(
    Effect.withSpan("firegrid.client.channel.wait_for", {
      kind: "client",
      attributes: {
        "firegrid.channel.target": String(channel.target),
        "firegrid.channel.direction": channel.direction,
        "firegrid.wait.bucket": "projection",
      },
    }),
  )

// tf-ivl6: per-contextId cache entry for getOutputService. Each
// handle owns its own CloseableScope so the make-body finalizer can
// tear down all materialized RuntimeOutputTable layers on service
// shutdown. The cached service is the already-extracted
// RuntimeOutputTableService, not the Context<any> the Layer builds into.
interface OutputContextHandle {
  readonly service: RuntimeOutputTableService
  readonly scope: Scope.CloseableScope
}

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
  Schema.decodeUnknown(FiregridClientOperations.sessions.prompt.inputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionCreateOrLoadInput = (
  request: SessionCreateOrLoadInput,
): Effect.Effect<SessionCreateOrLoadInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.sessions.createOrLoad.inputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionAttachInput = (
  request: SessionAttachInput,
): Effect.Effect<SessionAttachDecodedInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.sessions.attach.inputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionHandlePromptInput = (
  request: SessionHandlePromptInput,
): Effect.Effect<SessionHandlePromptInput, PromptInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.sessions.promptScoped.inputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodePermissionRespondInput = (
  request: PermissionRespondInput,
): Effect.Effect<PermissionRespondInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.permissions.respond.inputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionPermissionRespondInput = (
  request: SessionPermissionRespondInput,
): Effect.Effect<SessionPermissionRespondInput, LaunchInputError> =>
  Schema.decodeUnknown(FiregridClientOperations.permissions.respondScoped.inputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionPermissionRequestWaitInput = (
  request: SessionPermissionRequestWaitInput | undefined,
): Effect.Effect<SessionPermissionRequestWaitInput, LaunchInputError> =>
  request === undefined
    ? Effect.succeed({})
    : Schema.decodeUnknown(FiregridClientOperations.wait.forPermissionRequest.inputSchema, {
      onExcessProperty: "error",
    })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const decodeSessionAgentOutputWaitInput = (
  request: SessionAgentOutputWaitInput | undefined,
): Effect.Effect<SessionAgentOutputWaitInput, LaunchInputError> =>
  request === undefined
    ? Effect.succeed({})
    : Schema.decodeUnknown(FiregridClientOperations.wait.forAgentOutput.inputSchema, {
      onExcessProperty: "error",
    })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

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
    .sort(compareJournalRows)
  const agentOutputs = events.flatMap(row => {
    const observation = runtimeAgentOutputObservationFromRow(row)
    return Option.isSome(observation) ? [observation.value] : []
  })
  const logs = inputs.logs
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
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

const make = (config: ResolvedConfig) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable
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
    const hostSessionsStartChannel = yield* HostSessionsStartChannel
    const hostPermissionRespondChannel = yield* HostPermissionRespondChannel

    // tf-ivl6 / tf-tw49 concern #1: per-contextId RuntimeOutputTable
    // cache. Baseline trace showed 75 of 80 layer.acquire spans landing
    // on firegrid.runtimeOutput with ~2.5x amplification per public
    // client call (readSnapshot + waitForAgentOutputObservation each
    // built a fresh layer on every invocation). Caching by contextId
    // for the service lifetime collapses the per-call createStreamDB
    // preload + open subscription onto a shared connection; per-call
    // projectionWait / .query each still get their own sub-scope on
    // top.
    const outputContextHandles = yield* Ref.make(
      new Map<string, OutputContextHandle>(),
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const current = yield* Ref.get(outputContextHandles)
        yield* Effect.forEach(
          current.values(),
          handle => Scope.close(handle.scope, Exit.void),
          { discard: true },
        )
        yield* Ref.set(outputContextHandles, new Map())
      }))

    const getOutputService = (
      context: RuntimeContext,
    ): Effect.Effect<RuntimeOutputTableService, PreloadError> =>
      Effect.gen(function* () {
        const cached0 = (yield* Ref.get(outputContextHandles)).get(context.contextId)
        if (cached0 !== undefined) return cached0.service
        const scope = yield* Scope.make()
        const built = yield* Layer.buildWithScope(
          outputLayerForContext(config, context),
          scope,
        ).pipe(
          Effect.mapError(cause => new PreloadError({ cause })),
        )
        const service = Context.get(built, RuntimeOutputTable)
        // Lost-race resolution: another fiber may have raced us. Adopt
        // the winner's handle and tear down our orphan so the cache
        // holds exactly one handle per contextId.
        const adopted = yield* Ref.modify(outputContextHandles, m => {
          const winner = m.get(context.contextId)
          if (winner !== undefined) return [winner, m] as const
          const handle: OutputContextHandle = { service, scope }
          return [handle, new Map([...m, [context.contextId, handle]])] as const
        })
        if (adopted.scope !== scope) {
          yield* Scope.close(scope, Exit.void)
        }
        return adopted.service
      })

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
            events: [],
            logs: [],
          })
        }

        // firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
        // Output is still read from the context-owned stream. Runtime
        // input delivery is workflow-deferred and host-owned; the
        // client does not open the legacy durable input table.
        const outputTable = yield* getOutputService(context)
        const events = yield* outputTable.events.query((coll) =>
          coll.toArray.filter(row => row.contextId === contextId)).pipe(
            Effect.mapError(cause => new PreloadError({ cause })),
          )
        const logs = yield* outputTable.logs.query((coll) =>
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
        const context = yield* resolveContext(contextId)
        if (context === undefined) {
          return yield* new PreloadError({
            cause: new Error(`runtime context ${contextId} not found`),
          })
        }
        const output = yield* getOutputService(context)
        const run = Effect.gen(function* () {
          let matched: RuntimeAgentOutputObservation | undefined
          yield* waitForIngressChannelProjection(
            clientSessionAgentOutputChannel(output),
            observation => {
              const isMatch = observation.contextId === contextId &&
                (input.afterSequence === undefined ||
                  observation.sequence > input.afterSequence) &&
                predicate(observation)
              if (isMatch) matched = observation
              return isMatch
            },
          )
          return Option.fromNullable(matched)
        }).pipe(
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
        control.contexts.rows(),
        context => context.contextId === contextId,
      ).pipe(
        Effect.mapError(cause => new PreloadError({ cause })),
      )

    const appendRuntimeInputIntent = (
      request: RuntimeIngressRequest,
    ): Effect.Effect<RuntimeInputIntentRow, AppendError> =>
      Effect.gen(function* () {
        const context = yield* resolveContext(request.contextId).pipe(
          Effect.mapError(cause =>
            new AppendError({ contextId: request.contextId, cause })),
        )
        if (context === undefined) {
          return yield* new AppendError({
            contextId: request.contextId,
            cause: new Error(`runtime context ${request.contextId} not found`),
          })
        }
        const intent = makeRuntimeInputIntentRow(request)
        // Capture the producer-side trace context INSIDE the producer span so
        // the stamped traceparent points at that span (consumer becomes its
        // descendant via the row carrier).
        const stamped = yield* stampRowOtel(intent)
        const result = yield* control.inputIntents.insertOrGet(stamped).pipe(
          Effect.mapError(cause =>
            new AppendError({ contextId: request.contextId, cause })),
        )
        return result._tag === "Found" ? result.row : stamped
      }).pipe(
        Effect.withSpan("firegrid.client.runtime_input_intent.append", {
          kind: "producer",
          attributes: {
            "firegrid.context.id": request.contextId,
            "firegrid.input.kind": request.kind,
            "firegrid.input.idempotency_key": request.idempotencyKey ?? "",
          },
        }),
      )

    // tf-aago: contexts.create / sessions.start / permissions.respond write
    // helpers deleted — those methods now dispatch through their callable
    // channel Tags (HostContextsCreate / HostSessionsStart /
    // HostPermissionRespond), whose bindings live in the shared
    // @firegrid/protocol/launch factories. `appendRuntimeInputIntent`
    // survives only for prompt egress paths: HostPrompt / SessionPrompt
    // channels return void, but the client prompt methods return the stored
    // RuntimeInputIntentRow (tests assert returned === stored, createdAt
    // included). tf-fyyk owns that prompt egress-return decision; until then
    // prompt stays on this local helper as the known residual direct write.

    const makeSessionHandle = (
      sessionId: FiregridSessionId,
    ): Effect.Effect<FiregridSessionHandle> =>
      Effect.gen(function* () {
        // Per-session-handle tracking of the last agent-output sequence
        // observed by wait.forAgentOutput. Defaultizes afterSequence so a
        // driver loop ("give me the next agent output") actually waits
        // instead of immediately re-matching the first observation. An
        // explicit request.afterSequence still overrides the tracked value
        // so callers can rewind/replay. Mirrors the structural readiness
        // pattern of whenReady (PR #435).
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
        const respond = (
          request: SessionPermissionRespondInput,
        ): Effect.Effect<
          PermissionRespondOutput,
          LaunchInputError | AppendError
        > =>
          Effect.gen(function* () {
            // tf-aago: session-scoped respond dispatches through the same
            // host-scoped HostPermissionRespondChannel, supplying the
            // handle's sessionId as contextId.
            const decoded = yield* decodeSessionPermissionRespondInput(request)
            return yield* hostPermissionRespondChannel.binding.call({
              contextId: sessionId,
              permissionRequestId: decoded.permissionRequestId,
              decision: decoded.decision,
              ...(decoded.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: decoded.idempotencyKey }),
            }).pipe(Effect.mapError(cause =>
              new AppendError({ contextId: sessionId, cause })))
          })
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
          // firegrid-session-fact-client-surfaces.CLIENT_SESSION.6
          whenReady: withClientSpan("firegrid.client.session.when_ready", {
            "firegrid.session.id": sessionId,
            "firegrid.context.id": sessionId,
            "firegrid.wait.bucket": "projection",
          }, waitUntilContextReady(sessionId)),
          prompt: request =>
            withClientSpan("firegrid.client.session.prompt", {
              "firegrid.session.id": sessionId,
            }, Effect.gen(function* () {
              const decoded = yield* decodeSessionHandlePromptInput(request)
              yield* Effect.annotateCurrentSpan({
                "firegrid.context.id": sessionId,
                "firegrid.input.idempotency_key": decoded.idempotencyKey ?? "",
              })
              return yield* appendRuntimeInputIntent({
                contextId: sessionId,
                kind: "message",
                authoredBy: "client",
                payload: decoded.payload,
                idempotencyKey: decoded.idempotencyKey,
                ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }),
              })
            })),
          start: () =>
            withClientSpan("firegrid.client.session.start", {
              "firegrid.session.id": sessionId,
              "firegrid.context.id": sessionId,
            }, hostSessionsStartChannel.binding.call({ sessionId }).pipe(
              Effect.mapError(cause => new AppendError({ contextId: sessionId, cause })),
            )),
          snapshot: () => readSnapshot(sessionId),
          wait: waitClient,
          permissions: permissionsClient,
        }
      })

    const createOrLoadSession = (
      request: SessionCreateOrLoadInput,
    ): Effect.Effect<
      FiregridSessionHandle,
      LaunchInputError | AppendError
    > =>
      withClientSpan("firegrid.client.session.create_or_load", {
        "firegrid.external_key.source": request.externalKey.source,
        "firegrid.external_key.id": request.externalKey.id,
      }, Effect.gen(function* () {
        const decoded = yield* decodeSessionCreateOrLoadInput(request)
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
        }).pipe(Effect.mapError(cause =>
          new AppendError({
            contextId: sessionContextIdForExternalKey(decoded.externalKey),
            cause,
          })))
        yield* Effect.annotateCurrentSpan({
          "firegrid.context.id": response.contextId,
          "firegrid.runtime.agent": runtime.config.agent ?? "",
          "firegrid.runtime.agent_protocol": runtime.config.agentProtocol ?? "",
          "firegrid.runtime_context_mcp.enabled": runtime.config.runtimeContextMcp?.enabled === true,
          "firegrid.channel.target": "host.sessions.create_or_load",
          "firegrid.channel.direction": "call",
        })
        return yield* makeSessionHandle(response.contextId)
      }))

    const attachSession = (
      request: SessionAttachInput,
    ): Effect.Effect<FiregridSessionHandle, LaunchInputError> =>
      // firegrid-session-fact-client-surfaces.CLIENT_SESSION.1
      // firegrid-session-fact-client-surfaces.SESSION_IDENTITY.3
      Effect.flatMap(decodeSessionAttachInput(request), decoded =>
        makeSessionHandle(decoded.sessionId))

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
        return yield* appendRuntimeInputIntent(promptToRuntimeIngressRequest(decoded))
      }),
      sessions: {
        attach: attachSession,
        createOrLoad: createOrLoadSession,
        prompt: request => withClientSpan("firegrid.client.session.prompt", {
          "firegrid.session.id": request.sessionId,
        }, Effect.gen(function* () {
          const decoded = yield* decodeSessionPromptInput(request)
          yield* Effect.annotateCurrentSpan({
            "firegrid.context.id": decoded.sessionId,
            "firegrid.input.id": decoded.inputId ?? "",
          })
          const intent = yield* appendRuntimeInputIntent({
            inputId: decoded.inputId,
            contextId: decoded.sessionId,
            kind: "message",
            authoredBy: "client",
            payload: decoded.prompt,
            ...(decoded.inputId === undefined ? {} : { idempotencyKey: decoded.inputId }),
            ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }),
          })
          return {
            appended: true,
            sessionId: decoded.sessionId,
            inputId: intent.intentId,
          }
        })),
      },
      permissions: {
        respond: request => Effect.gen(function* () {
          // tf-aago: dispatch through HostPermissionRespondChannel (callable,
          // host-scoped — contextId travels in the request).
          const decoded = yield* decodePermissionRespondInput(request)
          return yield* hostPermissionRespondChannel.binding.call({
            contextId: decoded.contextId,
            permissionRequestId: decoded.permissionRequestId,
            decision: decoded.decision,
            ...(decoded.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: decoded.idempotencyKey }),
          }).pipe(Effect.mapError(cause =>
            new AppendError({ contextId: decoded.contextId, cause })))
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

const firegridServiceLayer = Layer.scoped(
  Firegrid,
  Effect.flatMap(FiregridConfig, (cfg) =>
    Effect.flatMap(resolveConfig(cfg), make)),
)

/**
 * The Firegrid client service layer.
 *
 * Requires from scope:
 *   - `RuntimeControlPlaneTable` (shared with the runtime host layer
 *     so durable context/start requests and runtime projections share
 *     one materialized RuntimeContext index)
 *   - the protocol-owned channel Tags the rewired methods dispatch
 *     through (createOrLoad / contexts.create / sessions.start /
 *     permissions.respond), provided below by the client-sdk
 *     standalone-default Layers. Production hosts may override by
 *     providing the host-sdk-owned channel Live Layers upstream.
 *
 * Standalone consumers can fall back to `FiregridControlPlaneTableLive`
 * for the table Tag.
 */
export const FiregridLive = firegridServiceLayer.pipe(
  Layer.provide(HostSessionsCreateOrLoadChannelStandaloneLive),
  Layer.provide(HostControlChannelsStandaloneLive),
)

/**
 * Standalone wiring: FiregridLive plus its own control-plane layer.
 * Suitable for clients that do not also run a runtime host in process
 * (e.g. a scenario that reads durable state through the snapshot
 * surface only).
 */
export const FiregridStandaloneLive = FiregridLive.pipe(
  Layer.provide(FiregridControlPlaneTableLive),
)
