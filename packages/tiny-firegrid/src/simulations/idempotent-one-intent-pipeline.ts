import {
  Firegrid,
  type FiregridService,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import { Effect, type Layer } from "effect"

// SUBSTRATE-PROPERTY simulation — factory-vision §7.3:
// "Map one external intent to one participant."
//
// It proves, through the PUBLIC Firegrid client/host surface only (no
// src/configurations/, no @firegrid/runtime adapter, self-contained host),
// that the SAME external intent arriving more than once — redelivery, retry,
// or operator replay — maps to exactly ONE durable participant, while a
// DIFFERENT external intent maps to a distinct participant.
//
// This is the redelivery-safety the full §6 choreography depends on: a
// ticket that arrives twice must yield one planner, not two. The public
// idempotent find-or-create is firegrid.sessions.createOrLoad keyed by an
// external [source, entity] key (the same shape §6.5 / apps-factory uses).
//
// Falsifiable booleans in the trace artifact:
//
//  - sameKeyOneParticipant        — two createOrLoad with the same external
//                                    key return the same participant id.
//  - redeliveryYieldsOneParticipant — N independent redeliveries of the same
//                                    external intent collapse to one id.
//  - differentKeyDistinctParticipant — a different external key yields a
//                                    distinct participant id.
//  - noCrossEntityCollision       — two distinct entities never collide.
//  - capabilityProven             — all of the above hold.

interface IdempotentOneIntentResult {
  readonly sameKeyOneParticipant: boolean
  readonly redeliveryYieldsOneParticipant: boolean
  readonly differentKeyDistinctParticipant: boolean
  readonly noCrossEntityCollision: boolean
  readonly capabilityProven: boolean
  readonly evidence: ReadonlyArray<string>
}

// A trivial deterministic no-op runtime. §7.3 is participant MAPPING, not a
// run: createOrLoad still requires a runtime intent, and we never call
// start(), so nothing spawns — createOrLoad just find-or-creates the durable
// participant row keyed by the external key.
const noopRuntime = () =>
  local.jsonl({
    argv: [globalThis.process.execPath, "-e", "process.exit(0)"],
    agentProtocol: "stdio-jsonl",
    cwd: globalThis.process.cwd(),
  })

// One external intent arriving (a single delivery). A real consumer maps the
// verified external [source, entity] to a participant via createOrLoad. Each
// call models an independent delivery (separate request), exactly as a
// redelivery / retry / operator replay would arrive.
const mapIntentToParticipant = (
  firegrid: FiregridService,
  source: string,
  entity: string,
): Effect.Effect<string, unknown> =>
  firegrid.sessions.createOrLoad({
    externalKey: { source, id: entity },
    runtime: noopRuntime(),
    createdBy: "tiny-firegrid-intent-router",
  }).pipe(Effect.map(handle => handle.contextId))

const idempotentOneIntentDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<IdempotentOneIntentResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const evidence: Array<string> = []
    const firegrid = yield* Firegrid

    const source = "support-desk"
    const ticket = `TCK-${env.runId}`
    const otherTicket = `TCK-OTHER-${env.runId}`

    // First delivery of the external intent.
    const first = yield* mapIntentToParticipant(firegrid, source, ticket)
    // Redelivery / retry: the SAME external intent arrives again.
    const redeliver = yield* mapIntentToParticipant(firegrid, source, ticket)
    const sameKeyOneParticipant = first === redeliver
    evidence.push(
      `same external key (${source}/${ticket}) twice -> ` +
      `participant stable=${sameKeyOneParticipant} (${first}).`,
    )

    // Operator replay storm: N more independent redeliveries of the same
    // intent must all collapse to the one participant.
    const replays = yield* Effect.all(
      [0, 1, 2, 3].map(() => mapIntentToParticipant(firegrid, source, ticket)),
      { concurrency: "unbounded" },
    )
    const redeliveryYieldsOneParticipant = replays.every(id => id === first)
    evidence.push(
      `${replays.length} concurrent redeliveries of the same intent -> ` +
      `all one participant=${redeliveryYieldsOneParticipant}.`,
    )

    // A different external intent (different entity) must map to a distinct
    // participant — no over-collapsing.
    const distinct = yield* mapIntentToParticipant(firegrid, source, otherTicket)
    const differentKeyDistinctParticipant = distinct !== first
    evidence.push(
      `different external key (${source}/${otherTicket}) -> ` +
      `distinct participant=${differentKeyDistinctParticipant} (${distinct}).`,
    )

    // A different source with the SAME entity id must also stay distinct
    // (the key is the [source, entity] pair, not entity alone).
    const otherSource = yield* mapIntentToParticipant(
      firegrid,
      "billing-desk",
      ticket,
    )
    const noCrossEntityCollision =
      otherSource !== first && otherSource !== distinct
    evidence.push(
      "same entity id under a different source -> no collision=" +
      `${noCrossEntityCollision} (${otherSource}).`,
    )

    const capabilityProven =
      sameKeyOneParticipant &&
      redeliveryYieldsOneParticipant &&
      differentKeyDistinctParticipant &&
      noCrossEntityCollision

    return {
      sameKeyOneParticipant,
      redeliveryYieldsOneParticipant,
      differentKeyDistinctParticipant,
      noCrossEntityCollision,
      capabilityProven,
      evidence,
    }
  })

const inlineIdempotentOneIntentHost = (
  env: TinyFiregridSimulationEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const hostId = "host-a"
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return FiregridRuntimeHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    hostId,
    hostSessionId: `${hostId}-session`,
    input: true,
    ...(env.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: env.localProcessEnv }),
  })
}

export const idempotentOneIntentSimulation = {
  id: "idempotent-one-intent-pipeline",
  description:
    "Proves factory-vision §7.3 through the public Firegrid surface: the same external intent (redelivery/retry/operator replay) maps to one durable participant via sessions.createOrLoad keyed by [source,entity], while a different key yields a distinct participant.",
  makeHost: inlineIdempotentOneIntentHost,
  driver: idempotentOneIntentDriver,
  summarize: result => ({
    capabilityProven: result.capabilityProven,
    sameKeyOneParticipant: result.sameKeyOneParticipant,
    redeliveryYieldsOneParticipant: result.redeliveryYieldsOneParticipant,
    differentKeyDistinctParticipant: result.differentKeyDistinctParticipant,
    noCrossEntityCollision: result.noCrossEntityCollision,
    evidence: result.evidence,
  }),
  localize: result =>
    result.capabilityProven
      ? [
        "Capability PROVEN (factory-vision §7.3): one external intent maps",
        "to one durable participant through the public Firegrid surface.",
        "Redelivery / retry / operator replay of the same external key is",
        "safe — sessions.createOrLoad find-or-creates a deterministic",
        "participant id; a different [source,entity] key stays distinct.",
        "This is the redelivery-safety the full §6 choreography relies on.",
      ]
      : [
        "FINDING: §7.3 redelivery-safety is NOT upheld through the public",
        "surface.",
        `sameKeyOneParticipant=${result.sameKeyOneParticipant} `,
        `redeliveryYieldsOneParticipant=${result.redeliveryYieldsOneParticipant} `,
        `differentKeyDistinctParticipant=${result.differentKeyDistinctParticipant} `,
        `noCrossEntityCollision=${result.noCrossEntityCollision}.`,
        "A same-key intent that yields two participants (or a different key",
        "that collapses) breaks the §6 choreography (a ticket arriving twice",
        "would spawn two planners). Inspect createOrLoad span attributes and",
        "the derived participant id for each delivery.",
      ],
} satisfies TinyFiregridSimulation<IdempotentOneIntentResult>
