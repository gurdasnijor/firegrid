import type { ServeError } from "@effect/platform/HttpServerError"
import {
  ApprovalCallOutputSchema,
  ApprovalCallRequestSchema,
} from "@firegrid/protocol/agent-tools"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import { type BidirectionalChannel, type CallableChannel, type ChannelRegistration, type EgressChannel, type HumanMessage, type HumanMessageSchema, type IngressChannel, eventChannelTarget, makeBidirectionalChannel, makeCallableChannel, makeIngressChannel } from "@firegrid/protocol/channels"
import { dmChannel, notificationChannel } from "@firegrid/protocol/channels/human"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { RuntimeContextChannelRouterLive } from "@firegrid/runtime/channels/router/live"
import { type FiregridHost, FiregridRuntimeHostLive } from "@firegrid/runtime/composition/host-live"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/producers/sandbox"
import { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

const darkFactorySource = "linear.oauth"
const darkFactoryFactSource = "darkFactory.facts"
const factoryEventsChannelTarget = "factory.events"
const planReadyEventChannelTarget = eventChannelTarget("plan.ready")
const dmOperatorChannelTarget = "dm.operator"
const repoHint = "gurdasnijor/firegrid"

const DarkFactoryFactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  contextId: Schema.optional(Schema.String),
  correlationId: Schema.String,
  stage: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  parentFactId: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

type DarkFactoryFactRow = Schema.Schema.Type<typeof DarkFactoryFactRowSchema>

const PlanReadyEventRowSchema = Schema.Struct({
  eventId: Schema.String.pipe(DurableTable.primaryKey),
  name: Schema.Literal("plan.ready"),
  payload: Schema.Unknown,
  contextId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
  createdAt: Schema.String,
})

const OperatorMessageRowSchema = Schema.Struct({
  messageId: Schema.String.pipe(DurableTable.primaryKey),
  handle: Schema.String,
  body: Schema.String,
  payload: Schema.optional(Schema.Unknown),
  createdAt: Schema.String,
})

const DarkFactoryTableSchemas = {
  facts: DarkFactoryFactRowSchema,
  operatorMessages: OperatorMessageRowSchema,
  operatorNotifications: OperatorMessageRowSchema,
  planReadyEvents: PlanReadyEventRowSchema,
} as const

type DarkFactoryFactTableService = DurableTableService<typeof DarkFactoryTableSchemas>

class DarkFactoryFactTable extends DurableTable("darkFactory", DarkFactoryTableSchemas) {}

class FactoryEventsChannel extends Context.Tag(
  "dark-factory/events",
)<FactoryEventsChannel, IngressChannel<typeof DarkFactoryFactRowSchema>>() {}

class PlanReadyEventChannel extends Context.Tag(
  "dark-factory/plan-ready",
)<PlanReadyEventChannel, BidirectionalChannel<typeof PlanReadyEventRowSchema>>() {}

class DmOperatorIngressChannel extends Context.Tag(
  "dark-factory/dm-operator-ingress",
)<DmOperatorIngressChannel, IngressChannel<typeof HumanMessageSchema>>() {}

class NotificationOperatorEgressChannel extends Context.Tag(
  "dark-factory/notification-operator-egress",
)<NotificationOperatorEgressChannel, EgressChannel<typeof HumanMessageSchema>>() {}

class ApprovalOperatorChannel extends Context.Tag(
  "dark-factory/approval-operator",
)<
  ApprovalOperatorChannel,
  CallableChannel<typeof ApprovalCallRequestSchema, typeof ApprovalCallOutputSchema>
>() {}

const darkFactoryFactTableLayerOptions = (options: {
  readonly baseUrl: string
  readonly namespace: string
}): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(options.baseUrl, `${options.namespace}.darkFactory`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const darkFactoryEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    lookupEnv: name => env[name],
  })

const makeFactoryRunKey = (env: TinyFiregridHostEnv): string =>
  `${darkFactorySource}:issue-${env.runId}`

