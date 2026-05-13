import {
  PublicLaunchRequestSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  local,
  normalizeRuntimeIntent,
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
import { Context, Data, Effect, Layer, Option, Schema } from "effect"

export interface ClientOptions {
  readonly durableStreamsBaseUrl?: string
  readonly namespace?: string
  readonly runtimeStreamUrl?: string
  readonly controlPlaneStreamUrl?: string
  readonly dataPlaneStreamUrl?: string
  readonly inputStreamUrl?: string
  readonly contentType?: string
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

export type FiregridError = PreloadError | LaunchInputError | AppendError | FiregridConfigError

export interface RuntimeContextSnapshot {
  readonly contextId: string
  readonly context?: RuntimeContext
  readonly status?: RuntimeRunEventRow["status"]
  readonly runs: ReadonlyArray<RuntimeRunEventRow>
  readonly events: ReadonlyArray<RuntimeEventRow>
  readonly logs: ReadonlyArray<RuntimeLogLineRow>
}

export interface RuntimeContextHandle {
  readonly contextId: string
  readonly snapshot: Effect.Effect<RuntimeContextSnapshot, PreloadError>
}

export interface FiregridService {
  readonly launch: (request: PublicLaunchRequest) => Effect.Effect<RuntimeContextHandle, LaunchInputError | AppendError>
  readonly prompt: (
    request: PublicPromptRequest,
  ) => Effect.Effect<RuntimeIngressInputRow, PromptInputError | AppendError>
  readonly open: (contextId: string) => RuntimeContextHandle
}

export class Firegrid extends Context.Tag("@firegrid/client/Firegrid")<
  Firegrid,
  FiregridService
>() {}

export { local }

const latestStatus = (
  events: ReadonlyArray<RuntimeRunEventRow>,
): RuntimeRunEventRow["status"] | undefined =>
  [...events].sort((left, right) => left.at.localeCompare(right.at)).at(-1)?.status

const compareJournalRows = (
  left: { readonly activityAttempt: number; readonly sequence: number },
  right: { readonly activityAttempt: number; readonly sequence: number },
): number =>
  left.activityAttempt - right.activityAttempt || left.sequence - right.sequence

const makeContextId = (): string => `ctx_${crypto.randomUUID()}`

interface FiregridClientDurableTopology {
  readonly runtimeControlPlaneTableUrl: string
  readonly runtimeIngressTableUrl: string
  readonly runtimeOutputTableUrl: string
}

const trimRightSlash = (value: string): string => value.replace(/\/+$/, "")

const encodeStreamName = (namespace: string, name: string): string =>
  encodeURIComponent(`${namespace}.${name}`)

const topologyFromConfig = (
  cfg: ClientOptions,
): FiregridClientDurableTopology | undefined => {
  if (cfg.durableStreamsBaseUrl === undefined || cfg.namespace === undefined) return undefined
  const baseUrl = trimRightSlash(cfg.durableStreamsBaseUrl)
  const namespace = cfg.namespace
  const streamUrl = (name: string): string =>
    `${baseUrl}/v1/stream/${encodeStreamName(namespace, name)}`
  return {
    // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.12
    runtimeControlPlaneTableUrl: streamUrl("firegrid.runtime"),
    // firegrid-agent-ingress.HOST.7
    runtimeIngressTableUrl: streamUrl("firegrid.runtimeIngress"),
    runtimeOutputTableUrl: streamUrl("firegrid.runtimeOutput"),
  }
}

const requiredControlPlaneStreamUrl = (
  cfg: ClientOptions,
  topology: FiregridClientDurableTopology | undefined,
): Effect.Effect<string, FiregridConfigError> => {
  const url = cfg.controlPlaneStreamUrl ?? cfg.runtimeStreamUrl ?? topology?.runtimeControlPlaneTableUrl
  if (url === undefined) {
    return Effect.fail(new FiregridConfigError({
      cause: new Error("FiregridConfig requires durableStreamsBaseUrl + namespace or a runtime/control-plane stream URL"),
    }))
  }
  return Effect.succeed(url)
}

const normalizeLaunch = (request: PublicLaunchRequest): RuntimeContext => ({
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.3
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7
  contextId: makeContextId(),
  createdAt: new Date().toISOString(),
  ...(request.requestedBy === undefined ? {} : { createdBy: request.requestedBy }),
  runtime: normalizeRuntimeIntent(request.runtime),
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
  control: {
    readonly context?: RuntimeContext
    readonly runs: ReadonlyArray<RuntimeRunEventRow>
  },
  output: {
    readonly events: ReadonlyArray<RuntimeEventRow>
    readonly logs: ReadonlyArray<RuntimeLogLineRow>
  },
): RuntimeContextSnapshot => {
  const events = output.events
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
  const logs = output.logs
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
  const runs = [...control.runs].sort((left, right) => left.at.localeCompare(right.at))
  const status = latestStatus(runs)
  return {
    contextId,
    ...(control.context === undefined ? {} : { context: control.context }),
    ...(status === undefined ? {} : { status }),
    runs,
    events,
    logs,
  }
}

const make = (
  cfg: ClientOptions,
  ingress: Option.Option<RuntimeIngressTable["Type"]>,
  output: Option.Option<RuntimeOutputTable["Type"]>,
) => Effect.gen(function* () {
  const control = yield* RuntimeControlPlaneTable

  const readOutput = (): Effect.Effect<{
    readonly events: ReadonlyArray<RuntimeEventRow>
    readonly logs: ReadonlyArray<RuntimeLogLineRow>
  }, PreloadError> =>
    Option.match(output, {
      onNone: () => Effect.succeed({ events: [], logs: [] }),
      onSome: table =>
        Effect.all({
          // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.7
          events: table.events.query(coll => coll.toArray),
          logs: table.logs.query(coll => coll.toArray),
        }).pipe(
          Effect.mapError(cause => new PreloadError({ cause })),
        ),
    })

  const appendContext = (context: RuntimeContext): Effect.Effect<void, AppendError> =>
    control.contexts.upsert(context).pipe(
      Effect.mapError(cause => new AppendError({ contextId: context.contextId, cause })),
    )

  const appendPrompt = (
    row: RuntimeIngressInputRow,
  ): Effect.Effect<RuntimeIngressInputRow, AppendError> => {
    if (Option.isNone(ingress)) {
      return Effect.fail(new AppendError({
        contextId: row.contextId,
        cause: new Error("runtime ingress table is not configured"),
      }))
    }
    return Effect.gen(function* () {
      const existing = yield* ingress.value.inputs.get(row.inputId)
      if (Option.isSome(existing)) return existing.value
      const nextSequence = yield* ingress.value.inputs.query((coll) =>
        coll.toArray
          .filter(candidate => candidate.contextId === row.contextId)
          .reduce(
            (max, candidate) =>
              candidate.sequence === undefined ? max : Math.max(max, candidate.sequence + 1),
            0,
          ),
      )
      const sequenced = {
        ...row,
        // firegrid-agent-ingress.INGRESS.9
        status: "sequenced" as const,
        sequence: nextSequence,
        sequencedAt: new Date().toISOString(),
      }
      yield* ingress.value.inputs.insert(sequenced)
      return sequenced
    }).pipe(
      Effect.mapError(cause => new AppendError({ contextId: row.contextId, cause })),
    )
  }

  const readSnapshot = (
    contextId: string,
  ): Effect.Effect<RuntimeContextSnapshot, PreloadError> =>
    Effect.gen(function* () {
      const runtimeOutput = yield* readOutput()
      const controlState = yield* Effect.gen(function* () {
          const context = yield* control.contexts.get(contextId).pipe(
            Effect.mapError(cause => new PreloadError({ cause })),
          )
          const runs = yield* control.runs.query((coll) =>
            coll.toArray.filter(row => row.contextId === contextId),
          )
          return { context, runs }
        }).pipe(
        Effect.mapError(cause => new PreloadError({ cause })),
      )
        return snapshotFromJournal(contextId, {
          ...(Option.isNone(controlState.context) ? {} : { context: controlState.context.value }),
          runs: controlState.runs,
        }, runtimeOutput)
    })

  const open = (contextId: string): RuntimeContextHandle => ({
    contextId,
    snapshot: readSnapshot(contextId),
  })

  return Firegrid.of({
    launch: request => Effect.gen(function* () {
      // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1
      // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6
      const decoded = yield* decodePublicLaunchRequest(request)
      const normalized = normalizeLaunch(decoded)
      yield* appendContext(normalized)
      return open(normalized.contextId)
    }),
    prompt: request => Effect.gen(function* () {
      // firegrid-agent-ingress.INGRESS.6
      const decoded = yield* decodePublicPromptRequest(request)
      const row = makeRuntimeIngressInputRow(promptToRuntimeIngressRequest(decoded))
      return yield* appendPrompt(row)
    }),
    open,
  })
})

const firegridServiceLayer = (
  cfg: ClientOptions,
  ingressConfigured: boolean,
  outputConfigured: boolean,
): Layer.Layer<Firegrid, never, RuntimeControlPlaneTable | RuntimeIngressTable | RuntimeOutputTable> => {
  const layer = Layer.scoped(
    Firegrid,
    Effect.gen(function* () {
      const ingress = ingressConfigured
        ? Option.some(yield* RuntimeIngressTable)
        : Option.none<RuntimeIngressTable["Type"]>()
      const output = outputConfigured
        ? Option.some(yield* RuntimeOutputTable)
        : Option.none<RuntimeOutputTable["Type"]>()
      return yield* make(cfg, ingress, output)
    }),
  )
  return layer as Layer.Layer<Firegrid, never, RuntimeControlPlaneTable | RuntimeIngressTable | RuntimeOutputTable>
}

const configuredFiregridLayer = (
  cfg: ClientOptions,
): Effect.Effect<Layer.Layer<Firegrid, unknown>, FiregridConfigError> =>
  Effect.gen(function* () {
  const topology = topologyFromConfig(cfg)
  const controlPlaneStreamUrl = yield* requiredControlPlaneStreamUrl(cfg, topology)
  const inputTableStreamUrl = cfg.inputStreamUrl ?? topology?.runtimeIngressTableUrl
  const outputTableStreamUrl = cfg.dataPlaneStreamUrl ?? topology?.runtimeOutputTableUrl
  const txTimeoutMs = cfg.txTimeoutMs ?? 2_000
  const controlLayer = RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: controlPlaneStreamUrl,
      contentType: cfg.contentType ?? "application/json",
    },
    txTimeoutMs,
  })
  const service = firegridServiceLayer(
    cfg,
    inputTableStreamUrl !== undefined,
    outputTableStreamUrl !== undefined,
  )
  let provided = service.pipe(Layer.provide(controlLayer))
  if (inputTableStreamUrl !== undefined) {
    provided = provided.pipe(
      Layer.provide(RuntimeIngressTable.layer({
        streamOptions: {
          url: inputTableStreamUrl,
          contentType: cfg.contentType ?? "application/json",
        },
        txTimeoutMs,
      })),
    )
  }
  if (outputTableStreamUrl !== undefined) {
    provided = provided.pipe(
      Layer.provide(RuntimeOutputTable.layer({
        streamOptions: {
          url: outputTableStreamUrl,
          contentType: cfg.contentType ?? "application/json",
        },
        txTimeoutMs,
      })),
    )
  }
  return provided
})

export const FiregridLive = Layer.unwrapEffect(
  Effect.flatMap(FiregridConfig, configuredFiregridLayer),
)
