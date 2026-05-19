import {
  Firegrid,
  type FiregridSessionHandle,
  local,
} from "@firegrid/client-sdk/firegrid"
import { tinyMultiContextProductionConsumingPipeline } from "../configurations/multi-context-production-consuming-pipeline.ts"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import { Clock, Effect, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client substrate-property simulation retry backoff. */

// SUBSTRATE-PROPERTY simulation (not choreography / not agent-driven).
//
// It consumes the *production* runtime host (FiregridRuntimeHostLive via
// tinyMultiContextProductionConsumingPipeline) and drives several runtime
// contexts purely through the public Firegrid client surface with
// deterministic, non-agent local processes. Each context's child emits a
// context-stamped token on stdout as stdio-jsonl. There is no LLM, no tool
// loop, and no inter-context orchestration: the only variable is whether the
// substrate keeps per-context input/output isolated and durable.
//
// Falsifiable properties (the A4-bug class: per-context streams vs a shared
// host-prefixed stream):
//
//  1. Isolation — a context's public per-context agent-output observation
//     stream contains only its own stamped token, never a sibling's. A
//     host-prefixed shared output stream would surface a sibling token here.
//  2. Durable-while-inactive — a context whose durable runtime-input intent
//     is appended *before* it is started, and which stays inactive while
//     other contexts run to completion and exit, still produces its own
//     isolated output once it is finally started. A non-per-context input
//     plane would lose or cross-deliver that intent.
//
// The trace artifact is the deliverable; it makes per-context isolation
// falsifiable. A detected leak/break is surfaced (isolationViolation /
// durableInactiveLost in the summary + localization), not papered over.

interface ContextLabel {
  readonly label: string
  readonly externalId: string
  readonly token: string
}

interface ContextObservation {
  readonly label: string
  readonly token: string
  readonly observedText: string
  readonly sawOwnToken: boolean
  readonly foreignTokensSeen: ReadonlyArray<string>
}

interface MultiContextProductionConsumingResult {
  readonly contexts: ReadonlyArray<ContextObservation>
  readonly isolationViolation: boolean
  readonly durableInactiveLost: boolean
}

// Deterministic, non-agent child: emit a context-stamped token twice as
// stdio-jsonl, then exit. It never reads stdin and never depends on the
// prompt payload, so per-context output content is fully determined by which
// context spawned it. Any sibling token observed on a context's stream is a
// substrate isolation break, not child nondeterminism.
const stampedChildCode = (token: string): string =>
  [
    `const t=${JSON.stringify(token)};`,
    "console.log(JSON.stringify({type:'text',text:t+'#1'}));",
    "console.log(JSON.stringify({type:'text',text:t+'#2'}));",
    "console.log(JSON.stringify({type:'turn_complete',finishReason:'stop'}));",
  ].join("")

const contextLabels = (runId: string): ReadonlyArray<ContextLabel> =>
  (["ctx-a", "ctx-b", "ctx-c"] as const).map(label => ({
    label,
    externalId: `${runId}:${label}`,
    // Token is unique per (run, context) so a cross-context leak is
    // unambiguous and cannot be confused with a stale artifact.
    token: `FIREGRID_${label.toUpperCase().replace(/-/g, "_")}_OUT`,
  }))

const allTokens = (labels: ReadonlyArray<ContextLabel>): ReadonlyArray<string> =>
  labels.map(entry => entry.token)

const promptRetry = Effect.retry(
  Schedule.intersect(Schedule.spaced("1000 millis"), Schedule.recurs(60)),
)

const openSession = (
  env: TinyFiregridSimulationEnv,
  entry: ContextLabel,
) =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    return yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: entry.externalId,
      },
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "--input-type=module",
          "-e",
          stampedChildCode(entry.token),
        ],
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })
  })

// Drain the *public per-context* agent-output observation stream for one
// context until its own token is seen (twice) or the deadline passes,
// recording every token observed so foreign tokens are caught.
const observeContext = (
  session: FiregridSessionHandle,
  entry: ContextLabel,
  foreignTokens: ReadonlyArray<string>,
  deadlineMs: number,
): Effect.Effect<ContextObservation, unknown> =>
  Effect.gen(function*() {
    let observedText = ""
    let afterSequence: number | undefined
    let ownHits = 0

    while (ownHits < 2) {
      if ((yield* Clock.currentTimeMillis) >= deadlineMs) break
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      }).pipe(
        Effect.retry(
          Schedule.intersect(Schedule.spaced("1000 millis"), Schedule.recurs(5)),
        ),
      )
      if (!next.matched) continue
      afterSequence = next.output.sequence
      const event = next.output.event
      if (event._tag === "TextChunk") {
        const delta = event.part.delta
        observedText += delta
        if (delta.includes(entry.token)) ownHits += 1
      }
    }

    const foreignTokensSeen = foreignTokens.filter(token =>
      observedText.includes(token))
    return {
      label: entry.label,
      token: entry.token,
      observedText,
      sawOwnToken: ownHits >= 1,
      foreignTokensSeen,
    }
  })

const multiContextProductionConsumingDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<MultiContextProductionConsumingResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const labels = contextLabels(env.runId)
    const tokens = allTokens(labels)
    const [ctxA, ctxB, ctxC] = labels
    if (ctxA === undefined || ctxB === undefined || ctxC === undefined) {
      return yield* Effect.fail("expected three context labels")
    }

    const sessionA = yield* openSession(env, ctxA)
    const sessionB = yield* openSession(env, ctxB)
    const sessionC = yield* openSession(env, ctxC)

    // Interleave durable runtime-input intents across contexts. ctx-c's
    // intent is appended here, while ctx-c is still INACTIVE (never started),
    // and intentionally stays inactive through ctx-a/ctx-b's full lifecycle.
    yield* sessionA.prompt({
      payload: "tiny-firegrid substrate probe a",
      idempotencyKey: `${env.runId}:ctx-a:turn-1`,
    }).pipe(promptRetry)
    yield* sessionC.prompt({
      payload: "tiny-firegrid substrate probe c (durable-while-inactive)",
      idempotencyKey: `${env.runId}:ctx-c:turn-1`,
    }).pipe(promptRetry)
    yield* sessionB.prompt({
      payload: "tiny-firegrid substrate probe b",
      idempotencyKey: `${env.runId}:ctx-b:turn-1`,
    }).pipe(promptRetry)

    // Start only a and b. ctx-c remains inactive with a persisted intent.
    yield* sessionA.start()
    yield* sessionB.start()

    const phaseOneDeadline = (yield* Clock.currentTimeMillis) + 90_000
    const observeA = yield* observeContext(
      sessionA,
      ctxA,
      tokens.filter(token => token !== ctxA.token),
      phaseOneDeadline,
    )
    const observeB = yield* observeContext(
      sessionB,
      ctxB,
      tokens.filter(token => token !== ctxB.token),
      phaseOneDeadline,
    )

    // ctx-c was inactive for the entire a/b run. Start it now and assert its
    // durable pre-start intent still drives its own isolated output.
    yield* sessionC.start()
    const phaseTwoDeadline = (yield* Clock.currentTimeMillis) + 90_000
    const observeC = yield* observeContext(
      sessionC,
      ctxC,
      tokens.filter(token => token !== ctxC.token),
      phaseTwoDeadline,
    )

    const contexts = [observeA, observeB, observeC]
    const isolationViolation = contexts.some(ctx =>
      ctx.foreignTokensSeen.length > 0)
    const durableInactiveLost = !observeC.sawOwnToken

    return { contexts, isolationViolation, durableInactiveLost }
  })

export const multiContextProductionConsumingSimulation = {
  id: "multi-context-production-consuming-pipeline",
  description:
    "Drives several runtime contexts on the production host through the public Firegrid client with deterministic non-agent children, asserting per-context output isolation and durable-while-inactive input delivery.",
  makeHost: env =>
    tinyMultiContextProductionConsumingPipeline({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      ...(env.localProcessEnv === undefined
        ? {}
        : { localProcessEnv: env.localProcessEnv }),
    }),
  driver: multiContextProductionConsumingDriver,
  summarize: result => ({
    isolationViolation: result.isolationViolation,
    durableInactiveLost: result.durableInactiveLost,
    contexts: result.contexts.map(ctx => ({
      label: ctx.label,
      sawOwnToken: ctx.sawOwnToken,
      foreignTokensSeen: ctx.foreignTokensSeen,
      observedTextExcerpt: ctx.observedText.slice(0, 400),
    })),
  }),
  localize: result =>
    result.isolationViolation
      ? [
        "FINDING: cross-context leak observed — a context's public per-context",
        "agent-output stream contained a sibling context's stamped token.",
        "This is the A4-bug class (per-context vs host-prefixed shared stream).",
        "Inspect runtime-output and durable-table span attributes for the",
        "stream namespace/collection each context read and wrote, and confirm",
        "the host derived per-context (not host-prefixed) output streams.",
      ]
      : result.durableInactiveLost
        ? [
          "FINDING: durable-while-inactive intent lost — ctx-c's runtime-input",
          "intent was appended before start and ctx-c stayed inactive through",
          "ctx-a/ctx-b's lifecycle, but ctx-c produced no output once started.",
          "Inspect durable runtime-input intent rows and the context claim/",
          "materialization spans for ctx-c.",
        ]
        : [
          "Per-context isolation and durable-while-inactive delivery held.",
          "Inspect the DuckDB span tables for the per-context host, codec,",
          "workflow, runtime-output, and durable-table path of each context.",
        ],
} satisfies TinyFiregridSimulation<MultiContextProductionConsumingResult>

/* eslint-enable local/no-fixed-polling */
