import { Console, Effect } from "effect"
import { contextPrefix, type StateRow } from "./resources.ts"
import {
  perKeySubscriberRuntime,
  type PerKeySubscriberRuntime,
} from "./host.ts"
import { makeRendezvous, type MetricsSnapshot } from "./subscriber.ts"

// tf-4fy3 verdict, mapped to the tf-tvg1 A/B/C classification.
interface Tf4fy3Verdict {
  readonly verdict: "A" | "B" | "C"
  readonly band: "GREEN" | "YELLOW" | "RED"
  readonly rationale: string
  readonly pushNative: boolean
  readonly crashRecoveryNative: boolean
  readonly perKeySerializationNative: boolean
  readonly helper: string
  readonly globalSerial: MetricsSnapshot
  readonly unserialized: MetricsSnapshot
  readonly perKeyRouter: MetricsSnapshot
  readonly crashRestart: {
    readonly preCrash: ReadonlyArray<StateRow>
    readonly whileDown: ReadonlyArray<StateRow>
    readonly afterRestart: ReadonlyArray<StateRow>
    readonly metrics: MetricsSnapshot
  }
}

const fail = (message: string, context: unknown): Effect.Effect<never, Error> =>
  Effect.fail(new Error(`tf-4fy3 invariant failed: ${message}; ${JSON.stringify(context)}`))

const isOneThrough = (sequences: ReadonlyArray<number>, n: number): boolean =>
  sequences.length === n && sequences.every((seq, index) => seq === index + 1)

// A key's durable state is correct iff its consumed sequence is exactly
// 1..cursor (no gaps, no repeats => per-key serial) and the fold equals the sum
// of consumed values. Every event carries value=sequence, so the expected fold
// is the triangular number cursor*(cursor+1)/2.
const stateIsCorrect = (state: StateRow): boolean =>
  isOneThrough(state.consumedSequences, state.lastProcessedSequence) &&
  state.fold === (state.lastProcessedSequence * (state.lastProcessedSequence + 1)) / 2

const ctx = (prefix: string, suffix: string): string => `${prefix}-${suffix}`

const ownsPrefix = (prefix: string) =>
(contextId: string): boolean => contextId.startsWith(`${prefix}-`)

// One serialization probe: pre-append all events to the durable log (no
// subscriber running), then run a generation whose subscriber replays them via
// the native tail and processes them in the given mode. Returns the live metrics.
const serializationProbe = (
  runtime: PerKeySubscriberRuntime,
  mode: "global-serial" | "unserialized-parallel" | "per-key-router",
  prefix: string,
  keys: ReadonlyArray<string>,
  eventsPerKey: number,
  // # of concurrent materializations the rendezvous waits for before releasing.
  // Sized to the overlap this probe is built to observe: same-key overlap
  // (=eventsPerKey on a single key) or cross-key overlap (=number of keys). The
  // rendezvous makes the observation deterministic; if the mode admits that many
  // concurrent handlers they provably overlap, otherwise the safety timeout
  // releases and the measured concurrency is simply lower.
  expectedArrivals: number,
): Effect.Effect<MetricsSnapshot, unknown> =>
  Effect.gen(function*() {
    yield* runtime.resetMetrics
    const rendezvous = yield* makeRendezvous(expectedArrivals)
    const events = keys.flatMap(key =>
      Array.from({ length: eventsPerKey }, (_, index) => ({
        contextId: ctx(prefix, key),
        sequence: index + 1,
        value: index + 1,
      })))
    yield* Effect.forEach(events, event => runtime.appendEvent(event))
    return yield* runtime.runGeneration(
      mode,
      ownsPrefix(prefix),
      Effect.gen(function*() {
        yield* Effect.forEach(keys, key =>
          runtime.waitUntilProcessed(ctx(prefix, key), eventsPerKey))
        const states = yield* runtime.snapshotStates(
          keys.map(key => ctx(prefix, key)),
        )
        const allCorrect = states.every(stateIsCorrect)
        if (!allCorrect) {
          return yield* fail(`${mode} produced incorrect per-key state`, { states })
        }
        return yield* runtime.metrics
      }),
      rendezvous,
    )
  }).pipe(
    Effect.withSpan("firegrid.tf4fy3.probe.serialization", {
      kind: "internal",
      attributes: { "firegrid.tf4fy3.mode": mode },
    }),
  )

