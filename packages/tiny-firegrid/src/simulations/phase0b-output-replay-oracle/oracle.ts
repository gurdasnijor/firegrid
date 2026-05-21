import { Effect, Ref } from "effect"

// ---------------------------------------------------------------------------
// Phase 0B output-replay amplification oracle (clean-room).
//
// Captures the tf-7kq8 failure CLASS in clean-room terms and proves which
// primitive shape makes it structurally impossible. It does NOT import the
// production runtime-context implementation — that architecture is treated
// here as a failure specimen, not as ground truth.
//
// The failure (source-verified in docs/investigations/2026-05-21-live-acp-tool-call-triage.md
// against packages/runtime/src/workflow-engine/workflows/runtime-context.ts:
//   - the output-discovery read is a LIVE, non-memoized Effect on the replay
//     path (runtime-context.ts:749/762 -> per-context-output.ts events.initial,
//     a full output-table scan, L110-140);
//   - the loop cursor is an in-memory Ref seeded -1 (runtime-context.ts:820/349)
//     that does NOT survive @effect/workflow replay.
// So every workflow resume re-walks the whole output log from sequence 0,
// producing O(resumes x history) reads instead of O(distinct outputs). A real
// agent turn (~107 outputs -> ~80 resumes) becomes a ~2600-read storm that
// never converges inside the edge turn timeout.
//
// This model reproduces exactly those two conditions and contrasts them with
// a durable-cursor primitive that removes both. The metered resource is
// "log reads" -- the clean-room analogue of the `agent_output.initial` span
// the live trace counted.
// ---------------------------------------------------------------------------

/**
 * Reads-per-distinct-output above this ratio means output observation scales
 * with replay/history rather than with the number of distinct outputs, i.e.
 * the tf-7kq8 amplification class. A replay-safe primitive must stay <= this.
 */
const AMPLIFICATION_THRESHOLD = 2

type Strategy = "specimen" | "candidate"

interface StrategyCounters {
  readonly strategy: Strategy
  /** distinct outputs the producer appended (== turn length) */
  readonly distinctOutputs: number
  /** workflow body re-invocations (one per genuine append, like production) */
  readonly replays: number
  /** times the body touched the underlying output log (the metered resource) */
  readonly logReads: number
  /** observation attempts, whether served from the log or from the journal */
  readonly observeAttempts: number
  /** durable delivered-cursor advances */
  readonly cursorAdvances: number
  /** downstream deliveries (must equal distinctOutputs: exactly-once) */
  readonly deliveries: number
  /** terminal (TurnComplete) deliveries (must equal 1) */
  readonly turnCompleteDeliveries: number
  /** logReads / distinctOutputs */
  readonly amplification: number
  /** satisfies the O(outputs) invariant */
  readonly oOutputs: boolean
}

interface MutCounters {
  logReads: number
  observeAttempts: number
  cursorAdvances: number
  deliveries: number
  turnCompleteDeliveries: number
}

const range = (n: number): ReadonlyArray<number> =>
  Array.from({ length: n }, (_, i) => i)

// A delivered output. The terminal output models TurnComplete.
interface AppendedOutput {
  readonly sequence: number
  readonly terminal: boolean
}

/**
 * Deliver an output exactly once. Delivery is memoized in the durable journal
 * (the @effect/workflow Activity-memoization analogue) so that even when a body
 * replay re-reaches a delivery point, it does not double-emit. This matches
 * production: the storm is in the READ path, not in the activity-memoized
 * send path -- so the specimen and the candidate are scored on the same
 * delivery semantics and differ ONLY in read amplification.
 */
const deliver = (
  journal: Ref.Ref<Map<string, number>>,
  counters: Ref.Ref<MutCounters>,
  durablePos: Ref.Ref<number>,
  output: AppendedOutput,
  emitSpan: boolean,
) =>
  Effect.gen(function*() {
    const j = yield* Ref.get(journal)
    const key = `deliver.${output.sequence}`
    if (j.has(key)) return
    j.set(key, 1)
    yield* Ref.update(counters, c => ({
      ...c,
      deliveries: c.deliveries + 1,
      cursorAdvances: c.cursorAdvances + 1,
      turnCompleteDeliveries:
        c.turnCompleteDeliveries + (output.terminal ? 1 : 0),
    }))
    yield* Ref.set(durablePos, output.sequence)
    if (output.terminal && emitSpan) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.phase0b.turn_complete.sequence": output.sequence,
      }).pipe(
        Effect.withSpan("firegrid.phase0b.oracle.turn_complete", {
          attributes: { "firegrid.phase0b.output.sequence": output.sequence },
        }),
      )
    }
  })

/**
 * SPECIMEN body replay -- the tf-7kq8 shape.
 *
 * The delivered cursor is a VOLATILE in-memory Ref seeded -1 (re-created on
 * every replay), and the read is a live walk that re-touches every log element
 * from 0 to head. There is no memoized read step. So replay r (head = r-1)
 * touches r elements; the total over a turn is sum(1..D) = D(D+1)/2 reads.
 */
