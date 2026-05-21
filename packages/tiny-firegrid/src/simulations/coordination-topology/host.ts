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
import { Effect, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const coordinationTopologyItemCount = 3
export const coordinationTopologyWorkerCount = 2

export const coordinationTopologyItemEventsTarget = "coordination.item_events"
export const coordinationTopologyWorkerActionTarget = "coordination.worker_action"
export const coordinationTopologyDispatchTarget = "coordination.dispatch"
export const coordinationTopologyClaimsTarget = "coordination.claims"
export const coordinationTopologyReportsTarget = "coordination.reports"
export const coordinationTopologyScoresTarget = "coordination.scores"

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

const CoordinationWorkerActionRequestSchema = Schema.Struct({
  runId: Schema.String,
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

const CoordinationClaimRowSchema = Schema.Struct({
  claimId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  arm: Schema.Literal("choreographed"),
  itemId: Schema.String,
  workerId: Schema.String,
  value: Schema.Number.pipe(Schema.int()),
  decision: Schema.Literal("claimed", "observed"),
  createdAt: Schema.String,
})

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

const CoordinationScoreRowSchema = Schema.Struct({
  scoreId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  arm: Schema.Literal("monolithic", "orchestrated", "choreographed"),
  itemCount: Schema.Number.pipe(Schema.int()),
  workerCount: Schema.Number.pipe(Schema.int()),
  dispatchCount: Schema.Number.pipe(Schema.int()),
  claimCount: Schema.Number.pipe(Schema.int()),
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
    claims: CoordinationClaimRowSchema,
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
  readonly claims: BidirectionalChannel<typeof CoordinationClaimRowSchema>
  readonly reports: BidirectionalChannel<typeof CoordinationReportRowSchema>
  readonly scores: BidirectionalChannel<typeof CoordinationScoreRowSchema>
}

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
  const claims = makeBidirectionalChannel({
    target: coordinationTopologyClaimsTarget,
    schema: CoordinationClaimRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: table.claims.rows(),
    append: row => table.claims.insertOrGet(row).pipe(Effect.asVoid),
  })
  const reports = makeBidirectionalChannel({
    target: coordinationTopologyReportsTarget,
    schema: CoordinationReportRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: table.reports.rows(),
    append: row => table.reports.insertOrGet(row).pipe(Effect.asVoid),
  })
  const scores = makeBidirectionalChannel({
    target: coordinationTopologyScoresTarget,
    schema: CoordinationScoreRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: table.scores.rows(),
    append: row => table.scores.insertOrGet(row).pipe(Effect.asVoid),
  })
  return { itemEvents, workerAction, dispatches, claims, reports, scores }
}

const channelRegistrations = (
  channels: CoordinationTopologyChannels,
): ReadonlyArray<ChannelRegistration> => [
  channels.itemEvents,
  channels.workerAction,
  channels.dispatches,
  channels.claims,
  channels.reports,
  channels.scores,
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
          if (stream === coordinationTopologyClaimsTarget) {
            return table.claims.rows()
          }
          if (stream === coordinationTopologyReportsTarget) {
            return table.reports.rows()
          }
          if (stream === coordinationTopologyScoresTarget) {
            return table.scores.rows()
          }
          return Stream.empty
        },
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