const makeTriggerFact = (
  env: TinyFiregridHostEnv,
  factoryRunKey: string,
): DarkFactoryFactRow => {
  const externalEntityKey = `issue-${env.runId}`
  return {
    factId: `${darkFactorySource}:${env.runId}:factory.trigger.accepted`,
    source: darkFactorySource,
    externalEventKey: `trigger-${env.runId}`,
    externalEntityKey,
    eventType: "factory.trigger.accepted",
    correlationId: factoryRunKey,
    stage: "trigger",
    status: "accepted",
    acceptedAt: new Date().toISOString(),
    payload: {
      delivery: "tiny-firegrid.simulate",
      linearIssueId: externalEntityKey,
      linearIdentifier: "TF-SIM-1",
      title: "Dark Factory tiny-firegrid choreography simulation",
      url: "https://linear.example/tiny-firegrid/TF-SIM-1",
      description:
        "Exercise factory-vision section 6 through Firegrid agent tools. The planner owns sequencing and must report public-surface gaps instead of relying on app orchestration.",
      repoHint,
    },
  }
}

const seedTriggerFactLayer = (
  env: TinyFiregridHostEnv,
  facts: Layer.Layer<DarkFactoryFactTable, DurableTableError>,
) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const table = yield* DarkFactoryFactTable
      yield* table.facts.insertOrGet(
        makeTriggerFact(env, makeFactoryRunKey(env)),
      )
    }),
  ).pipe(Layer.provide(facts))

const darkFactoryTableEffect = <A>(
  facts: Layer.Layer<DarkFactoryFactTable, DurableTableError>,
  f: (table: DarkFactoryFactTableService) => A,
): Effect.Effect<A, DurableTableError> =>
  Effect.provide(
    Effect.map(DarkFactoryFactTable, f),
    facts,
  ) as Effect.Effect<A, DurableTableError>

const rowsFromDarkFactoryTable = <A>(
  facts: Layer.Layer<DarkFactoryFactTable, DurableTableError>,
  f: (table: DarkFactoryFactTableService) => Stream.Stream<A, DurableTableError>,
): Stream.Stream<A, DurableTableError, never> =>
  Stream.unwrap(darkFactoryTableEffect(facts, f))

const humanMessageFromRow = (
  row: Schema.Schema.Type<typeof OperatorMessageRowSchema>,
): HumanMessage =>
  row.payload === undefined
    ? { handle: row.handle, body: row.body }
    : { handle: row.handle, body: row.body, payload: row.payload }

const operatorMessageRowFromPayload = (
  prefix: string,
  payload: HumanMessage,
): Schema.Schema.Type<typeof OperatorMessageRowSchema> =>
  payload.payload === undefined
    ? {
      messageId: `${prefix}:${crypto.randomUUID()}`,
      handle: payload.handle,
      body: payload.body,
      createdAt: new Date().toISOString(),
    }
    : {
      messageId: `${prefix}:${crypto.randomUUID()}`,
      handle: payload.handle,
      body: payload.body,
      payload: payload.payload,
      createdAt: new Date().toISOString(),
    }

interface DarkFactoryChannels {
  readonly factoryEvents: IngressChannel<typeof DarkFactoryFactRowSchema>
  readonly planReady: BidirectionalChannel<typeof PlanReadyEventRowSchema>
  readonly dmOperator: IngressChannel<typeof HumanMessageSchema>
  readonly notificationOperator: EgressChannel<typeof HumanMessageSchema>
  readonly approvalOperator: CallableChannel<
    typeof ApprovalCallRequestSchema,
    typeof ApprovalCallOutputSchema
  >
}

const makeDarkFactoryChannels = (
  facts: Layer.Layer<DarkFactoryFactTable, DurableTableError>,
): DarkFactoryChannels => {
  const factoryEvents = makeIngressChannel({
    target: factoryEventsChannelTarget,
    schema: DarkFactoryFactRowSchema,
    sourceClass: "static-source",
    stream: rowsFromDarkFactoryTable(facts, table => table.facts.rows()),
  })
  const planReady = makeBidirectionalChannel({
    target: planReadyEventChannelTarget,
    schema: PlanReadyEventRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: rowsFromDarkFactoryTable(
      facts,
      table => table.planReadyEvents.rows(),
    ),
    append: row =>
      darkFactoryTableEffect(
        facts,
        table => table.planReadyEvents.insert(row),
      ).pipe(Effect.flatten),
  })
  const dmOperatorPair = dmChannel({
    handle: "operator",
    incoming: rowsFromDarkFactoryTable(
      facts,
      table =>
        table.operatorMessages.rows().pipe(
          Stream.filter(row => row.handle === "operator"),
          Stream.map(humanMessageFromRow),
        ),
    ),
    send: payload =>
      darkFactoryTableEffect(
        facts,
        table =>
          table.operatorMessages.insert(
            operatorMessageRowFromPayload("dm.operator", payload),
          ),
      ).pipe(Effect.flatten),
  })
  const notificationOperatorPair = notificationChannel({
    handle: "operator",
    incoming: Stream.empty,
    send: payload =>
      darkFactoryTableEffect(
        facts,
        table =>
          table.operatorNotifications.insert(
            operatorMessageRowFromPayload("notification.operator", payload),
          ),
      ).pipe(Effect.flatten),
  })
  const approvalOperator = makeCallableChannel({
    target: "approval.operator",
    requestSchema: ApprovalCallRequestSchema,
    responseSchema: ApprovalCallOutputSchema,
    call: () => Effect.succeed({ matched: false, timedOut: true } as const),
  })
  return {
    factoryEvents,
    planReady,
    dmOperator: dmOperatorPair.ingress,
    notificationOperator: notificationOperatorPair.egress,
    approvalOperator,
  }
}

