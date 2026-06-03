import {
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
} from "@firegrid/protocol/channels"
import {
  durableStreamUrl,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeEventsForContextView,
  runtimeContextsView,
} from "@firegrid/protocol/launch"
import {
  RuntimeAgentOutputObservationSchema,
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/protocol/session-facade"
import { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
import {
  ContextResolverTag,
  defaultProductionAdapterLayer,
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntime,
  ToolDispatchLive,
} from "@firegrid/runtime/unified"
import {
  HostPlaneSessionControlRouterLive,
  makeRuntimeChannelRouter,
  RuntimeChannelRouter,
  runtimeRouteFromChannel,
  sessionAgentOutputObservationRoute,
} from "@firegrid/runtime/channels"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import { AcpContextRows } from "@firegrid/runtime/sources/codecs/acp/stdio-edge"
import { DurableTable } from "effect-durable-operators"
import { Effect, Layer, Schema, Stream } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const mcpHost = "127.0.0.1"
const mcpPort = 43792
const mcpPath = "/mcp"
const darkFactoryFactChannel = "darkFactory.facts"
const source = "linear.oauth"
const repoHint = "gurdasnijor/firegrid"

const DarkFactoryFactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  stage: Schema.String,
  status: Schema.String,
  payloadJson: Schema.String,
  acceptedAt: Schema.String,
})

type DarkFactoryFactRow = typeof DarkFactoryFactRowSchema.Type

class DarkFactoryFactTable extends DurableTable("tiny.firegrid.darkFactory", {
  facts: DarkFactoryFactRowSchema,
}) {}

const factPayload = (
  env: TinyFiregridHostEnv,
  receivedAt: string,
) => ({
  delivery: {
    source,
    receivedAt,
    runId: env.runId,
  },
  linear: {
    id: `issue-${env.runId}`,
    identifier: "FG-CAPSTONE",
    title: "Factory capstone trigger",
    url: `https://linear.app/firegrid/issue/FG-CAPSTONE/${env.runId}`,
    description:
      "External trigger requests a planned, approved, delegated, reviewed, merge-signoff action over public Firegrid tools.",
  },
  repoHint,
})

const triggerFact = (env: TinyFiregridHostEnv): DarkFactoryFactRow => {
  const acceptedAt = env.runId
  return {
    factId: `${darkFactoryFactChannel}:${env.runId}:factory.trigger.accepted`,
    source,
    externalEventKey: `trigger-${env.runId}`,
    externalEntityKey: `issue-${env.runId}`,
    eventType: "factory.trigger.accepted",
    correlationId: `${darkFactoryFactChannel}:issue-${env.runId}`,
    stage: "trigger",
    status: "accepted",
    payloadJson: JSON.stringify(factPayload(env, acceptedAt)),
    acceptedAt,
  }
}

const darkFactoryFactTableLayer = (
  env: TinyFiregridHostEnv,
) =>
  DarkFactoryFactTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        env.durableStreamsBaseUrl,
        `${env.namespace}.tiny-firegrid.dark-factory.facts`,
      ),
      contentType: "application/json",
    },
  })

const darkFactoryFactRows = (
  table: DarkFactoryFactTable["Type"],
): Stream.Stream<DarkFactoryFactRow, unknown, never> =>
  table.facts.rows().pipe(
    Stream.withSpan("tiny_firegrid.factory_capstone.dark_factory_facts", {
      kind: "internal",
    }),
  )

const DarkFactoryCallerOwnedFactStreamsLive = Layer.effect(
  CallerOwnedFactStreams,
  Effect.gen(function*() {
    const table = yield* DarkFactoryFactTable
    return CallerOwnedFactStreams.of({
      streamFor: stream =>
        stream === darkFactoryFactChannel
          ? darkFactoryFactRows(table)
          : Stream.empty,
    })
  }),
)

const RuntimeChannelRouterLive = Layer.effect(
  RuntimeChannelRouter,
  Effect.gen(function*() {
    const table = yield* DarkFactoryFactTable
    const sessionAgentOutput = yield* SessionAgentOutputChannel
    return makeRuntimeChannelRouter([
      runtimeRouteFromChannel(
        makeIngressChannel({
          target: darkFactoryFactChannel,
          schema: DarkFactoryFactRowSchema,
          sourceClass: "static-source",
          stream: darkFactoryFactRows(table),
        }),
      ),
      sessionAgentOutputObservationRoute(sessionAgentOutput),
    ])
  }),
)

const GlobalSessionAgentOutputChannelLive = Layer.effect(
  SessionAgentOutputChannel,
  RuntimeOutputTable.pipe(
    Effect.map(output =>
      SessionAgentOutputChannel.of({
        forContext: contextId =>
          makeIngressChannel({
            target: SessionAgentOutputChannelTarget,
            schema: RuntimeAgentOutputObservationSchema,
            sourceClass: "static-source",
            stream: runtimeEventsForContextView(output.events.rows(), contextId).pipe(
              Stream.filterMap(runtimeAgentOutputObservationFromRow),
            ),
          }),
      })),
  ),
)

const GlobalAcpContextRowsLive = Layer.effect(
  AcpContextRows,
  RuntimeControlPlaneTable.pipe(
    Effect.map(control => runtimeContextsView(control.contexts.rows())),
  ),
)

const contextResolverFromControlPlaneTable = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId: string) => control.contexts.get(contextId),
    }
  }),
)

const seedTriggerFactLayer = (env: TinyFiregridHostEnv) =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* DarkFactoryFactTable
      const fact = triggerFact(env)
      yield* table.facts.insertOrGet(fact).pipe(Effect.orDie)
      yield* Effect.annotateCurrentSpan({
        "firegrid.factory_capstone.trigger_fact_id": fact.factId,
        "firegrid.factory_capstone.trigger_channel": darkFactoryFactChannel,
        "firegrid.factory_capstone.trigger_event_type": fact.eventType,
      })
    }).pipe(
      Effect.withSpan("tiny_firegrid.factory_capstone.seed_trigger_fact", {
        kind: "internal",
      }),
    ),
  )

export const factoryCapstoneHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const host = FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
        lookupEnv: name => env.processEnv[name],
      }),
    ),
  )
  const appFactTable = darkFactoryFactTableLayer(env)
  const appRuntimeRoutes = RuntimeChannelRouterLive.pipe(
    Layer.provideMerge(GlobalSessionAgentOutputChannelLive),
  )
  const appFacts = DarkFactoryCallerOwnedFactStreamsLive.pipe(
    Layer.merge(appRuntimeRoutes),
    Layer.merge(seedTriggerFactLayer(env)),
    Layer.provideMerge(appFactTable),
  )
  const toolDispatch = ToolDispatchLive.pipe(
    Layer.provideMerge(appFacts),
    Layer.provideMerge(contextResolverFromControlPlaneTable),
    Layer.provideMerge(HostPlaneSessionControlRouterLive),
  )
  const mcp = FiregridMcpServerLayer({
    host: mcpHost,
    port: mcpPort,
    path: ensurePathInput(mcpPath),
  }).pipe(
    Layer.provideMerge(contextResolverFromControlPlaneTable),
    Layer.provideMerge(toolDispatch),
    Layer.discard,
  )
  const services = mcp.pipe(
    Layer.merge(GlobalAcpContextRowsLive),
    Layer.provideMerge(host),
  )
  return services
}
