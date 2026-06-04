# tf-n3qc — Fluent Runtime substrate-assumption verification

Status: source-verified (no trace yet; in-process source read + dist inspection)
Date: 2026-06-04
Author: peer validator lane (Agent2)
Related: `docs/sdds/SDD_FLUENT_RUNTIME_WORKBENCH.md`, PR #925
(`codex/fluent-firegrid-engine-extract`), `docs/findings/tf-n3qc-fluent-firegrid-design.md`

This finding validates two things the fluent-runtime plan rests on: (A) that
PR #925's engine split is behavior-preserving and sets up the Awaitable seam,
and (B) that the five Durable Streams substrate commitments in the SDD's
"Recommended tiny-firegrid proof sequence" are real and reachable with the
substrate actually in this repo.

Epistemic tier: **source-verified** (read of split modules vs the pre-split
monolith; read of `@durable-streams/server` 0.3.1 dist + 0.3.7 dist; read of
`packages/effect-durable-streams` wrapper). No simulation trace was produced;
the proof-sequence sims remain to be authored.

## A. PR #925 engine split — behavior-preserving: YES

Normalized line-set diff of the pre-split `index.ts` (1112 lines) against the
concatenated split modules shows the only deltas are:

1. `export` keywords added to symbols that now cross module boundaries
   (`Scheduler`, `makePrimitive`, `operationTag`, schemas, types, etc.).
2. The ten per-free-function guard blocks
   (`const scheduler = currentScheduler; if (scheduler === undefined) throw …`)
   collapsed into one shared `requireScheduler(name)` helper in `free.ts`. The
   resulting error message is **identical**: `requireScheduler("run")` yields
   `"run() must be called inside execute(ctx, gen(...))"`, matching the prior
   per-function literal.

The `Scheduler` class body is otherwise moved verbatim. No control-flow or
journal-logic change. The current-fiber slot is now a single module-global in
`current.ts` (one copy → singleton invariant preserved).

### Awaitable-seam readiness — partial, and the SDD's own acceptance bar is
### split across two PRs

The SDD's "Action 1 Acceptance check" says *"`scheduler.ts` imports nothing from
Durable Streams and has no journal replay or append logic."*

- Import-level: **PASS**. `scheduler.ts` imports only `effect` + sibling engine
  modules. The concrete `effect-durable-streams` dependency is now isolated to
  `execute.ts` (composition root) and `schema.ts` (type aliases
  `JournalStream`/`JournalEvent`). `scheduler.ts` depends only on those types.
- Logic-level: **FAIL (expected)**. `Scheduler.run/sleep/raceIndexed` still hold
  replay lookup (`this.events.find(isStepSucceeded …)`) and append
  (`this.stream.append({type:"StepSucceeded" …})`). A *behavior-preserving* split
  (Migration-plan step 1) cannot remove that — removing it is Action 2 (move
  journaling behind Awaitable), which is Agent1's stacked
  `codex/fluent-firegrid-awaitable-seam` branch.

**Calibration:** apply the Action-1 acceptance bar to the awaitable-seam branch,
not to #925. #925 is a clean step-1. The SDD wording conflates "extract files"
(step 1) with "weld broken" (the Action-1 acceptance check, really step 3).

### What Action 2 must unpick (coupling notes for Agent1)

- **`nextStepIndex` is the determinism contract.** Deterministic step keys
  (`${nextStepIndex}:${name}`) are assigned in `Scheduler.run/sleep/race/select`.
  Whatever owns journal-backed awaitable production must own this counter and
  preserve identical key-assignment order, or replay desyncs.
- **`raceIndexed` mixes two concerns:** durable winner record
  (`RaceCompleted.winnerIndex` replay/append) **and** the actual concurrency
  (`Deferred` + `Effect.forkDaemon`). The SDD Action 4 flags exactly this:
  fluent-firegrid leans on Effect fibers, where Restate uses one central await
  point for clean cancellation fanout. The Awaitable seam (Action 2) can land
  while keeping the Effect-fiber race; the central-await rework is a separate
  Action-4 decision.