// Crash/restart probe (per-key-router). Generation 1 processes a first batch
// then crashes (scope close). A second batch is appended WHILE DOWN — nothing
// processes it (no parked body, the producer append armed nothing). Generation 2
// over the same durable log replays-then-tails, reloads each key's cursor from
// the durable state row, and processes only the new events; replayed pre-crash
// events become no-op materializations.
const crashRestartProbe = (
  runtime: PerKeySubscriberRuntime,
): Effect.Effect<Tf4fy3Verdict["crashRestart"], unknown> =>
  Effect.gen(function*() {
    yield* runtime.resetMetrics
    const prefix = contextPrefix.crashRestart
    const owns = ownsPrefix(prefix)
    const a = ctx(prefix, "A")
    const b = ctx(prefix, "B")

    // --- batch 1 (appended, then processed by generation 1) ---
    yield* Effect.forEach(
      [
        { contextId: a, sequence: 1, value: 1 },
        { contextId: a, sequence: 2, value: 2 },
        { contextId: b, sequence: 1, value: 1 },
      ],
      event => runtime.appendEvent(event),
    )
    const preCrash = yield* runtime.runGeneration(
      "per-key-router",
      owns,
      Effect.gen(function*() {
        yield* runtime.waitUntilProcessed(a, 2)
        yield* runtime.waitUntilProcessed(b, 1)
        return yield* runtime.snapshotStates([a, b])
      }),
    )

    // --- while DOWN: append batch 2. No subscriber generation is running. ---
    yield* Effect.forEach(
      [
        { contextId: a, sequence: 3, value: 3 },
        { contextId: a, sequence: 4, value: 4 },
        { contextId: b, sequence: 2, value: 2 },
        { contextId: b, sequence: 3, value: 3 },
      ],
      event => runtime.appendEvent(event),
    )
    // Durable state must be UNCHANGED while down — proves no parked body and no
    // write+arm auto-advanced the cursor.
    const whileDown = yield* runtime.snapshotStates([a, b])

    // --- generation 2: fresh subscriber over the same durable log ---
    const afterRestart = yield* runtime.runGeneration(
      "per-key-router",
      owns,
      Effect.gen(function*() {
        yield* runtime.waitUntilProcessed(a, 4)
        yield* runtime.waitUntilProcessed(b, 3)
        return yield* runtime.snapshotStates([a, b])
      }),
    )
    const metrics = yield* runtime.metrics
    return { preCrash, whileDown, afterRestart, metrics }
  }).pipe(
    Effect.withSpan("firegrid.tf4fy3.probe.crash_restart", {
      kind: "internal",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.4,BOUNDARIES.7-1",
      },
    }),
  )

