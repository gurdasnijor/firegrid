import type { ServeError } from "@effect/platform/HttpServerError"
import {
  FiregridMcpServerLayer,
  FiregridRuntimeHostLive,
  RuntimeContextMcpChannelCatalogLive,
  RuntimeEnvResolverPolicy,
  durableStreamUrl,
  ensurePathInput,
  makeBidirectionalChannel,
  makeCallableChannel,
  type BidirectionalChannel,
  type CallableChannel,
  type ChannelRegistration,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const coordinationTopologyItemCount = 3
export const coordinationTopologyWorkerCount = 2
const coordinationTopologyItemEventsTarget = "coordination.item_events"
const coordinationTopologyWorkerActionTarget = "coordination.worker_action"
const coordinationTopologyDispatchTarget = "coordination.dispatch"
const coordinationTopologyReportsTarget = "coordination.reports"

export type CoordinationTopologyArm =
  | "monolithic"
  | "orchestrated"
  | "choreographed"

const CoordinationItemEventRowSchema = Schema.Struct({
  eventId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  arm: Schema.Literal("monolithic", "orchestrated", "choreographed"),
  itemId: Schema.String,
  value: Schema.Number.pipe(Schema.int()),
  producedBy: Schema.String,
  createdAt: Schema.String,
})
export type CoordinationItemEventRow = Schema.Schema.Type<
  typeof CoordinationItemEventRowSchema
>

const CoordinationWorkerActionRequestSchema = Schema.Struct({
  arm: Schema.Literal("monolithic", "orchestrated", "choreographed"),
  itemId: Schema.String,
  inputValue: Schema.Number.pipe(Schema.int()),
  workerId: Schema.String,
  participantId: Schema.String,
})
const CoordinationWorkerActionResponseSchema = Schema.Struct({
  itemId: Schema.String,
  resultValue: Schema.Number.pipe(Schema.int()),
})

const CoordinationDispatchRowSchema = Schema.Struct({
  dispatchId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  arm: Schema.Literal("orchestrated"),
  itemId: Schema.String,
  value: Schema.Number.pipe(Schema.int()),
  supervisorId: Schema.String,
  workerId: Schema.String,
  createdAt: Schema.String,
})
export type CoordinationDispatchRow = Schema.Schema.Type<
  typeof CoordinationDispatchRowSchema
>

const CoordinationReportRowSchema = Schema.Struct({
  reportId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  arm: Schema.Literal("monolithic", "orchestrated", "choreographed"),
  itemId: Schema.String,
  workerId: Schema.String,
  resultValue: Schema.Number.pipe(Schema.int()),
  path: Schema.Array(Schema.String),
  createdAt: Schema.String,
})
export type CoordinationReportRow = Schema.Schema.Type<
  typeof CoordinationReportRowSchema
>

const CoordinationScoreRowSchema = Schema.Struct({
  scoreId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  arm: Schema.Literal("monolithic", "orchestrated", "choreographed"),
  itemCount: Schema.Number.pipe(Schema.int()),
  workerCount: Schema.Number.pipe(Schema.int()),
  dispatchCount: Schema.Number.pipe(Schema.int()),
  reportCount: Schema.Number.pipe(Schema.int()),
  totalResultValue: Schema.Number.pipe(Schema.int()),
  topology: Schema.String,
})
export type CoordinationScoreRow = Schema.Schema.Type<
  typeof CoordinationScoreRowSchema
>

class CoordinationTopologyBenchTable extends DurableTable(
  "coordinationTopologyBench",
  {
    dispatches: CoordinationDispatchRowSchema,
    itemEvents: CoordinationItemEventRowSchema,
    reports: CoordinationReportRowSchema,
    scores: CoordinationScoreRowSchema,
  },
) {}

interface CoordinationTopologyChannels {
  readonly itemEvents: BidirectionalChannel<typeof CoordinationItemEventRowSchema>
  readonly workerAction: CallableChannel<
    typeof CoordinationWorkerActionRequestSchema,
    typeof CoordinationWorkerActionResponseSchema
  >
  readonly dispatches: BidirectionalChannel<typeof CoordinationDispatchRowSchema>
  readonly reports: BidirectionalChannel<typeof CoordinationReportRowSchema>
}

export interface CoordinationTopologyApi {
  readonly runId: string
  readonly channels: CoordinationTopologyChannels
  readonly writeScore: (
    row: CoordinationScoreRow,
  ) => Effect.Effect<void, unknown, never>
  readonly getScore: (
    scoreId: string,
  ) => Effect.Effect<CoordinationScoreRow, unknown, never>
}

const apiDeferred = Effect.runSync(
  Deferred.make<CoordinationTopologyApi>(),
)

export const awaitCoordinationTopologyApi = Deferred.await(apiDeferred)

const publishCoordinationTopologyApi = (
  api: CoordinationTopologyApi,
): Effect.Effect<void> =>
  Deferred.complete(apiDeferred, Effect.succeed(api)).pipe(Effect.asVoid)

const benchLayerOptions = (options: {
  readonly baseUrl: string
  readonly namespace: string
  readonly runId: string
}): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      options.baseUrl,
      `${options.namespace}.coordination-topology.${options.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const coordinationEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [],
    lookupEnv: name => env[name],
  })

const firstScore = (
  value: Option.Option<CoordinationScoreRow>,
  scoreId: string,
) =>
  Option.match(value, {
    onNone: () => Effect.fail(new Error(`score row not found: ${scoreId}`)),
    onSome: row => Effect.succeed(row),
  })

const makeChannels = (
  table: CoordinationTopologyBenchTable["Type"],
): CoordinationTopologyChannels => {
  const itemEvents = makeBidirectionalChannel({
    target: coordinationTopologyItemEventsTarget,
    schema: CoordinationItemEventRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: table.itemEvents.rows(),
    append: row => table.itemEvents.insertOrGet(row).pipe(Effect.asVoid),
  })
  const workerAction = makeCallableChannel({
    target: coordinationTopologyWorkerActionTarget,
    requestSchema: CoordinationWorkerActionRequestSchema,
    responseSchema: CoordinationWorkerActionResponseSchema,
    call: request =>
      Effect.succeed({
        itemId: request.itemId,
        resultValue: request.inputValue * 2,
      }),
  })
  const dispatches = makeBidirectionalChannel({
    target: coordinationTopologyDispatchTarget,
    schema: CoordinationDispatchRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: table.dispatches.rows(),
    append: row => table.dispatches.insertOrGet(row).pipe(Effect.asVoid),
  })
  const reports = makeBidirectionalChannel({
    target: coordinationTopologyReportsTarget,
    schema: CoordinationReportRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: table.reports.rows(),
    append: row => table.reports.insertOrGet(row).pipe(Effect.asVoid),
  })
  return { itemEvents, workerAction, dispatches, reports }
}

const channelRegistrations = (
  channels: CoordinationTopologyChannels,
): ReadonlyArray<ChannelRegistration> => [
  channels.itemEvents,
  channels.workerAction,
  channels.dispatches,
  channels.reports,
]

export const coordinationTopologyHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const hostId = "coordination-topology-host"
  const tableLayer = CoordinationTopologyBenchTable.layer(
    benchLayerOptions({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      runId: env.runId,
    }),
  )

  const host = Layer.unwrapEffect(
    Effect.gen(function*() {
      const table = yield* CoordinationTopologyBenchTable
      const channels = makeChannels(table)
      const registrations = channelRegistrations(channels)
      const callerFacts = Layer.succeed(CallerOwnedFactStreams, {
        streamFor: (stream: string) => {
          if (stream === coordinationTopologyItemEventsTarget) {
            return table.itemEvents.rows()
          }
          if (stream === coordinationTopologyDispatchTarget) {
            return table.dispatches.rows()
          }
          if (stream === coordinationTopologyReportsTarget) {
            return table.reports.rows()
          }
          return Stream.empty
        },
      })
      yield* publishCoordinationTopologyApi({
        runId: env.runId,
        channels,
        writeScore: row => table.scores.insertOrGet(row).pipe(Effect.asVoid),
        getScore: scoreId =>
          table.scores.get(scoreId).pipe(
            Effect.flatMap(score => firstScore(score, scoreId)),
          ),
      })

      return FiregridRuntimeHostLive(
        {
          durableStreamsBaseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
          hostId,
          hostSessionId: `${hostId}-session`,
          input: true,
          mcpChannels: registrations,
        },
        coordinationEnvPolicy(env.processEnv),
      ).pipe(
        Layer.provideMerge(callerFacts),
        Layer.provideMerge(RuntimeContextMcpChannelCatalogLive(registrations)),
      )
    }),
  ).pipe(Layer.provide(tableLayer))

  return Layer.discard(
    FiregridMcpServerLayer({
      host: "127.0.0.1",
      port: 0,
      path: ensurePathInput("/mcp"),
      toolProfile: "primitive",
    }),
  ).pipe(
    Layer.provideMerge(host),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}