- **`any()` has no journaled winner.** `race`/`select` journal `RaceCompleted`;
  `any()` loops `raceIndexed` *without* a replay key, so its resolution is **not
  replay-stable** when multiple futures fulfill with different values. Pre-existing
  (preserved by the split), but it is a real replay-determinism gap to resolve in
  the durable model. Candidate proof-sequence sim.
- **Replay reads to up-to-date, not closed.** `execute.ts` uses
  `journal.collect`, which is `catchUpAll` (stops at `Stream-Up-To-Date` or
  `Stream-Closed`). The engine never closes the journal — it is an open replay
  log. That is the exact terminal-detection anti-pattern the SDD warns against;
  fine for the in-process workbench, but the "turn completion = stream closure"
  model is **not yet implemented** in fluent-firegrid.

## B. Substrate-commitment verifiability matrix

| # | SDD commitment | Real? | Exercisable now? |
|---|---|---|---|
| 1 | Fork child inherits parent history to fork offset, then diverges | YES | **YES, today** |
| 2 | Turn completion = `Stream-Closed`, not `Stream-Up-To-Date` | YES | **YES, today** |
| 3 | Idempotent producer restart reads back before redo | YES | **YES, today** |
| 4 | Pull-wake claim/ack/release for harness re-drive | YES | **needs server bump** |
| 5 | Webhook auto-ack on `{done:true}` | YES | **needs server bump** |

### The pin gap (the headline)

The repo vendors **`@durable-streams/server@0.3.1`**, which has **no subscription
manager** (zero matches for subscription/webhook/pull-wake/claim/ack in its dist).
The subscription substrate was added in upstream **PR #361 ("feat(server): add
reserved subscription APIs", MERGED 2026-05-25)** and is **published** — latest is
**0.3.7**, whose dist contains the full surface (subscription ×259, webhook ×52,
pull-wake ×12, claim ×4, autoAck ×2). PR #361 reserves `/v1/stream/__ds/*` for
subscription control, implements webhook + pull-wake lifecycle, callback ack, and
pull-wake claim/ack/release, with Ed25519 + JWKS webhook signatures.

→ **Commitments #4 and #5 are not exercisable against the pinned 0.3.1, but are
unlocked by bumping `@durable-streams/server` 0.3.1 → 0.3.7.** The SDD cites
`subscription-manager.ts lines 543-619` as source-verified; that file is **not in
this repo** (it lives in the upstream server, not vendored). Local verification of
#4/#5 requires the bump.

### Commitments 1–3 are reachable today — wire details

- **Fork (1):** server 0.3.1 already reads PUT headers `Stream-Forked-From` and
  `Stream-Fork-Offset` (offset format `\d+_\d+`; default = source `currentOffset`;
  child validated within source range; source `refCount` incremented). The
  `effect-durable-streams` `create()` wrapper has **no typed fork option**, but it
  forwards `opts.headers` (`callHeaders`) verbatim to the PUT — so a sim can fork
  **today** via `create({ headers: { "stream-forked-from": parentPath,
  "stream-fork-offset": offset } })`, no raw HTTP and no in-process store access.
  Matches the SDD's "send fork headers directly at first, then promote to a
  wrapper helper." A first-class wrapper helper is the natural follow-up.
- **Closure (2):** wrapper `close()` POSTs `streamClosed:true` and `append()`
  fails with `StreamClosed` after close; `Read.ts` distinguishes `upToDate` vs
  `streamClosed`. Fully present.
- **Atomic append-and-close (2, hard SDD requirement):** the **server** supports
  it (`AppendOptions { close?: boolean }`, and `close()` POST carries an optional
  body). But the **typed `append()` wrapper does not expose `close`** — only
  `close()` does, and `close()` takes a *raw* body, bypassing the schema-encode
  path that `append()` uses. So writing a *schema-typed terminal event atomically
  with closure* currently requires either hand-encoding into `close({body})` or a
  wrapper enhancement (`append({…, close:true})`). This is a concrete gap for the
  journal-backed Awaitable's "append-and-close for finite turn/result streams."
- **Idempotent producers (3):** `appendWithProducer` + `Producer-Id/Epoch/Seq`,
  `StaleEpoch` (403) fencing, `SequenceGap` (409), and `{_tag:"Duplicate"}` on a
  204 replay are all present — the readback-before-redo mechanism exists.

