# tf-4fy3 Finding — per-key subscriber: push, serialization, restart

Scope: tiny-firegrid clean-room proof for tf-tvg1. Not production bridge work.

## Verdict

**Outcome B evidence** (tf-tvg1 mapping: B / YELLOW).

This sim is a B-confirmatory harness for tf-tvg1, **not an independent A/B/C
selector**. It measures one substrate (DurableTable over Durable Streams) under
one subscriber-runtime style (fork-per-fact + per-key mutex) and answers: "does
this specific shape, on this substrate, hold up?" The answer is yes — the
short-edge plan survives the test with a thin subscriber-runtime helper.

The aggregate A/B/C synthesis for tf-tvg1 must combine this finding with the
other proof beads (`tf-u8w2` fact matrix without dense scan, `tf-1r0o` directory
topology + R-shape, `tf-28b8` Shape D workflow admission boundaries). A different
proof showing the substrate native-delivers per-key serialization with cross-key
concurrency would shift tf-tvg1 to A; a proof that push/tail fails for some
production-required event class would shift it to C. tf-4fy3 alone cannot make
either claim.

What this sim does establish:

- Substrate push (`DurableTable.events.rows()` replay-then-tail) delivers
  durable rows without polling or external write+arm.
- Crash recovery (replay-then-tail + durable per-key cursor) is substrate-native
  for this subscriber shape.
- Per-key serialization with cross-key concurrency is **not** delivered by the
  substrate alone; it requires a thin subscriber-runtime helper: fork-per-fact
  dispatch keyed by `contextId` plus one `Effect.Semaphore(1)` per key
  (equivalently `Stream.groupByKey` by contextId with a sequential per-group
  drain).

The `classify()` function in the driver encodes the mechanical refutations
below — given different measurements it would emit a different letter — but
those branches document falsification surfaces of *this* sim, not an
independent A/B/C judgement.

## Load-bearing constraint observed

The substrate alone gives **serialization XOR cross-key concurrency, never both**:

| mode                  | maxInKey | maxCrossKey | shape                                     |
|-----------------------|---------:|------------:|-------------------------------------------|
| global-serial         |        1 |           1 | one consumer, serial, no cross-key parallelism |
| unserialized-parallel |    **2** |           1 | fork-per-fact, no per-key mutex — IN-KEY OVERLAP |
| per-key-router        |        1 |       **3** | fork-per-fact + per-key `Semaphore(1)` — correct |

The contrast `unserialized.maxInKey=2` vs `router.maxInKey=1` isolates the
**one** structural delta: a per-key mutex around `drainKey`. That mutex is the
thin subscriber-runtime helper B names.

