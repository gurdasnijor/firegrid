/**
 * comp-sim-idempotent driver — cap-3 / factory-vision §7.3 "map one external
 * intent to one participant", PURELY over `@firegrid/client-sdk/mcp` (tf-focr).
 *
 * `mcp.sessions.createOrLoad` (the `session_create_or_load` MCP tool) is keyed
 * by a CALLER external `[source, id]`: the SAME external intent arriving more
 * than once (redelivery / retry / operator replay) must collapse to exactly ONE
 * durable participant `contextId`, while a DIFFERENT key stays distinct. We
 * never prompt/start — this is participant MAPPING, not a run, so nothing
 * spawns; a noop runtime intent just satisfies the row.
 *
 * The trace is the deliverable: each `createOrLoad` emits a
 * `firegrid.durable_table.insert_or_get` span, and the driver adds one summary
 * span recording every resolved participant id. NO in-sim verdict — the prose
 * finding reads idempotency/distinctness off the recorded ids.
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { local, makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Duration, Effect, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:comp-sim-idempotent-gateway"
const streamId = "comp-sim-idempotent"

// A deterministic no-op runtime. createOrLoad requires a runtime intent for the
// participant row; the session is never started, so the argv never runs.
const noopRuntime = () =>
  local.jsonl({
    argv: [process.execPath, "-e", "process.exit(0)"],
    agentProtocol: "stdio-jsonl",
    cwd: process.cwd(),
  })

interface CompSimIdempotentResult {
  readonly first: string
  readonly redeliver: string
  readonly replays: ReadonlyArray<string>
  readonly distinctEntity: string
  readonly otherSource: string
}

export const driver: Effect.Effect<CompSimIdempotentResult, unknown, FiregridConfig> =
  Effect.gen(function*() {
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("comp-sim-idempotent requires durableStreamsBaseUrl and namespace"),
      )
    }

    const mcp = yield* makeFiregridMcpClient({
      durableStreamsBaseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
      clientId: 2,
      pollIntervalMs: 250,
    })

    yield* mcp.initialize

    // Wait for the host-seeded gateway context before provisioning off it (the
    // MCP tool routes via the gateway runtime context).
    yield* mcp.observations.watchContexts(
      context => context.contextId === gatewayContextId,
    ).pipe(
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.seconds(30),
        onTimeout: () => new Error("host gateway context did not appear over MCP"),
      }),
    )

    // One delivery of an external intent → its mapped participant contextId.
    // Each call models an independent delivery (redelivery / retry / replay).
    const mapIntent = (source: string, id: string) =>
      mcp.sessions.createOrLoad({
        externalKey: { source, id },
        runtime: noopRuntime(),
        createdBy: "tiny-firegrid-intent-router",
      }).pipe(Effect.map(handle => handle.contextId))

    const source = "support-desk"
    const ticket = `TCK-${crypto.randomUUID()}`
    const otherTicket = `TCK-OTHER-${crypto.randomUUID()}`

    // First delivery of the external intent.
    const first = yield* mapIntent(source, ticket)
    // Redelivery / retry: the SAME external intent arrives again.
    const redeliver = yield* mapIntent(source, ticket)
    // Operator replay storm: N concurrent redeliveries of the same intent.
    const replays = yield* Effect.all(
      [0, 1, 2, 3].map(() => mapIntent(source, ticket)),
      { concurrency: "unbounded" },
    )
    // A different external entity must map to a distinct participant.
    const distinctEntity = yield* mapIntent(source, otherTicket)
    // The SAME entity id under a DIFFERENT source must also stay distinct (the
    // key is the [source, id] pair, not id alone).
    const otherSource = yield* mapIntent("billing-desk", ticket)

    // Instrumentation only — record the observed participant ids in the trace.
    // The prose finding compares them; the sim computes no verdict.
    yield* Effect.annotateCurrentSpan({
      "firegrid.sim.external_source": source,
      "firegrid.sim.external_ticket": ticket,
      "firegrid.sim.external_other_ticket": otherTicket,
      "firegrid.sim.participant.first": first,
      "firegrid.sim.participant.redeliver": redeliver,
      "firegrid.sim.participant.replays": replays.join(","),
      "firegrid.sim.participant.distinct_entity": distinctEntity,
      "firegrid.sim.participant.other_source": otherSource,
      "firegrid.sim.transport": "mcp",
    })

    return { first, redeliver, replays, distinctEntity, otherSource }
  }).pipe(
    Effect.withSpan("firegrid.sim.idempotent_one_intent", {
      kind: "internal",
      attributes: {
        "firegrid.bead": "tf-focr",
        "firegrid.simulation.intent": "idempotent-one-intent-over-mcp",
      },
    }),
  )