const darkFactoryChannelRegistrations = (
  channels: DarkFactoryChannels,
): ReadonlyArray<ChannelRegistration> => [
  channels.factoryEvents,
  channels.planReady,
  channels.dmOperator,
  channels.notificationOperator,
  channels.approvalOperator,
]

const darkFactoryChannelTagsLive = (
  channels: DarkFactoryChannels,
): Layer.Layer<
  | FactoryEventsChannel
  | PlanReadyEventChannel
  | DmOperatorIngressChannel
  | NotificationOperatorEgressChannel
  | ApprovalOperatorChannel
> =>
  Layer.mergeAll(
    Layer.succeed(FactoryEventsChannel, channels.factoryEvents),
    Layer.succeed(PlanReadyEventChannel, channels.planReady),
    Layer.succeed(DmOperatorIngressChannel, channels.dmOperator),
    Layer.succeed(NotificationOperatorEgressChannel, channels.notificationOperator),
    Layer.succeed(ApprovalOperatorChannel, channels.approvalOperator),
  )

const darkFactoryChannelsLive = (
  channels: DarkFactoryChannels,
): Layer.Layer<
  | FactoryEventsChannel
  | PlanReadyEventChannel
  | DmOperatorIngressChannel
  | NotificationOperatorEgressChannel
  | ApprovalOperatorChannel
> =>
  Layer.mergeAll(
    RuntimeContextChannelRouterLive(darkFactoryChannelRegistrations(channels)),
    darkFactoryChannelTagsLive(channels),
  )

export const darkFactoryHost = (
  env: TinyFiregridHostEnv,
  options?: {
    readonly toolProfile?: "full" | "primitive"
  },
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  // Substrate-driven early stop belongs here by yielding env.stopSignal.complete,
  // not in the client-surface driver. Dark-factory leaves that to a follow-up.
  const hostId = "host-a"
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"
  const facts = DarkFactoryFactTable.layer(
    darkFactoryFactTableLayerOptions({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    }),
  ) as Layer.Layer<DarkFactoryFactTable, DurableTableError>
  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(DarkFactoryFactTable, table => ({
      streamFor: (stream: string) => {
        if (stream === darkFactoryFactSource || stream === factoryEventsChannelTarget) {
          return table.facts.rows()
        }
        if (stream === planReadyEventChannelTarget) {
          return table.planReadyEvents.rows()
        }
        if (stream === dmOperatorChannelTarget) {
          return table.operatorMessages.rows().pipe(
            Stream.filter(row => row.handle === "operator"),
            Stream.map(humanMessageFromRow),
          )
        }
        return Stream.empty
      },
    })),
  ).pipe(Layer.provide(facts))
  const seedTriggerFact = seedTriggerFactLayer(env, facts)
  const appFacts = Layer.mergeAll(facts, callerFacts, seedTriggerFact)
  const channels = makeDarkFactoryChannels(facts)
  const channelsLive = darkFactoryChannelsLive(channels)
  const host = FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      hostId,
      hostSessionId: `${hostId}-session`,
      input: true,
      mcpChannels: darkFactoryChannelRegistrations(channels),
    },
    darkFactoryEnvPolicy(env.processEnv),
  ).pipe(
    Layer.provideMerge(appFacts),
    Layer.provideMerge(channelsLive),
  )

  // firegrid-observability.TINY_FIREGRID_SIMULATIONS.8
  // Public host factories infer an internal layer surface wider than FiregridHost.
  return Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: 0,
      path: ensurePathInput(mcpPath),
      ...(options?.toolProfile === undefined ? {} : { toolProfile: options.toolProfile }),
    }),
  ).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
    Layer.provideMerge(channelsLive),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}