const specimenReplay = (
  log: ReadonlyArray<AppendedOutput>,
  journal: Ref.Ref<Map<string, number>>,
  counters: Ref.Ref<MutCounters>,
  durablePos: Ref.Ref<number>,
  replayIndex: number,
  emitSpans: boolean,
) =>
  Effect.gen(function*() {
    // Volatile cursor: reconstructed from scratch each replay (THE BUG).
    const volatilePos = yield* Ref.make(-1)
    const head = log.length - 1
    for (const seq of range(head + 1)) {
      const pos = yield* Ref.get(volatilePos)
      if (seq <= pos) continue
      // Live, non-memoized read of one more log element (full-walk per resume).
      yield* Ref.update(counters, c => ({
        ...c,
        logReads: c.logReads + 1,
        observeAttempts: c.observeAttempts + 1,
      }))
      if (emitSpans) {
        yield* Effect.annotateCurrentSpan({
          "firegrid.phase0b.read.strategy": "specimen",
          "firegrid.phase0b.read.sequence": seq,
          "firegrid.phase0b.read.replay": replayIndex,
          "firegrid.phase0b.read.memoized": false,
        }).pipe(
          Effect.withSpan("firegrid.phase0b.oracle.log_read"),
        )
      }
      yield* Ref.set(volatilePos, seq)
      yield* deliver(journal, counters, durablePos, log[seq]!, emitSpans)
    }
  })

/**
 * CANDIDATE body replay -- the durable-cursor primitive that removes BOTH
 * failure conditions:
 *   1. the delivered position is DURABLE (journal), reconstructed on replay
 *      rather than re-derived by re-scanning;
 *   2. each next() is a journaled/memoized step that, on first execution, does
 *      ONE point read of position+1 (never a full scan), and on replay returns
 *      the recorded result with ZERO log touches.
 * So a turn touches the log exactly D times regardless of replay count.
 */
const candidateReplay = (
  log: ReadonlyArray<AppendedOutput>,
  journal: Ref.Ref<Map<string, number>>,
  counters: Ref.Ref<MutCounters>,
  durablePos: Ref.Ref<number>,
  replayIndex: number,
  emitSpans: boolean,
) =>
  Effect.gen(function*() {
    const head = log.length - 1
    let pos = yield* Ref.get(durablePos) // durable: survives replay
    while (pos < head) {
      const next = pos + 1
      const j = yield* Ref.get(journal)
      const stepKey = `next.${next}`
      const memoized = j.has(stepKey)
      yield* Ref.update(counters, c => ({
        ...c,
        observeAttempts: c.observeAttempts + 1,
        // Point read of exactly one element ONLY on first (non-replay) execution.
        logReads: c.logReads + (memoized ? 0 : 1),
      }))
      if (!memoized) j.set(stepKey, next)
      if (emitSpans) {
        yield* Effect.annotateCurrentSpan({
          "firegrid.phase0b.read.strategy": "candidate",
          "firegrid.phase0b.read.sequence": next,
          "firegrid.phase0b.read.replay": replayIndex,
          "firegrid.phase0b.read.memoized": memoized,
        }).pipe(
          Effect.withSpan("firegrid.phase0b.oracle.output.observe"),
        )
      }
      yield* deliver(journal, counters, durablePos, log[next]!, emitSpans)
      pos = next
    }
  })

/**
 * Run one strategy across a turn of `distinctOutputs` outputs. Models the
 * production interleaving: the workflow parks awaiting the next output, the
 * producer appends one output, that append resumes (replays) the body, the
 * body catches up, then parks again. => one replay per appended output.
 */
