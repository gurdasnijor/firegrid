import {
  Firegrid,
  type FiregridService,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

// cap-3 / factory-vision §7.3 — "map one external intent to one participant",
// post-§12, through the PUBLIC client surface only.
//
// `firegrid.sessions.createOrLoad`, keyed by an external `[source, id]`, is the
// idempotent find-or-create: the SAME external intent arriving more than once
// (redelivery / retry / operator replay) must collapse to exactly ONE durable
// participant `contextId`, while a DIFFERENT key stays distinct. We never call
// start() — this is participant MAPPING, not a run, so nothing spawns; a noop
// runtime intent just satisfies the row.
//
// The trace is the deliverable: each `createOrLoad` already emits a
// `firegrid.client.session.create_or_load` span carrying `external_key.*` +
// `firegrid.context.id`, and the driver adds one summary span recording every
// resolved participant id. NO in-sim verdict — the prose finding reads
// idempotency/distinctness off the recorded ids.

// A deterministic no-op runtime. createOrLoad requires a runtime intent for the
// row; start() is never called, so the argv never runs.
const noopRuntime = () =>
  local.jsonl({
    argv: [process.execPath, "-e", "process.exit(0)"],
    agentProtocol: "stdio-jsonl",
    cwd: process.cwd(),
  })

// One delivery of an external intent → its mapped participant contextId. Each
// call models an independent delivery (redelivery / retry / operator replay).
const mapIntent = (
  firegrid: FiregridService,
  source: string,
  id: string,
): Effect.Effect<string, unknown> =>
  firegrid.sessions
    .createOrLoad({
      externalKey: { source, id },
      runtime: noopRuntime(),
      createdBy: "tiny-firegrid-intent-router",
    })
    .pipe(Effect.map((handle) => handle.contextId))

export const compSimIdempotentDriver = Effect.gen(function*() {
  const firegrid = yield* Firegrid

  // Fresh keys per run (the embedded server + namespace are per-run, but unique
  // ids keep the trace unambiguous and avoid any cross-run carryover).
  const source = "support-desk"
  const ticket = `TCK-${crypto.randomUUID()}`
  const otherTicket = `TCK-OTHER-${crypto.randomUUID()}`

  // First delivery of the external intent.
  const first = yield* mapIntent(firegrid, source, ticket)
  // Redelivery / retry: the SAME external intent arrives again.
  const redeliver = yield* mapIntent(firegrid, source, ticket)
  // Operator replay storm: N concurrent redeliveries of the same intent.
  const replays = yield* Effect.all(
    [0, 1, 2, 3].map(() => mapIntent(firegrid, source, ticket)),
    { concurrency: "unbounded" },
  )
  // A different external entity must map to a distinct participant.
  const distinctEntity = yield* mapIntent(firegrid, source, otherTicket)
  // The SAME entity id under a DIFFERENT source must also stay distinct (the
  // key is the [source, id] pair, not id alone).
  const otherSource = yield* mapIntent(firegrid, "billing-desk", ticket)

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
  })
}).pipe(
  Effect.withSpan("firegrid.sim.idempotent_one_intent", { kind: "internal" }),
)