## Proof-sequence sims 1–3 — EXECUTED (trace evidence)

Three `launchHost: false` substrate workbenches authored and run against the
embedded `@durable-streams/server@0.3.1` (raw-wire `fetch` probes, the
restate-primitive-compat idiom; markers asserted as substrings, robust to
framing). All emit observation spans only — no verdict objects. Gates green:
ESLint, typecheck (only pre-existing `@firegrid/host-sdk` errors elsewhere),
dep-cruiser airgap.

### #1 `fork-child-session-substrate` → commitment #1 CONFIRMED
- Fork PUT (`Stream-Forked-From` + `Stream-Fork-Offset`) → **201**.
- Child read inherited `PARENT_A` + `PARENT_B` but **NOT** `PARENT_C` (appended
  past the fork offset) → inherits parent history *to the fork offset*. Boundary
  is **exclusive**: fork offset = parent next-offset after B; child saw offsets
  `< forkOffset`.
- After child-only `CHILD_D`: child = A+B+D (divergence); parent = A+B+C with
  **no `CHILD_D` leak** (isolation).
- **Footgun discovered:** the server keys streams by full request pathname
  (`url.pathname`), so `Stream-Forked-From` must carry the full
  `/v1/stream/<path>`, not the bare stream id (a bare id → `404 Source stream not
  found`). The future typed `fork()` helper / fluent-runtime `Store.ts` must use
  the full pathname.

### #2 `stream-closure-substrate` → commitment #2 CONFIRMED
- Caught-up-but-open read: `stream-up-to-date` present, `stream-closed` absent,
  terminal marker absent → **up-to-date is NOT terminal** (a re-driver stopping
  here would wrongly conclude "turn done").
- Terminal write via **atomic append-and-close** (one POST with body +
  `Stream-Closed: true`) → 204; subsequent read shows `stream-closed: true` +
  terminal marker present → **closure is the terminal signal**.
- Append after close → **409 "Stream is closed"** (closed stream rejects writes).
- Caveat from §B: the typed `append()` wrapper still can't do this in one call;
  the sim used a raw POST. Wrapper enhancement (`append({close:true})`) remains.

### #3 `idempotent-producer-substrate` → commitment #3 CONFIRMED
- First write `(id, epoch 1, seq 0)` → 200 Appended; **re-sent identical
  `(id,epoch,seq)` → 204 Duplicate**; read-back shows the side-effect marker
  **exactly once** → retry safety / no double-write on replay.
- Lower epoch `(epoch 0)` → **403** (zombie fencing).
- Sequence gap `(seq 9 when expected 2)` → **409** (ordering enforced).
- **Detail discovered:** producer seq is **0-based** (server reports
  `expected_seq=0` for the first append) — the fluent-runtime journal writer's
  seq counter must start at 0.

Net: commitments #1–#3 are real and behave as the SDD asserts, now with trace
evidence. #4/#5 remain blocked on the 0.3.1→0.3.7 server bump.

## Recommended next actions

1. **Author proof-sequence sims 1–3 now** (fork inheritance+divergence; closure
   vs up-to-date terminal detection; idempotent-producer restart readback) against
   the pinned 0.3.1 — no blockers. These are substrate workbenches
   (`launchHost:false`), like the existing `restate-primitive-compat`.
2. **Bump `@durable-streams/server` → 0.3.7** to unlock sims 4–5. The
   `effect-durable-streams` wrapper has no subscription/webhook API, so #4/#5 need
   either raw HTTP to `/v1/stream/__ds/*` or new wrapper helpers — a coordinator/PO
   call (wrapper scope vs raw-HTTP-in-sim).
3. **Calibrate the SDD Action-1 acceptance check** to point at the awaitable-seam
   branch, not #925.

## Decisions for coordinator / PO

- Server bump 0.3.1 → 0.3.7 (unblocks #4/#5; verify no breaking wire change first).
- Wrapper scope: add typed `append({close:true})`, a `fork()` helper, and
  subscription/webhook helpers — or keep sims on header/raw-HTTP passthrough until
  fluent-runtime's `Store.ts` promotes them.
- `any()` replay-determinism: journal a winner, or accept first-fulfilled-by-
  completion-order as non-durable — needs a stated contract.