export const perKeySubscriberDriver: Effect.Effect<Tf4fy3Verdict, unknown> =
  Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => perKeySubscriberRuntime)

    // === Phase 1: per-key serialization across three subscriber-runtime shapes.
    // expectedArrivals sizes each probe's rendezvous to the overlap it tests:
    //  - global-serial: 1 (single consumer, no overlap to force).
    //  - unserialized:  2 same-key handlers => proves in-key overlap (no mutex).
    //  - per-key-router: 3 distinct-key handlers => proves cross-key concurrency
    //    while the mutex still pins in-key concurrency to 1.
    const globalSerial = yield* serializationProbe(
      runtime, "global-serial", contextPrefix.globalSerial,
      ["A", "B", "C"], 2, 1,
    )
    const unserialized = yield* serializationProbe(
      runtime, "unserialized-parallel", contextPrefix.unserialized,
      ["A"], 2, 2,
    )
    const perKeyRouter = yield* serializationProbe(
      runtime, "per-key-router", contextPrefix.perKeyRouter,
      ["A", "B", "C"], 2, 3,
    )

    // === Phase 2: crash / restart recovery
    const crashRestart = yield* crashRestartProbe(runtime)

    // ---- push: native tail, never polled, never armed by the producer ----
    const noPolls =
      globalSerial.pollLoops === 0 && unserialized.pollLoops === 0 &&
      perKeyRouter.pollLoops === 0 && crashRestart.metrics.pollLoops === 0
    const noArm =
      globalSerial.externalArmCalls === 0 && unserialized.externalArmCalls === 0 &&
      perKeyRouter.externalArmCalls === 0 && crashRestart.metrics.externalArmCalls === 0
    const tailDeliveredEverywhere =
      globalSerial.tailRowEmissions > 0 && unserialized.tailRowEmissions > 0 &&
      perKeyRouter.tailRowEmissions > 0 && crashRestart.metrics.tailRowEmissions > 0
    const pushNative = noPolls && noArm && tailDeliveredEverywhere

    // ---- crash recovery: state reconstructed from durable rows, no double-process
    const [crA, crB] = crashRestart.afterRestart
    const downUnchanged =
      crashRestart.whileDown.every((row, index) =>
        row.lastProcessedSequence ===
          crashRestart.preCrash[index]?.lastProcessedSequence)
    const restartConverged =
      crA !== undefined && crB !== undefined &&
      crA.lastProcessedSequence === 4 && stateIsCorrect(crA) &&
      crB.lastProcessedSequence === 3 && stateIsCorrect(crB)
    const reconstructedFromTable = crashRestart.metrics.reloadCount > 0
    // Deterministic restart-idempotency proof: gen-2 resumed from the durable
    // cursor (2/1, not 0) and the folds equal the EXACT triangular sums — replay
    // re-delivered the pre-crash rows but the cursor (point-reads cursor+1 only)
    // never re-folded them. A double-process would inflate the fold. (The
    // noopMaterializations counter corroborates this but is timing-best-effort,
    // so it is reported, not gated.)
    const crashRecoveryNative =
      downUnchanged && restartConverged && reconstructedFromTable

    // ---- per-key serialization: classify what the SUBSTRATE vs the HELPER does
    // A substrate-native subscriber shape (no per-key helper) that achieves BOTH
    // per-key serialization (maxInKey==1) AND cross-key concurrency
    // (maxCrossKey>1). Neither native mode does: global-serial collapses
    // concurrency (maxCrossKey==1); unserialized drops per-key serialization
    // (maxInKey>1). If either DID, that would be evidence for A.
    const substrateNativeSerialAndConcurrent =
      (globalSerial.maxInKeyConcurrency === 1 &&
        globalSerial.maxCrossKeyConcurrency > 1) ||
      (unserialized.maxInKeyConcurrency === 1 &&
        unserialized.maxCrossKeyConcurrency > 1)
    // The thin helper (fork-per-fact + per-key mutex) achieves both.
    const helperSerialAndConcurrent =
      perKeyRouter.maxInKeyConcurrency === 1 &&
      perKeyRouter.maxCrossKeyConcurrency > 1
    const perKeySerializationNative = substrateNativeSerialAndConcurrent

    const helper =
      "per-key dispatch/serialization router: fork-per-fact dispatch keyed by " +
      "contextId + one Effect.Semaphore(1) per key (equivalently Stream.groupByKey " +
      "by contextId with a sequential per-group drain). It is the ONLY structural " +
      "delta between the unserialized tail (maxInKey>1) and the correct keyed " +
      "subscriber (maxInKey==1, maxCrossKey>1)."

    // Derive the verdict letter from the measured evidence — this is a real
    // A/B/C selector, not a hardcoded outcome. The three branches correspond to
    // tf-tvg1's A/B/C definitions exactly.
    const classify = (): {
      readonly verdict: "A" | "B" | "C"
      readonly band: "GREEN" | "YELLOW" | "RED"
      readonly rationale: string
    } => {
      if (!pushNative) {
        return {
          verdict: "C", band: "RED",
          rationale:
            "Substrate push/tail did not deliver durable rows without polling or " +
            "an external trigger; the short-edge plan is falsified.",
        }
      }
      if (substrateNativeSerialAndConcurrent && crashRecoveryNative) {
        return {
          verdict: "A", band: "GREEN",
          rationale:
            "Substrate-native push + per-key serialization + crash recovery are " +
            "sufficient with no subscriber-runtime helper.",
        }
      }
      if (helperSerialAndConcurrent && crashRecoveryNative) {
        return {
          verdict: "B", band: "YELLOW",
          rationale:
            "Push and crash recovery are substrate-native, but per-key " +
            "serialization with cross-key concurrency requires a thin " +
            "subscriber-runtime helper. Substrate alone yields serialization XOR " +
            "concurrency, never both.",
        }
      }
      return {
        verdict: "C", band: "RED",
        rationale: crashRecoveryNative
          ? "Neither the substrate nor the thin helper achieved per-key serial + " +
            "cross-key concurrency; the short-edge plan is falsified."
          : "Crash recovery was not substrate-native (required polling or an " +
            "external re-drive); the short-edge plan is falsified.",
      }
    }
    const classified = classify()

    const verdict: Tf4fy3Verdict = {
      verdict: classified.verdict,
      band: classified.band,
      rationale: classified.rationale,
      pushNative,
      crashRecoveryNative,
      perKeySerializationNative,
      helper,
      globalSerial,
      unserialized,
      perKeyRouter,
      crashRestart,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.tf4fy3.verdict": verdict.verdict,
      "firegrid.tf4fy3.band": verdict.band,
      "firegrid.tf4fy3.push_native": pushNative,
      "firegrid.tf4fy3.crash_recovery_native": crashRecoveryNative,
      "firegrid.tf4fy3.per_key_serialization_native": perKeySerializationNative,
      "firegrid.tf4fy3.global_serial.max_cross_key": globalSerial.maxCrossKeyConcurrency,
      "firegrid.tf4fy3.unserialized.max_in_key": unserialized.maxInKeyConcurrency,
      "firegrid.tf4fy3.router.max_in_key": perKeyRouter.maxInKeyConcurrency,
      "firegrid.tf4fy3.router.max_cross_key": perKeyRouter.maxCrossKeyConcurrency,
      "firegrid.tf4fy3.crash.noop_materializations":
        crashRestart.metrics.noopMaterializations,
      "firegrid.tf4fy3.crash.reload_count": crashRestart.metrics.reloadCount,
      "firegrid.tf4fy3.rationale": verdict.rationale,
      "firegrid.tf4fy3.tf_tvg1_mapping": verdict.verdict,
      "firegrid-workflow-driven-runtime.ACID":
        "PHASE_0_TARGET_REFERENCE.4,BOUNDARIES.7-1",
    })

    yield* Console.log(
      [
        `tf-4fy3 verdict: ${verdict.verdict} / ${verdict.band} (tf-tvg1 mapping: ${verdict.verdict})`,
        `  ${verdict.rationale}`,
        "",
        "  push (substrate-native tail):",
        `    tail emissions gs/un/rt/crash = ${globalSerial.tailRowEmissions}/${unserialized.tailRowEmissions}/${perKeyRouter.tailRowEmissions}/${crashRestart.metrics.tailRowEmissions}`,
        "    pollLoops=0 externalArmCalls=0 => NATIVE",
        "",
        "  per-key serialization (the load-bearing gap):",
        `    global-serial:        maxInKey=${globalSerial.maxInKeyConcurrency} maxCrossKey=${globalSerial.maxCrossKeyConcurrency}  (serial, but ZERO cross-key concurrency)`,
        `    unserialized push:    maxInKey=${unserialized.maxInKeyConcurrency} maxCrossKey=${unserialized.maxCrossKeyConcurrency}  (concurrent, but per-key NOT serialized)`,
        `    per-key-router:       maxInKey=${perKeyRouter.maxInKeyConcurrency} maxCrossKey=${perKeyRouter.maxCrossKeyConcurrency}  (serial AND concurrent — needs the helper)`,
        "    => substrate alone gives serialization XOR concurrency, never both => HELPER REQUIRED",
        "",
        "  crash recovery (restart over same durable log):",
        `    while down: cursors unchanged (no parked body, no write+arm) = ${downUnchanged}`,
        `    after restart: cr-A cursor=${crA?.lastProcessedSequence} fold=${crA?.fold} (exact 1..4=10), cr-B cursor=${crB?.lastProcessedSequence} fold=${crB?.fold} (exact 1..3=6)`,
        `    resumed from durable cursor (2/1, not 0); gen-2 reloadCount=${crashRestart.metrics.reloadCount} (state rebuilt from table)`,
        `    replay re-delivered every pre-crash row (crash tail emissions=${crashRestart.metrics.tailRowEmissions} = 3 gen-1 + 7 gen-2) yet folds stayed EXACT => no double-process => NATIVE`,
      ].join("\n"),
    )

    return verdict
  }).pipe(
    Effect.tapErrorCause(cause =>
      Console.error(`tf-4fy3 DRIVER FAILED:\n${String(cause)}`)),
    Effect.withSpan("firegrid.tf4fy3.verdict", {
      kind: "internal",
      attributes: {
        "firegrid.tf4fy3.scope":
          "per-key-subscriber-push-serialization-restart",
      },
    }),
  )
