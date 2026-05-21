/**
 * Host composition for the layer-composition variant. Mirrors the sibling
 * `inv2-waitforworkflow` host but plugs in `SimWaitForMcpServerLayerLayered`
 * (which discharges WorkflowEngine via layer composition, not capture).
 *
 * Variant-local table / namespace / port keep the two sims fully isolated
 * when run on the same Durable Streams test server.
 */

import type { ServeError } from "@effect/platform/HttpServerError"
import {
  durableStreamUrl,
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
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
import {
  simWaitForLayeredMcpUrl,
  SimWaitForMcpServerLayerLayered,
} from "./mcp-server.ts"

export const factSource = "inv2-waitforworkflow-layered.facts"
export const factEventTypeMatching = "inv2.wait-for-workflow.layered.match"
const factEventTypeDecoy = "inv2.wait-for-workflow.layered.decoy"
export const correlationIdA = "inv2-layered-corr-a"
export const correlationIdB = "inv2-layered-corr-b"
const correlationIdDecoy = "inv2-layered-corr-decoy"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

class Inv2LayeredFactTable extends DurableTable(
  "inv2WaitForWorkflowLayeredFacts",
  { facts: FactRowSchema },
) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      baseUrl,
      `${namespace}.inv2WaitForWorkflowLayeredFacts`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const preSeedRows = () => {
  const acceptedAt = new Date().toISOString()
  return [
    {
      factId: `${factSource}:${correlationIdA}:${factEventTypeMatching}`,
      source: factSource,
      eventType: factEventTypeMatching,
      correlationId: correlationIdA,
      payload: { decision: "approved-a", note: "match for execution a" },
      acceptedAt,
    },
    {
      factId: `${factSource}:${correlationIdB}:${factEventTypeMatching}`,
      source: factSource,
      eventType: factEventTypeMatching,
      correlationId: correlationIdB,
      payload: { decision: "approved-b", note: "match for execution b" },
      acceptedAt,
    },
    {
      factId: `${factSource}:${correlationIdDecoy}:${factEventTypeMatching}`,
      source: factSource,
      eventType: factEventTypeMatching,
      correlationId: correlationIdDecoy,
      payload: { decision: "do-not-pick-me", note: "decoy" },
      acceptedAt,
    },
    {
      factId: `${factSource}:${correlationIdA}:${factEventTypeDecoy}`,
      source: factSource,
      eventType: factEventTypeDecoy,
      correlationId: correlationIdA,
      payload: { decision: "wrong-event-type", note: "decoy" },
      acceptedAt,
    },
  ]
}

export interface Inv2LayeredHostOptions {
  readonly mcpHost: string
  readonly mcpPort: number
  readonly mcpPath: string
}

export const inv2LayeredMcpServerName =
  "firegrid-sim-inv2-wait-for-workflow-layered"

export const inv2LayeredMcpServerUrl = (options: Inv2LayeredHostOptions) =>
  simWaitForLayeredMcpUrl({
    host: options.mcpHost,
    port: options.mcpPort,
    path: options.mcpPath,
  })

export const inv2LayeredHost = (
  env: TinyFiregridHostEnv,
  options: Inv2LayeredHostOptions,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace

  const factTable = Inv2LayeredFactTable.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function* () {
      const table = yield* Inv2LayeredFactTable
      yield* Effect.forEach(
        preSeedRows(),
        (row) => table.facts.insertOrGet(row),
        { discard: true },
      )
    }).pipe(
      Effect.withSpan("firegrid.sim.inv2_layered.host.seed_facts", {
        kind: "internal",
        attributes: {
          "firegrid.sim.inv2_layered.fact_source": factSource,
          "firegrid.sim.inv2_layered.fact_count": preSeedRows().length,
        },
      }),
    ),
  ).pipe(Layer.provide(factTable))

  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(Inv2LayeredFactTable, (table) => ({
      streamFor: (stream: string) =>
        stream === factSource ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: baseUrl,
    namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    })),
  )

  const simMcp = SimWaitForMcpServerLayerLayered({
    host: options.mcpHost,
    port: options.mcpPort,
    path: ensurePathInput(options.mcpPath),
    durableStreamsBaseUrl: baseUrl,
    namespace,
  }).pipe(Layer.provide(callerFacts))

  const appFacts = Layer.mergeAll(factTable, callerFacts, seed)

  return Layer.mergeAll(simMcp).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}
