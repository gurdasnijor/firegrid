# tf-eioo — Fluent durable-sleep vertical slice witness

**Date:** 2026-06-06
**Feature:** `features/fluent/coordination/fluent-durable-sleep.feature`
**Sim:** `packages/firelab/src/simulations/fluent-durable-sleep/`
**Verdict:** `production-path-covered`

## What it proves

Durable sleep parks by recording timer **intent** before suspension; a timer **source** materializes time as a durable append; replay resolves the fired sleep from the journal with **no process-local timer**. Built on the existing fluent-runtime timer machinery (no new durable mechanism):

```
Store.scheduleTurnTimer  → turn.timer_scheduled (fenced append, BEFORE park)
Sources.fireDueTurnTimers → reads the journal → Store.fireTurnTimer → turn.timer_fired (fenced append)
re-drive fireDueTurnTimers → sees alreadyFired → no duplicate, no reschedule
```

Run against firelab's real `DurableStreamTestServer`. The driver is airgapped (firelab rule: imports only `@firegrid/client-sdk` + `effect`) and reads the durable **turn** stream over HTTP — no driver-only proof.

## Computed verdict (forge-proof host-substrate spans)

| Gate | Span | Result |
|---|---|---|
| scheduled | `fluent_runtime.store.turn.timer.schedule` | ✓ (1×) |
| timer_source | `fluent_runtime.sources.timer.fire_due` | ✓ (**2×** — fire + idempotent re-drive) |
| fired | `fluent_runtime.store.turn.timer.fire` | ✓ (**1×** — fired once despite 2 source drives) |
| durable_write | `firegrid.durable_streams.http.request` | ✓ |

The headline: the timer source ran **twice** but `timer.fire` fired **once** — the second (post-wake) drive resolved the already-fired timer from the journal, appending no duplicate. The driver independently confirmed exactly **1** `turn.timer_scheduled` (carrying target time T = `fireAtEpochMs`) and exactly **1** `turn.timer_fired` (carrying a durable `firedAtEpochMs ≥ T`).

## Scenario coverage (feature)

- **Timer intent before park** ✓ — `scheduleTurnTimer` appends `turn.timer_scheduled` before any fire; driver asserts the record carries the sleep key + target T.
- **Timer source materializes the wake** ✓ — `fireDueTurnTimers` → `fireTurnTimer` durable append; the `fluent_runtime.store.turn.timer.fire` gate makes it distinguishable from a driver-forged observation.
- **Resume from journal after restart** ✓ — `fireDueTurnTimers` re-reads the journal every drive; the post-wake re-drive resolves the fired timer with no process-local state.
- **Replay does not reschedule / duplicate** ✓ — second drive → `alreadyFired`; driver asserts exactly 1 scheduled + 1 fired.
- **`wait_until` uses the same mechanism** — same `scheduleTurnTimer`/`fireDueTurnTimers` path; `fireAtEpochMs` *is* the absolute timestamp, and `firedAt` comes from the explicit source `nowEpochMs`, never a local client/worker clock. Exercised through the same code path (not a separate timer in this slice).
- **Process-local sleep mutation → red** — the vacuity guard is structural: a `Clock.sleep` mutation emits none of the gated spans (no scheduled append, no timer source, no durable fire), so the verdict flips red. No `Clock.sleep`/local timer is the durable mechanism here.

## Boundaries honored

- Real Durable Streams substrate; product-visible driver assertions; host-substrate coverage gates; no driver-only proof.
- DS wake delivery / named-consumer claim/ack remains substrate-owned (`fluent-worker-redrive`'s concern). This slice drives the **post-wake product step** (the timer source) — it does not rebuild lease/cursor/claim machinery.
- No legacy `packages/runtime` edits or imports; reuses `packages/fluent-runtime` Domain/Store/Sources timer pieces unchanged.

Reproduce: `pnpm --filter firelab simulate:run fluent-durable-sleep`.
