/**
 * factory-capstone host — composes through the single Firegrid host composition
 * root (tf-ll90.8.4). The `firegridHost(options)` core provides the MCP ingress
 * (server + tool-dispatch + host-plane router + agent-output/contexts views) and
 * the `FiregridRuntime`; the gateway carries the claude-acp factory-loop agent
 * (host-resolved runtime-context MCP) so `session_new` children inherit it.
 *
 * The SIM-SPECIFIC layers are composed OVER firegridHost (model:
 * comp-derisk-ordering/host.ts) and supply the dark-factory fact substrate the
 * ingress's `wait_for` tool reads via `serviceOption(RuntimeChannelRouter)`:
 *   - the `DarkFactoryFactTable` durable fact store + the seeded trigger fact,
 *   - the caller-owned `darkFactory.facts` stream (`CallerOwnedFactStreams`),
 *   - the `RuntimeChannelRouter` route for `darkFactory.facts`.
 * The MCP server / tool-dispatch / host-plane router are NOT re-bound here —
 * firegridHost owns them.
 */

import {
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  durableStreamUrl,
  local,
} from "@firegrid/protocol/launch"
import { firegridHost } from "@firegrid/host-sdk"
import { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
import {
  defaultProductionAdapterLayer,
  DurableStreamsLive,
} from "@firegrid/runtime/unified"
import {
  makeRuntimeChannelRouter,
  RuntimeChannelRouter,
  runtimeRouteFromChannel,
} from "@firegrid/runtime/channels"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import { DurableTable } from "effect-durable-operators"
import { Effect, Layer, Schema, Stream } from "effect"
import type {
  FiregridHost,
  FirelabHostEnv,
} from "../../types.ts"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

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
  env: FirelabHostEnv,
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

const triggerFact = (env: FirelabHostEnv): DarkFactoryFactRow => {
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
  env: FirelabHostEnv,
) =>
  DarkFactoryFactTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        env.durableStreamsBaseUrl,
        `${env.namespace}.firelab.dark-factory.facts`,
      ),
      contentType: "application/json",
    },
  })

const darkFactoryFactRows = (
  table: DarkFactoryFactTable["Type"],
): Stream.Stream<DarkFactoryFactRow, unknown, never> =>
  table.facts.rows().pipe(
    Stream.withSpan("firelab.factory_capstone.dark_factory_facts", {
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

// Sim-specific channel route for the dark-factory fact channel. The ingress's
// `wait_for` tool resolves this via `serviceOption(RuntimeChannelRouter)`; the
// agent-output observation route is provided by firegridHost's MCP ingress.
const RuntimeChannelRouterLive = Layer.effect(
  RuntimeChannelRouter,
  Effect.gen(function*() {
    const table = yield* DarkFactoryFactTable
    return makeRuntimeChannelRouter([
      runtimeRouteFromChannel(
        makeIngressChannel({
          target: darkFactoryFactChannel,
          schema: DarkFactoryFactRowSchema,
          sourceClass: "static-source",
          stream: darkFactoryFactRows(table),
        }),
      ),
    ])
  }),
)

const seedTriggerFactLayer = (env: FirelabHostEnv) =>
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
      Effect.withSpan("firelab.factory_capstone.seed_trigger_fact", {
        kind: "internal",
      }),
    ),
  )

export const factoryCapstoneHost = (
  env: FirelabHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const factTable = darkFactoryFactTableLayer(env)
  // Sim layers: fact table + caller-owned fact stream + the dark-factory channel
  // route + the seeded trigger fact. Composed OVER firegridHost so the ingress's
  // tool-dispatch sees the RuntimeChannelRouter / CallerOwnedFactStreams.
  const simLayers = Layer.mergeAll(
    DarkFactoryCallerOwnedFactStreamsLive,
    RuntimeChannelRouterLive,
    seedTriggerFactLayer(env),
  ).pipe(Layer.provideMerge(factTable))

  return simLayers.pipe(
    Layer.provideMerge(
      firegridHost({
        spec: { namespace: env.namespace },
        adapter: defaultProductionAdapterLayer(
          RuntimeEnvResolverPolicy.withPolicy({
            authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
            lookupEnv: name => env.processEnv[name],
          }),
        ),
        backend: DurableStreamsLive.configuredWith({
          baseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
        }),
        ingress: {
          transport: "durable-streams",
          baseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
          streamId: "factory-capstone",
          gatewayExternalKey: {
            source: "firelab",
            id: "factory-capstone-gateway",
          },
          gatewayRuntime: local.jsonl({
            argv: [...claudeAcpArgv],
            agent: "claude-acp",
            agentProtocol: "acp",
            cwd: globalThis.process.cwd(),
            envBindings: [
              { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
            ],
            runtimeContextMcp: { enabled: true },
          }),
        },
      }),
    ),
  )
}
