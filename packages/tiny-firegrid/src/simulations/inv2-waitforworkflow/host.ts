/**
 * Sim host composition for INV-2 (WaitForWorkflow as nested workflow
 * execution). Does NOT mount `FiregridMcpServerLayer` — the agent's only
 * MCP server is the sim-local one in `mcp-server.ts`, which exposes a
 * single `wait_for` tool that dispatches `WaitForWorkflow.execute(...)`
 * on a sim-local engine.
 */

import type { ServeError } from "@effect/platform/HttpServerError"
import {
  CallerOwnedFactStreams,
  durableStreamUrl,
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { SimWaitForMcpServerLayer, simWaitForMcpUrl } from "./mcp-server.ts"

export const factSource = "inv2-waitforworkflow.facts"
export const factEventTypeMatching = "inv2.wait-for-workflow.match"
const factEventTypeDecoy = "inv2.wait-for-workflow.decoy"
export const correlationIdA = "inv2-corr-a"
export const correlationIdB = "inv2-corr-b"
const correlationIdDecoy = "inv2-corr-decoy"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

class Inv2FactTable extends DurableTable("inv2WaitForWorkflowFacts", {
  facts: FactRowSchema,
}) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.inv2WaitForWorkflowFacts`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const preSeedRows = () => {
  const acceptedAt = new Date().toISOString()
  return [
    // Two matching rows for the two wait_for calls the prompt instructs
    // the agent to make.
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
    // Decoy row: same source/event but different correlationId; must NOT
    // satisfy a whereFields predicate on the matching correlation ids.
    {
      factId: `${factSource}:${correlationIdDecoy}:${factEventTypeMatching}`,
      source: factSource,
      eventType: factEventTypeMatching,
      correlationId: correlationIdDecoy,
      payload: { decision: "do-not-pick-me", note: "decoy" },
      acceptedAt,
    },
    // Different eventType, matching correlationId — also must NOT match.
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

export interface Inv2HostOptions {
  readonly mcpHost: string
  readonly mcpPort: number
  readonly mcpPath: string
}

export const inv2WaitForWorkflowMcpServerName =
  "firegrid-sim-inv2-wait-for-workflow"

export const inv2WaitForWorkflowMcpServerUrl = (options: Inv2HostOptions) =>
  simWaitForMcpUrl({
    host: options.mcpHost,
    port: options.mcpPort,
    path: options.mcpPath,
  })

export const inv2WaitForWorkflowHost = (
  env: TinyFiregridHostEnv,
  options: Inv2HostOptions,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace

  const factTable = Inv2FactTable.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function* () {
      const table = yield* Inv2FactTable
      yield* Effect.forEach(
        preSeedRows(),
        (row) => table.facts.insertOrGet(row),
        { discard: true },
      )
    }).pipe(
      Effect.withSpan("firegrid.sim.inv2.host.seed_facts", {
        kind: "internal",
        attributes: {
          "firegrid.sim.inv2.fact_source": factSource,
          "firegrid.sim.inv2.fact_count": preSeedRows().length,
        },
      }),
    ),
  ).pipe(Layer.provide(factTable))

  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(Inv2FactTable, (table) => ({
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

  const simMcp = SimWaitForMcpServerLayer({
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