This maps directly to `runtime-design-constraints.md` C1 ("Sessions Are Keyed
Durable State Containers — all mutations for the same key are serialized by the
runtime owner") and C2 ("Handlers Are State/Event Reducers, Not Long-Lived
Bodies"). The substrate guarantees per-key write ordering via primary-key
producer fencing (`producerId = durable-table:<type>:<encodedKey>`), but it does
not guarantee per-key handler-execution serialization on the subscriber side —
that is a subscriber-runtime concern.

## Evidence path / trace

- Source:
  `packages/tiny-firegrid/src/simulations/per-key-subscriber-push-restart/`
  - `resources.ts` — events + per-key state DurableTable
  - `subscriber.ts` — three subscriber-runtime modes + handler + rendezvous
  - `host.ts` — persistent producer + per-generation fresh subscriber layer
  - `driver.ts` — three serialization probes + crash/restart probe + A/B/C
- Latest deterministic run:
  `2026-05-22T23-05-13-915Z__per-key-subscriber-push-restart` (5 consecutive
  runs returned identical metrics; load-bearing observations
  `unserialized.maxInKey=2` and `router.maxCrossKey=3` are deterministic via a
  per-probe arrival-rendezvous barrier, not a sleep window).
- Trace:
  `packages/tiny-firegrid/.simulate/runs/2026-05-22T23-05-13-915Z__per-key-subscriber-push-restart/trace.jsonl`
- Verdict span: `firegrid.tf4fy3.verdict`
  - `firegrid.tf4fy3.verdict` = `B`
  - `firegrid.tf4fy3.band` = `YELLOW`
  - `firegrid.tf4fy3.push_native` = `true`
  - `firegrid.tf4fy3.crash_recovery_native` = `true`
  - `firegrid.tf4fy3.per_key_serialization_native` = `false`
  - `firegrid.tf4fy3.tf_tvg1_mapping` = `B`
  - `firegrid.tf4fy3.unserialized.max_in_key` = `2`
  - `firegrid.tf4fy3.router.max_in_key` = `1`,
    `firegrid.tf4fy3.router.max_cross_key` = `3`
- Crash recovery deterministic proof: after gen-1 crash, gen-2 resumed from the
  durable cursor (cr-A: 2, cr-B: 1), processed only new events, and the folds
  equal the EXACT triangular sums (cr-A `fold=10=1+2+3+4`,
  cr-B `fold=6=1+2+3`). Any double-process would inflate the fold; replay re-
  delivered all 7 pre-crash rows via the tail (`crash tailRowEmissions=10`) yet
  the cursor (point-reads `cursor+1` only) absorbed them.
- Static guard pass: `grep -rnE
  "DurableDeferred|InputIntentDispatcher|writeAndArm|Workflow\.make|setInterval|setTimeout|Schedule\."`
  over the sim source returns zero matches (the bridge primitives forbidden by
  C2/C4/C5 are absent).
- Gate: `pnpm --filter @firegrid/tiny-firegrid typecheck` passes; eslint on the
  sim directory passes (0 errors, 0 warnings).

## What would refute the B-evidence claim

These are mechanical refutations of *this* sim's B verdict. Refuting them at
the aggregate tf-tvg1 level requires the parallel proofs as well.

- **Refute toward A (for this sim)** — any substrate-only subscriber shape in
  this sim reaches `maxInKeyConcurrency==1 && maxCrossKeyConcurrency>1` (right
  now neither does; global-serial gives `1,1` and unserialized gives `2,1`).
  An added native primitive — e.g. a `events.rows({ partitionBy: "contextId" })`
  that delivers per-key partitioned substreams with one consumer-per-partition
  wired to the TanStack subscription — would land an A locally. Aggregate A
  also requires the other proof beads to align.
- **Refute toward C (for this sim)** —
  - any production check shows `pollLoops > 0` or `externalArmCalls > 0` on the
    `DurableTable.rows()` path (i.e., the tail is actually a poll loop or a
    write+arm in disguise), OR
  - `tailRowEmissions == 0` despite appended rows (the tail does not deliver),
    OR
  - the gen-2 fold does not equal the exact triangular sum after restart (cursor
    semantics let replay double-process), OR
  - gen-2 cannot reach the post-restart cursor without an external trigger.
- **Sim-internal flake** — `unserialized.maxInKey == 1` while no helper is
  applied would refute the falsifier. The rendezvous barrier removes the
  timing-window dependency that earlier versions had (the
  `unserialized.maxInKey=2` observation has been deterministic across 5
  consecutive runs).

## Dependency the production rewrite has on this finding

This proof unblocks tf-tvg1's A/B/C synthesis and shapes the production rewrite
that follows it:

- **Adopt the helper, not a new bridge.** The production
  `RuntimeContextWorkflowNative` long-lived body and its per-sequence
  `DurableDeferred` input mailbox are replaced by:
  1. an events DurableTable as the durable ordered facts,
  2. a per-key state DurableTable as the keyed durable state container (C1),
  3. a subscriber-runtime that tails `events.rows()` and dispatches per
     `contextId` with a per-key mutex — `drainKey` is a (state, event) →
     newState reducer that materializes per fact and returns (C2).
- **No new primitive surface required.** No new protocol, schema, channel, or
  workflow identity; the helper is application code over the existing
  substrate, and is the same shape `tf-64lq` already proved native for a single
  key — generalized to multiple keys with a per-key serializer.
- **Sunsets the bridge inventory** dispatched against tf-vrz6 / tf-w6qj /
  tf-jpcg: write+arm, parked-body recovery sweeps, the input mailbox, dense
  output re-walks. None of these are needed for the per-key subscriber shape.
- **Does NOT require** a Restate-style or `groupByKey`-built-in primitive in
  the substrate; the verdict is B precisely because the gap is small and lives
  in user-space subscriber code.
- **Constraint check** (per runtime-design-constraints.md §SDD Gate):
  - C1 keyed durable state: complies (per-`contextId` state row).
  - C2 handler, not long-lived body: complies (drainKey materializes per
    materialization and returns).
  - C3 durable result identity: not applicable to this slice.
  - C4 durable completion / externally resolved wait: complies (no
    `DurableDeferred` for input arrival).
  - C5 no parked entity body: complies (between events the entity IS the
    state row).
  - C6 typed source observation: complies (`events.rows()` is a typed source
    with the cursor as a domain identity on the state row, not a stream
    coordinate).
  - C7 first-class schemas: complies (`EventRow` / `StateRow` versioned
    schemas).

## Open question deferred to tf-tvg1 synthesis

The thin helper is implemented here as application code per probe. Whether it
should be promoted to a host-sdk primitive (e.g. a `KeyedSubscriber.run({
events, ownsContext, handler })` utility) or stay per-app composition is a
tf-tvg1 / production-rewrite scoping question, not a tf-4fy3 question. The
B-verdict is independent of that decision: either way the substrate alone is not
enough; either way the structural delta is the per-key mutex over `drainKey`.
