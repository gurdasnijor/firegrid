# tf-ogoj — DurableDeferred + per-key serialization workbench (trace evidence)

- **Date:** 2026-06-02
- **Kind:** tiny-firegrid WORKBENCH finding. The trace is the deliverable; this prose
  interprets confirm/reject. No `claimStatus`/verdict object in the sim.
- **Sim:** `packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/`
- **Runs:** v1 (confounded) `2026-06-02T23-54-22-805Z`; **v2 (isolated, authoritative)
  `2026-06-03T00-34-47-402Z`** (`packages/tiny-firegrid/.simulate/runs/<runId>/trace.jsonl`)
- **Backs:** `docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md` §2.1 (the
  "`signal.ts` is a second implementation of the `WorkflowEngine` seam" reframe) and §2.4
  (per-`contextId` serialization).

## Calibration note — TWO confounds were caught and isolated (it took three runs)

This question defeated two successive attribution errors; the honest record:
- **v1 (`…23-54`)** measured a race in the **sim's own channel seq-assignment**
  (`nextSeq = count(rows)` then `insertOrGet`) — a workbench artifact, not production —
  and wrongly headlined "`idempotencyKey + cursor` doesn't serialize → data loss."
- **v2 (`…34-47`)** removed the input-log (cursor = only shared state) and saw a clean
  0,1,2,3,4 — but then **mis-attributed** it to "the durable-streams single-row transaction
  serializes the RMW." The trace refutes that mechanism: the body advanced the cursor
  *before* the ~270ms spawn, so the read→advance critical section was sub-millisecond, and
  the single-threaded Effect scheduler **staggered** the five bodies' cursor accesses ~0.2ms
  apart (each `get`→local-`set` completed before the next body's `get`). The accesses never
  overlapped, so serialization was never tested — same error class as v1 (attributing an
  observed ordering to a substrate guarantee without isolating timing). [coordinator review.]
- **v3 (`2026-06-03T00-59-28-645Z`, authoritative)** moves the cursor advance to **after**
  the spawn+send — the realistic per-event ordering (read position → do work → advance) —
  so the read→advance windows **overlap**. This finally tests the cursor under true
  concurrency. Result below.
- **v4 (this revision)** reconciled v3 against the substrate's actual guarantees and
  re-pointed the citations to verifiable in-repo `file:line` (an earlier draft cited an
  external `PROTOCOL.md` git-ref that does **not** resolve in this checkout, and misread the
  `producerId` derivation).

**The bankable calibration lesson:** across v1→v4 the *substance* stayed roughly right (the
per-event shape has a real per-`contextId` coordination cost), but the **source attribution
slipped four times** — sim-seq-race → scheduler-staggering → over-generalization ("the cursor
races") → a **phantom external doc citation**. Every slip was a *plausible* story attached to
*unverified* evidence. Rule going forward: **cite verifiable in-repo `file:line`, never an
external or remembered doc; and verify the timing/mechanism, not just the outcome.**

## H1 — `DurableDeferred` await-once rides the real engine — **CONFIRMED**

A `workbench.deferred-gate` workflow makes a `DurableDeferred`, awaits it, and a second
public prompt resolves it via `DurableDeferred.succeed(token)`. The round-trip runs on the
**real** `DurableStreamsWorkflowEngine`: `firegrid.workflow_engine.deferred.result`
(undefined → suspend) → `…deferred.done` (external resolve) → `…deferred.result` (resolved →
resume) → the body completes with the value (v2: `deferred.result`×2, `deferred.done`×1).
This makes §2.1 observable: the standard `@effect/workflow` combinator delegates to
`engine.deferredResult`/`engine.deferredDone` (`DurableDeferred.ts:114,176`), and Firegrid's
engine **implements that seam** (`engine-runtime.ts:433,458`). `signal.ts`'s
`awaitSignal`/`sendSignal` are a second implementation of it. **H1 confirms the reframe's
foundation.**

## H2 — per-`contextId` serialization under CONCURRENT inputs — **TWO real races, both confirmed**

Driver fires **6 concurrent** same-`contextId` prompts (`idempotencyKey` `h2-0..h2-5`,
`Effect.all({concurrency: "unbounded"})`). The v3 per-event body (keyed `(contextId,inputKey)`)
reads the cursor → `startOrAttach` → `send` → **advances the cursor last** (realistic
read-position / do-work / advance ordering). Trace facts (v3, `…00-59-28`):

**(1) The durable cursor RACES under true concurrency — lost updates.** With the advance now
*after* the ~270ms spawn, the five bodies' cursor `get`s all land at +0…+3.3 ms — **before any
`upsert`** (which now occur at +327…+371 ms). So **all five read `cursor_at_entry = 0`** and
all `upsert` `consumed = 1`:

| body | `cursor_at_entry` | `cursor_after` |
|---|---|---|
| h2-1 | 0 | 1 |
| h2-2 | 0 | 1 |
| h2-3 | 0 | 1 |
| h2-4 | 0 | 1 |
| h2-5 | 0 | 1 |
| terminal | 1 | 2 |

Five inputs "consumed" but the cursor reached **1** (then terminal → 2): **four lost updates.**
No errors, no conflict rejection — `DurableTable.upsert` is **blind last-write-wins, not
atomic CAS / increment**. So when the read→advance window genuinely overlaps (as a realistic
per-event handler's does — work sits between read and advance), the consume-count cursor **does
not serialize.** (The v2 "clean 0,1,2,3,4" was the opposite ordering — advance-before-spawn —
which kept the critical section sub-ms and let the single-threaded scheduler stagger the
accesses; it never tested the race. Both v1 and that v2 reading were timing-confounded; v3
isolates it.)

**(2) The adapter `startOrAttach` ALSO races — TOCTOU, 5 process spawns.** All **6**
`firegrid.unified.adapter.start_or_attach` spans are for the **one** contextId, but the trace
shows **5 distinct `open_byte_pipe` spawns and 5 distinct `firegrid.process.id`s** — **five
`claude-agent` processes for one logical session** (four leaked). Cause:
`ProductionCodecAdapterLive.startOrAttach` is a non-atomic `Ref.get(registry)` → `if (existing)
return` → *build/spawn* → `Ref.update(registry, set)` (`codec-adapter.ts:408-440`); five
concurrent executions all read an empty registry. **This is exactly the production TOCTOU
`runtime-context.ts:23,66` says the parked body's `idempotencyKey (contextId, attempt)`
prevents** — "kills the production TOCTOU that spawned two `claude-agent-acp` processes for one
logical session." This race is solid across **all three runs**.

**(3) The client (`firegrid.ts`) did NOT serialize the prompts.** All 6
`session_prompt.append` spans start within ~1 ms; the per-handle `session.prompt` path is
stateless (no mutex/queue) — so the concurrency was real, not masked upstream. One of the 6
(`h2-0`) didn't drive a body (a minor engine artifact: 5 of 6 concurrent `execute({discard})`
drove a body); it does not affect findings (1) or (2).

### (4) The cursor "race" is a SIM-DESIGN artifact, not a durable-streams gap — durable-streams DOES serialize

[verified in-repo] durable-streams keeps a producer's sends **serialized to preserve producer-seq
ordering** ([read] `packages/effect-durable-streams/src/protocol/Producer.ts:239` — "Sends remain
serialized to preserve producer-seq ordering") with a **monotonically-bounded stream cursor token**
([read] `packages/effect-durable-streams/src/DurableStream.ts:119-122`). The `DurableTable`
write facade is explicitly **not** a coordination primitive — no CAS / lock ([read]
`packages/effect-durable-operators/src/DurableTable.ts:121` — "This is not a lock, claim, mutex,
semaphore, lease, or general coordination primitive"). Crucially, `DurableTable` derives the
`producerId` **per-(table, row primary key)**, not per-table:
`["durable-table", durableType, encodeHeaderFragment(encodedKey)].join(":")` ([read]
`DurableTable.ts:521-525`) — so **the cursor row, keyed by `contextId`, has its own producerId**, and
all writes to it are serialized at the producer level (`Producer.ts:239`). (An external
durable-streams protocol spec was cited in an earlier draft as `PROTOCOL.md §5.2.1`; it is **not
vendored in this repo and is unverified here** — the in-repo lines above are the verifiable sources.)

So the v3 lost updates are **not** durable-streams failing to serialize — the cursor row's writes are
producer-serialized. They lost increments because the body did a **non-atomic read-modify-write**
(`get`→stale 0→blind `upsert` absolute 1) and the `DurableTable` facade offers **no CAS** to reject a
stale-based write. **The race is a property of modeling the consume position as a mutable RMW counter
— the wrong primitive — not of the infra.** This *strengthens* the fix: because the cursor row
already has a single per-key producerId with serialized ordering, an **append-ordered position**
(append a consume-event per input; position = the serialized append order) or a **single-writer-per-
key** is race-free **by the infra's own guarantee**. [The append-cursor claim is grounded in the
serialized-per-producer guarantee above, but is **NOT yet sim-verified** — flagged to avoid a fifth
attribution error.]

### Net for §2.4 / §0.1 (decision-grade)

- **Consume cursor — serializable on durable-streams with the right primitive (not a gap).** A blind
  `upsert` counter races (v3: no CAS); an **append-ordered / single-writer** cursor uses the infra's
  per-producer-serialization + monotonic-offset guarantees and does not. A's cursor cost is "use the
  right primitive," not "build a missing coordinator."
- **Adapter `startOrAttach` — a genuine in-memory race (robust across all runs).** It is a
  `Ref<Map>` TOCTOU (`codec-adapter.ts:408-440`), **not** a durable-streams concern; concurrent
  per-event executions spawned 5 processes for one `contextId`. Needs an **atomic get-or-create**
  (spawn lock / `Ref.modify` / per-key semaphore). This is the load-bearing, infra-independent cost
  of A — the single-execution parked body (B) avoids it by construction (`runtime-context.ts:23,66`).

Root: A runs **N executions per `contextId`**, so per-key invariants (one process; ordered consume
position) need either per-key coordination OR the right durable-streams primitive. B gets both for
free, but only by the canon-C2/C5-banned single-body shape. **This supersedes v1 ("idempotencyKey+
cursor doesn't serialize" — confounded by the sim's seq-race), v2 ("cursor serializes via tx" —
confounded by scheduler staggering), AND the v3 over-generalization ("the cursor races" — true only
for a blind-upsert counter; durable-streams serializes a correctly-modeled cursor).** The robust,
decision-grade residue is the `startOrAttach` TOCTOU.

## H3 — non-clock `DurableDeferred` crash-recovery — **public-surface-blocked (not driven)**

Unchanged from v1: not reachable from the airgapped public client surface; no crash faked.
Source status: deferred-row **persistence is real** (`engine.deferredDone` upserts,
`engine-runtime.ts:473-482`; `deferredResult` reads, `:433-440`), but **resume-on-recovery
for non-clock deferreds does NOT exist** — startup recovery runs only
`recoverPendingClockWakeups` (`:149-159,527`). The proof belongs in a runtime-package engine
test + the fix (extend `recoverPendingClockWakeups` to the `deferreds` table). SDD §6
confirm-item.

## Does the simplifying hypothesis hold?

- **H1 — YES.** `DurableDeferred` rides the real engine seam Firegrid implements → `signal.ts`
  await/resolve dissolves onto the seam (§2.1-2.2).
- **H2 — both shared resources race** (after isolating two successive timing confounds): the
  consume-count **cursor** races (blind `upsert` last-write-wins; v3 forced overlap → 5 reads of
  0, 4 lost updates) **and** the adapter **`startOrAttach`** races (TOCTOU, 5 spawns). Both are
  the per-event shape needing a per-`contextId` coordination primitive that B gets for free.
- **H3 — deferred** to a runtime-package engine test + the named engine fix (§2.3).

## Sources

`packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/{host,driver,index}.ts` ·
**v3 trace** `runs/2026-06-03T00-59-28-645Z__durable-deferred-and-serialization/trace.jsonl`
(H2 cursor race: 5 `serialization.body` with `cursor_at_entry`=0, cursor `get`s +0–3.3 ms vs
`upsert`s +327–371 ms, final cursor 1; `open_byte_pipe`×5 + 5 distinct `firegrid.process.id`) ·
prior runs `…23-54` (v1, seq-race confound) and `…34-47` (v2, scheduler-stagger confound; H1
`deferred.result`×2/`deferred.done`×1) ·
`packages/runtime/src/unified/codec-adapter.ts:408-440` (the `startOrAttach` `Ref` TOCTOU) ·
`packages/runtime/src/unified/subscribers/runtime-context.ts:66` (idempotencyKey kills the TOCTOU) ·
`packages/client-sdk/src/firegrid.ts:1340-1351` (stateless per-handle prompt path) ·
`repos/effect/packages/workflow/src/DurableDeferred.ts:102-122,176` ·
`packages/runtime/src/engine/internal/engine-runtime.ts:149-159,290-294,433-440,458-484,527` ·
`docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md` §2.1-2.4, §9.