const runStrategy = (
  strategy: Strategy,
  distinctOutputs: number,
  emitSpans: boolean,
): Effect.Effect<StrategyCounters> =>
  Effect.gen(function*() {
    const counters = yield* Ref.make<MutCounters>({
      logReads: 0,
      observeAttempts: 0,
      cursorAdvances: 0,
      deliveries: 0,
      turnCompleteDeliveries: 0,
    })
    // Durable state -- created OUTSIDE the body so it survives replays.
    const journal = yield* Ref.make(new Map<string, number>())
    const durablePos = yield* Ref.make(-1)
    const log: Array<AppendedOutput> = []

    yield* Effect.forEach(range(distinctOutputs), seq =>
      Effect.gen(function*() {
        log.push({ sequence: seq, terminal: seq === distinctOutputs - 1 })
        const replay = strategy === "specimen" ? specimenReplay : candidateReplay
        yield* replay(log, journal, counters, durablePos, seq, emitSpans).pipe(
          Effect.withSpan("firegrid.phase0b.oracle.replay", {
            attributes: {
              "firegrid.phase0b.strategy": strategy,
              "firegrid.phase0b.replay.index": seq,
              "firegrid.phase0b.replay.head": seq,
            },
          }),
        )
      }))

    const c = yield* Ref.get(counters)
    const amplification = distinctOutputs === 0 ? 0 : c.logReads / distinctOutputs
    const oOutputs = amplification <= AMPLIFICATION_THRESHOLD
      && c.deliveries === distinctOutputs
      && c.turnCompleteDeliveries === 1
    const result: StrategyCounters = {
      strategy,
      distinctOutputs,
      replays: distinctOutputs,
      logReads: c.logReads,
      observeAttempts: c.observeAttempts,
      cursorAdvances: c.cursorAdvances,
      deliveries: c.deliveries,
      turnCompleteDeliveries: c.turnCompleteDeliveries,
      amplification,
      oOutputs,
    }
    yield* Effect.annotateCurrentSpan({
      "firegrid.phase0b.strategy": strategy,
      "firegrid.phase0b.distinct_outputs": distinctOutputs,
      "firegrid.phase0b.replays": result.replays,
      "firegrid.phase0b.log_reads": result.logReads,
      "firegrid.phase0b.observe_attempts": result.observeAttempts,
      "firegrid.phase0b.cursor_advances": result.cursorAdvances,
      "firegrid.phase0b.deliveries": result.deliveries,
      "firegrid.phase0b.turn_complete_deliveries": result.turnCompleteDeliveries,
      "firegrid.phase0b.amplification": result.amplification,
      "firegrid.phase0b.o_outputs": result.oOutputs,
    })
    return result
  }).pipe(
    Effect.withSpan("firegrid.phase0b.oracle.strategy", {
      attributes: {
        "firegrid.phase0b.strategy": strategy,
        "firegrid.phase0b.distinct_outputs": distinctOutputs,
      },
    }),
  )

type OracleVerdict =
  | "GREEN-ORACLE-VALID" // candidate satisfies O(outputs), specimen violates it
  | "RED-PRIMITIVE-INSUFFICIENT" // candidate fails the invariant
  | "RED-ORACLE-TOOTHLESS" // specimen passes -> the oracle cannot detect the class

interface SweepPoint {
  readonly distinctOutputs: number
  readonly specimenAmplification: number
  readonly candidateAmplification: number
}

export interface OracleResult {
  readonly verdict: OracleVerdict
  readonly threshold: number
  readonly primaryDistinctOutputs: number
  readonly specimen: StrategyCounters
  readonly candidate: StrategyCounters
  readonly sweep: ReadonlyArray<SweepPoint>
}

const PRIMARY_DISTINCT_OUTPUTS = 16
const SWEEP_SIZES = [4, 8, 16, 32, 64] as const

/**
 * The oracle: prove the candidate primitive holds the O(outputs) invariant
 * while the specimen (today's shape) violates it, and show the specimen's
 * read cost scales with turn length while the candidate's stays flat at ~1.
 */
export const runOutputReplayOracle: Effect.Effect<OracleResult> = Effect.gen(
  function*() {
    // Primary run emits per-read spans so the trace carries the storm evidence.
    const specimen = yield* runStrategy("specimen", PRIMARY_DISTINCT_OUTPUTS, true)
    const candidate = yield* runStrategy("candidate", PRIMARY_DISTINCT_OUTPUTS, true)

    // Parametric sweep (summary only) shows the scaling shape.
    const sweep = yield* Effect.forEach(SWEEP_SIZES, size =>
      Effect.gen(function*() {
        const s = yield* runStrategy("specimen", size, false)
        const c = yield* runStrategy("candidate", size, false)
        return {
          distinctOutputs: size,
          specimenAmplification: s.amplification,
          candidateAmplification: c.amplification,
        } satisfies SweepPoint
      }))

    const verdict: OracleVerdict = !candidate.oOutputs
      ? "RED-PRIMITIVE-INSUFFICIENT"
      : specimen.oOutputs
      ? "RED-ORACLE-TOOTHLESS"
      : "GREEN-ORACLE-VALID"

    yield* Effect.annotateCurrentSpan({
      "firegrid.phase0b.verdict": verdict,
      "firegrid.phase0b.threshold": AMPLIFICATION_THRESHOLD,
      "firegrid.phase0b.primary_distinct_outputs": PRIMARY_DISTINCT_OUTPUTS,
      "firegrid.phase0b.specimen.amplification": specimen.amplification,
      "firegrid.phase0b.specimen.o_outputs": specimen.oOutputs,
      "firegrid.phase0b.candidate.amplification": candidate.amplification,
      "firegrid.phase0b.candidate.o_outputs": candidate.oOutputs,
    })

    return {
      verdict,
      threshold: AMPLIFICATION_THRESHOLD,
      primaryDistinctOutputs: PRIMARY_DISTINCT_OUTPUTS,
      specimen,
      candidate,
      sweep,
    }
  },
).pipe(
  Effect.withSpan("firegrid.phase0b.oracle.run"),
)
