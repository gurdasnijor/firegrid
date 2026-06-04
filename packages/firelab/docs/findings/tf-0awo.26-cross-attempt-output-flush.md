# tf-0awo.26 — cross-attempt output-flush boundary: SEQUENCED (closes the #818 residual)

**Bead:** `tf-0awo.26` · **Instrument:** `packages/runtime/test/unified/cross-attempt-output-flush.test.ts` (a runtime test, **not** a firelab public-surface sim — see "Why a runtime test")
**Spec under test:** `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md` §3.1 + §12 Seam 1b
**Closes the residual named by:** `tf-0awo.20` / PR #818 (`docs/findings/tf-0awo.20-output-ordering-derisk.md`)

## The residual #818 left open

#818 confirmed single-drain ordering is intrinsic (append order == sequence) but
**could not reproduce the cross-attempt / second-drain boundary** on the public
surface, because the public client pins `attempt = DEFAULT_ATTEMPT`
(`channel-bindings.ts:75`). The open question for the §12 cutover's deletion of
the client `compareJournalRows` (activityAttempt, sequence) sort: across a
`deregister → re-spawn` boundary, does the prior attempt's drain **flush before**
the retry's first append, or can the host-wide append order interleave the two
attempts?

**Source claim to test** (`codec-adapter.ts:497-502`): `deregister` does
`Scope.close(entry.scope)`, which interrupts **and awaits** the `forkScoped`
drain fiber before returning — so drain-0 stops appending before
`startOrAttach(1)` builds drain-1; cross-attempt is **sequenced, not concurrent**.
#818 flagged this as source-analysis, *not* reproduced. This finding reproduces it.

## Why a runtime test (not a firelab sim), and the no-backdoor stance

A public-surface sim cannot reach a second attempt (the surface pins `attempt=1`).
Per methodology, a scenario needing the private channel-router/adapter seam belongs
in the owning package's `test/`. The harness is a **validation instrument, not a
production path** — production has no trigger that bumps the attempt; the test
supplies the explicit attempt bump the channel router would. Everything else is
real: `ProductionCodecAdapterLive`, a real `LocalProcessSandboxProvider` spawning
the real official-ACP example agent, the real codec session + drain, and a real
host-wide `RuntimeOutputTable` over a `DurableStreamTestServer`. No fake session,
no stubbed drain. The test drives the **exact sequence the workflow body issues
across a retry**: `startOrAttach(ctx,0)` → `send` (drain-0) → `deregister(ctx)` →
`startOrAttach(ctx,1)` → `send` (drain-1), and a host-scoped observer records every
`RuntimeOutputTable.events` row in arrival/append order.

## Evidence (stable across 3 runs)

Host-wide append order, `(append_index, attempt, sequence)`:

```
append=0  attempt=0  sequence=0
append=1  attempt=0  sequence=1     ← all attempt-0 rows …
append=2  attempt=1  sequence=0     ← … precede all attempt-1 rows
append=3  attempt=1  sequence=1
append=4  attempt=1  sequence=2
append=5  attempt=1  sequence=3
```

- **SEQUENCED — `interleaved=false`.** Every attempt-0 row appends before the first
  attempt-1 row. No attempt-0 append lands after an attempt-1 append.
- **Both drains built** (attempt0=2 rows, attempt1=4 rows) — the boundary was
  genuinely exercised: deregister tore down drain-0's process+scope and
  `startOrAttach(1)` spawned a fresh process with a fresh `sequenceRef=0`.
- **No dropped/cut tail.** Each attempt's `sequence` is contiguous from 0 (0,1 and
  0,1,2,3) — `Scope.close` awaited drain-0's in-flight appends; the last append was
  not interrupted mid-flight into a gap.
- Deterministic: identical partition on all 3 runs.

## Finding

**Cross-attempt ordering is SEQUENCED — the §12 cutover's `compareJournalRows`
deletion is fully cleared, multi-attempt included.** The host-wide append-ordered
read partitions rows cleanly by attempt across a real `deregister → re-spawn`
boundary, so sorting by `(activityAttempt, sequence)` reorders nothing the append
order didn't already order. Combined with #818 (single-drain order intrinsic),
both the single-attempt and the multi-attempt cases are now reproduced as
append-ordered. **tf-0awo.23 does NOT need to re-establish `(attempt, sequence)`
ordering as a property of the read.**

The mechanism is confirmed in the real composition: `deregister`'s
`Scope.close(entry.scope)` interrupts and awaits the `forkScoped` drain fiber
before returning, and `startOrAttach(1)` runs strictly after — so drain-1 cannot
append until drain-0's fiber has terminated. This holds **independent of timing**
because the ordering is enforced by the await, not by a race.

## Epistemic tiers / calibration

- **Test-confirmed (3 runs):** SEQUENCED partition; both drains built; each
  attempt's sequence contiguous (no drop). Reproduced, not asserted.
- **Mechanism (now reproduced, was source-analysis in #818):** `Scope.close`
  awaits the `forkScoped` drain before `deregister` returns.
- **Calibration — what was NOT maximally stressed:** in these runs drain-0 emitted
  2 rows then parked (the fixture turn reaches a permission request the minimal
  adapter-only composition does not answer), so at the 500 ms boundary drain-0 was
  likely *parked*, not mid-append. The interleave question is nonetheless answered
  for the production-shaped sequencing (deregister-then-respawn, never concurrent),
  because drain-1 starts only after deregister returns; the in-flight-append-at-the-
  exact-deregister-instant sub-case would only ever risk a *dropped tail* (a gap),
  not an interleave, and no gap was observed. A deeper stress (deregister mid-burst
  under a permission-answering composition) is possible follow-up but is not
  required to clear the cutover: an interleave is structurally precluded by the
  await regardless.
- **Even safer boundary not needed here:** a host-restart / crash-recovery retry is
  strictly safer than this in-process boundary — the prior process is dead and
  cannot append at all.

## Triage

Supports the §3.1/§12 cutover; closes #818's named residual. Not a production
defect — the reproduced property is the *correct* (sequenced) behavior. The
instrument doubles as a regression guard: if a future change let drain-1 start
before deregister flushed drain-0, the `interleaved=false` assertion goes red.
