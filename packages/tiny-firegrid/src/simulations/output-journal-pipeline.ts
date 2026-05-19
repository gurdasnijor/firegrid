import {
  Firegrid,
  type FiregridSessionHandle,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import { Clock, Effect, type Layer, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client substrate-property simulation retry backoff. */

// SUBSTRATE-PROPERTY simulation (not choreography / not agent-driven).
//
// It consumes the production runtime host (FiregridRuntimeHostLive, inlined
// here so the simulation is self-contained and does not depend on
// src/configurations/, which is slated for deletion) and drives one runtime
// context purely through the public Firegrid client with a deterministic,
// non-agent local process. The child emits a context-stamped token on stdout
// as stdio-jsonl. There is no LLM and no tool loop: the only variable is
// whether the durable runtime-output journal stays consistent between the
// "row written" (durable projection) and "row observed" (waiter/subscriber)
// reads.
//
// Falsifiable property — the runbook's "row written vs row observed"
// consistency layer (docs/runbooks/firegrid-effect-tracing.md, DurableTable
// facade / runtime-output section): agent/runtime output that is written must
// be decoded into the durable runtime-output journal AND be observable to
// waits/subscribers, and what a waiter observes must be durably journaled.
//
//  - wrote      — the deterministic child's stamped token appears on at
//                  least one public read path (output existed at all).
//  - journaled  — the token is present in the durable runtime-output journal
//                  projection read via session.snapshot().agentOutputs
//                  ("row written").
//  - observable — the token is delivered via session.wait.forAgentOutput,
//                  the waiter/subscriber path ("row observed").
//  - divergence — journaled !== observable. A written-but-not-observable or
//                  observable-but-not-journaled token is a substrate
//                  consistency break, surfaced as a FINDING (not papered).
//
// The trace artifact is the deliverable; it makes journal observability
// falsifiable.

interface OutputJournalResult {
  readonly token: string
  readonly wrote: boolean
  readonly journaled: boolean
  readonly observable: boolean
  readonly divergence: boolean
  readonly journaledCount: number
  readonly observedTextExcerpt: string
}

// Deterministic, non-agent child: emit a stamped token twice as stdio-jsonl
// then signal turn completion and exit. It never reads stdin and never
// depends on the prompt payload, so the journal content is fully determined
// by the substrate, not child nondeterminism.
const stampedChildCode = (token: string): string =>
  [
    `const t=${JSON.stringify(token)};`,
    "console.log(JSON.stringify({type:'text',text:t+'#1'}));",
    "console.log(JSON.stringify({type:'text',text:t+'#2'}));",
    "console.log(JSON.stringify({type:'turn_complete',finishReason:'stop'}));",
  ].join("")

const promptRetry = Effect.retry(
  Schedule.intersect(Schedule.spaced("1000 millis"), Schedule.recurs(60)),
)

// Drain the waiter/subscriber path until the stamped token is observed twice
// or the deadline passes, recording all observed text.
const observeViaWaitPath = (
  session: FiregridSessionHandle,
  token: string,
  deadlineMs: number,
): Effect.Effect<string, unknown> =>
  Effect.gen(function*() {
    let observedText = ""
    let afterSequence: number | undefined
    let hits = 0

    while (hits < 2) {
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
        if (delta.includes(token)) hits += 1
      }
    }

    return observedText
  })

// Read the durable runtime-output journal projection via the public
// snapshot() surface ("row written"). Retry until the journal has caught up
// or the deadline passes; the property under test is consistency, not race
// timing, so a bounded settle window is acceptable.
const journaledText = (
  session: FiregridSessionHandle,
  token: string,
  deadlineMs: number,
): Effect.Effect<{ readonly text: string; readonly count: number }, unknown> =>
  Effect.gen(function*() {
    let text = ""
    let count = 0
    while ((yield* Clock.currentTimeMillis) < deadlineMs) {
      const snapshot = yield* session.snapshot().pipe(
        Effect.retry(
          Schedule.intersect(Schedule.spaced("1000 millis"), Schedule.recurs(5)),
        ),
      )
      const textChunks = snapshot.agentOutputs.filter(
        observation => observation._tag === "TextChunk",
      )
      text = textChunks
        .map(observation =>
          observation._tag === "TextChunk" ? observation.event.part.delta : "")
        .join("")
      count = textChunks.length
      if (text.includes(token)) break
      yield* Effect.sleep("1000 millis")
    }
    return { text, count }
  })

const outputJournalDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<OutputJournalResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const token = `FIREGRID_OUTPUT_JOURNAL_${env.runId.replace(/[^A-Za-z0-9]/g, "_")}`
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: `${env.runId}:output-journal`,
      },
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "--input-type=module",
          "-e",
          stampedChildCode(token),
        ],
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: "tiny-firegrid output-journal substrate probe",
      idempotencyKey: `${env.runId}:output-journal:turn-1`,
    }).pipe(promptRetry)
    yield* session.start()

    const observeDeadline = (yield* Clock.currentTimeMillis) + 90_000
    const observedText = yield* observeViaWaitPath(session, token, observeDeadline)

    const journalDeadline = (yield* Clock.currentTimeMillis) + 60_000
    const journal = yield* journaledText(session, token, journalDeadline)

    const observable = observedText.includes(token)
    const journaled = journal.text.includes(token)
    const wrote = observable || journaled
    const divergence = journaled !== observable

    return {
      token,
      wrote,
      journaled,
      observable,
      divergence,
      journaledCount: journal.count,
      observedTextExcerpt: observedText.slice(0, 400),
    }
  })

const inlineOutputJournalHost = (
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

export const outputJournalSimulation = {
  id: "output-journal-pipeline",
  description:
    "Drives one runtime context on the production host through the public Firegrid client with a deterministic non-agent child, asserting the durable runtime-output journal is consistent between the durable projection (snapshot) and the waiter/subscriber path (wait.forAgentOutput).",
  makeHost: inlineOutputJournalHost,
  driver: outputJournalDriver,
  summarize: result => ({
    wrote: result.wrote,
    journaled: result.journaled,
    observable: result.observable,
    divergence: result.divergence,
    journaledCount: result.journaledCount,
    observedTextExcerpt: result.observedTextExcerpt,
  }),
  localize: result =>
    result.divergence
      ? [
        "FINDING: runtime-output journal consistency break — the stamped",
        "token was present on exactly one of the durable projection",
        "(snapshot.agentOutputs) and the waiter path (wait.forAgentOutput).",
        "This is the runbook's 'row written vs row observed' class.",
        `journaled=${result.journaled} observable=${result.observable}.`,
        "Inspect the DurableTable facade and runtime-output append/read span",
        "attributes (namespace, collection, contextId, sequence) to locate",
        "where the write and the observable read diverged.",
      ]
      : result.wrote
        ? [
          "Runtime-output journal stayed consistent: written output was both",
          "durably journaled and observable to the waiter path.",
          "Inspect the DuckDB span tables for the runtime-output, codec, and",
          "durable-table path of this context.",
        ]
        : [
          "No output was journaled or observed. Inspect the codec and",
          "local-process boundary spans to see whether the child produced",
          "decodable stdio-jsonl at all.",
        ],
} satisfies TinyFiregridSimulation<OutputJournalResult>

/* eslint-enable local/no-fixed-polling */
