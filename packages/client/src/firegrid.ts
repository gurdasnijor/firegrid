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
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  hostOwnedStreamUrl,
  insertLocalRuntimeContext,
  local,
  runtimeControlPlaneStreamUrl,
  type CurrentHostSession,
  type PublicLaunchRequest,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  promptToRuntimeIngressRequest,
  PublicPromptRequestSchema,
  type PublicPromptRequest,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import type { DurableTableHeaders } from "@firegrid/protocol"
import { Clock, Context, Data, Effect, Layer, Option, Schema, Stream } from "effect"

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
 * Build the host-owned RuntimeIngressTable layer for a specific
 * context. The host stream prefix is read off the context row by the
 * caller; this helper only wraps the per-call layer construction so
 * the URL is never composed at scenario sites.
 *
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
 */
const ingressLayerForContext = (
  config: ResolvedConfig,
  context: RuntimeContext,
) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: config.baseUrl,
        prefix: context.host.streamPrefix,
        segment: "runtimeIngress",
      }),
      contentType: config.contentType,
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    },
    txTimeoutMs: config.txTimeoutMs,
  })

/**
 * Build the host-owned RuntimeOutputTable layer for a specific
 * context. Read paths (`snapshot`) acquire and release this table
 * per call; preload cost is paid per snapshot.
 *
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
 */
const outputLayerForContext = (
  config: ResolvedConfig,
  context: RuntimeContext,
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: config.baseUrl,
        prefix: context.host.streamPrefix,
        segment: "runtimeOutput",
      }),
      contentType: config.contentType,
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    },
    txTimeoutMs: config.txTimeoutMs,
  })

const decodePublicLaunchRequest = (
  request: PublicLaunchRequest,
): Effect.Effect<PublicLaunchRequest, LaunchInputError> =>
  Schema.decodeUnknown(PublicLaunchRequestSchema, { onExcessProperty: "error" })(request).pipe(
    Effect.mapError(cause => new LaunchInputError({ cause })),
  )

const decodePublicPromptRequest = (
  request: PublicPromptRequest,
): Effect.Effect<PublicPromptRequest, PromptInputError> =>
  Schema.decodeUnknown(PublicPromptRequestSchema, { onExcessProperty: "error" })(request).pipe(
    Effect.mapError(cause => new LaunchInputError({ cause })),
  )

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
          const nextSequence = yield* ingress.inputs.query((coll) =>
            coll.toArray
              .filter(candidate => candidate.contextId === row.contextId)
              .reduce(
                (max, candidate) =>
                  candidate.sequence === undefined
                    ? max
                    : Math.max(max, candidate.sequence + 1),
                0,
              ),
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

