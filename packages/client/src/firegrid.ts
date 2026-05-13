import { FetchHttpClient } from "@effect/platform"
import {
  PublicLaunchRequestSchema,
  RuntimeContextSchema,
  RuntimeJournalEventSchema,
  RuntimeControlPlaneTable,
  local,
  normalizeRuntimeIntent,
  type PublicLaunchRequest,
  type RuntimeContext,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeLogLine,
  type RuntimeRunEvent,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  promptToRuntimeIngressRequest,
  PublicPromptRequestSchema,
  type PublicPromptRequest,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Context, Data, Effect, Layer, Option, Schema, Stream } from "effect"
import { DurableStream } from "effect-durable-streams"
import { DurableTableError } from "effect-durable-operators"

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

export type PromptInputError = LaunchInputError

export type FiregridError = PreloadError | LaunchInputError | AppendError

export interface RuntimeContextSnapshot {
  readonly contextId: string
  readonly context?: RuntimeContext
  readonly status?: RuntimeRunEvent["status"]
  readonly runs: ReadonlyArray<RuntimeRunEvent>
  readonly events: ReadonlyArray<RuntimeEvent>
  readonly logs: ReadonlyArray<RuntimeLogLine>
}

export interface RuntimeContextHandle {
  readonly contextId: string
  readonly snapshot: Effect.Effect<RuntimeContextSnapshot, PreloadError>
  readonly changes: Stream.Stream<RuntimeContextSnapshot, PreloadError>
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
  events: ReadonlyArray<RuntimeRunEvent>,
): RuntimeRunEvent["status"] | undefined =>
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
  readonly runtimeOutputStreamUrl: string
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
    runtimeOutputStreamUrl: streamUrl("firegrid.runtimeOutput"),
  }
}

const requiredControlPlaneStreamUrl = (
  cfg: ClientOptions,
  topology: FiregridClientDurableTopology | undefined,
): Effect.Effect<string, DurableTableError> => {
  const url = cfg.controlPlaneStreamUrl ?? cfg.runtimeStreamUrl ?? topology?.runtimeControlPlaneTableUrl
  if (url === undefined) {
    return Effect.fail(new DurableTableError({
      table: "firegrid.runtime",
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
    readonly runs: ReadonlyArray<RuntimeRunEvent>
  },
  journal: ReadonlyArray<RuntimeJournalEvent>,
): RuntimeContextSnapshot => {
  const events = journal
    .flatMap(event => event.type === "firegrid.runtime.output.stdout" ? [event.event] : [])
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
  const logs = journal
    .flatMap(event => event.type === "firegrid.runtime.output.stderr" ? [event.log] : [])
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
) => Effect.gen(function* () {
  const control = yield* RuntimeControlPlaneTable
  const topology = topologyFromConfig(cfg)
  const dataPlaneStreamUrl = cfg.dataPlaneStreamUrl ?? topology?.runtimeOutputStreamUrl

  const readJournal = (): Effect.Effect<ReadonlyArray<RuntimeJournalEvent>, PreloadError> =>
    dataPlaneStreamUrl === undefined
      ? Effect.succeed([])
      // effect-native-production-cutover.CLIENT_APP.1
      : DurableStream.define({
        endpoint: { url: dataPlaneStreamUrl },
        schema: RuntimeJournalEventSchema,
      }).collect.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catchTag("DurableStream/NotFound", () => Effect.succeed([])),
        Effect.mapError(cause => new PreloadError({ cause })),
      )

  const appendContext = (context: RuntimeContext): Effect.Effect<void, AppendError> =>
    control.contexts.upsert(context).pipe(
      Effect.mapError(cause => new AppendError({ contextId: context.contextId, cause })),
    )

  const appendPrompt = (
    row: RuntimeIngressInputRow,
  ): Effect.Effect<void, AppendError> => {
    if (Option.isNone(ingress)) {
      return Effect.fail(new AppendError({
        contextId: row.contextId,
        cause: new Error("runtime ingress table is not configured"),
      }))
    }
    return ingress.value.inputs.insert(row).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.mapError(cause => new AppendError({ contextId: row.contextId, cause })),
    )
  }

  const readSnapshot = (
    contextId: string,
  ): Effect.Effect<RuntimeContextSnapshot, PreloadError> =>
    Effect.gen(function* () {
      const journal = yield* readJournal()
      const controlState = yield* Effect.gen(function* () {
          const context = yield* control.contexts.get(contextId).pipe(
            Effect.flatMap(Option.match({
              onNone: () => Effect.succeed(Option.none<RuntimeContext>()),
              onSome: row =>
                Schema.decodeUnknown(RuntimeContextSchema)(row).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(cause => new DurableTableError({
                    table: "firegrid.runtime.contexts",
                    cause,
                  })),
                ),
            })),
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
        }, journal)
    })

  const open = (contextId: string): RuntimeContextHandle => ({
    contextId,
    snapshot: readSnapshot(contextId),
    changes: Stream.fromEffect(readSnapshot(contextId)),
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
      yield* appendPrompt(row)
      return row
    }),
    open,
  })
})

const firegridServiceLayer = (
  cfg: ClientOptions,
  ingressConfigured: boolean,
): Layer.Layer<Firegrid, never, RuntimeControlPlaneTable | RuntimeIngressTable> => {
  const layer = ingressConfigured
    ? Layer.scoped(
      Firegrid,
      Effect.gen(function* () {
        const ingress = yield* RuntimeIngressTable
        return yield* make(cfg, Option.some(ingress))
      }),
    )
    : Layer.scoped(Firegrid, make(cfg, Option.none<RuntimeIngressTable["Type"]>()))
  return layer as Layer.Layer<Firegrid, never, RuntimeControlPlaneTable | RuntimeIngressTable>
}

const configuredFiregridLayer = (
  cfg: ClientOptions,
): Effect.Effect<Layer.Layer<Firegrid, DurableTableError>, DurableTableError> =>
  Effect.gen(function* () {
  const topology = topologyFromConfig(cfg)
  const controlPlaneStreamUrl = yield* requiredControlPlaneStreamUrl(cfg, topology)
  const inputTableStreamUrl = cfg.inputStreamUrl ?? topology?.runtimeIngressTableUrl
  const txTimeoutMs = cfg.txTimeoutMs ?? 2_000
  const controlLayer = RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: controlPlaneStreamUrl,
      contentType: cfg.contentType ?? "application/json",
    },
    txTimeoutMs,
  })
  const service = firegridServiceLayer(cfg, inputTableStreamUrl !== undefined)
  if (inputTableStreamUrl === undefined) {
    return service.pipe(Layer.provide(controlLayer))
  }
  return service.pipe(
    Layer.provide(RuntimeIngressTable.layer({
      streamOptions: {
        url: inputTableStreamUrl,
        contentType: cfg.contentType ?? "application/json",
      },
      txTimeoutMs,
    })),
    Layer.provide(controlLayer),
  )
})

export const FiregridLive = Layer.unwrapEffect(
  Effect.flatMap(FiregridConfig, configuredFiregridLayer),
)
