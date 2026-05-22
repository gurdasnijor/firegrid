# Finding: `schedule_me` true-future durable delivery is exact-once (tf-sto7)

**Date:** 2026-05-22
**Bead:** tf-sto7
**Subject:** the `schedule_me` durable scheduler shipped in PR #637 (tf-5ose)
**Verdict:** ✅ **validated** — a host-computed future deadline is armed durably,
the self-prompt is **not** delivered before the deadline, and is delivered
**exactly once** after it, surviving an engine reconstruction (replay/restart).
No duplicate prompts, no lost wakeup, no scheduler/ownership boundary issue
surfaced — so the tf-sto7 STOP/EXIT condition was **not** triggered.

## 0. Why this was still open

PR #637 made `schedule_me` non-blocking via a durable `ScheduledPromptWorkflow`,
but its own honest scope note flagged the missing gate, and the latest live Zed
run did **not** close it:

- In the live run the agent had no clock-read tool and supplied
  `when = 1779386415000`, already in the **past** vs the captured trace time
  (~`1779419924xxx` ms). That validates only that an **overdue** `schedule_me`
  returns quickly and fires promptly — it does **not** validate true future
  durable scheduling (the deadline never had to be held).
- The unit tests in `tool-use-to-effect.test.ts` prove the immediate-return
  contract + workflow registration, but not the fire-once-after-the-delay /
  survives-replay correctness.

This finding closes that gap with a **host-clock-computed** future `when` and a
deterministic real-engine test.

## 1. Method

`packages/runtime/test/workflow-engine/scheduled-prompt-true-future.test.ts`
drives the **production** `ScheduledPromptWorkflow` (not a synthetic stand-in)
against a real `DurableStreamTestServer`, mirroring the engine test harness
(`DurableStreamsWorkflowEngine.test.ts`). The scheduled self-prompt is appended
through `RuntimeControlPlaneTable.inputIntents`, which is idempotent on the
intent key derived from `scheduleId` — so on a fresh stream the **count of
intent rows is the exact delivery count.**

Crucially, the deadline is `Date.now() + 1200ms` — the **host clock**, not an
agent estimate. Rebuilding the engine layer over the same stream URLs between
phases simulates a host restart (durable state lives on the server).

## 2. Evidence (all assertions green; 3× no flake; suite 23/23)

**Phase A — arm, then observe armed-but-not-fired _before_ the deadline:**
- The deadline is genuinely future at scheduling: `now-at-arm < when`. ✔
- Non-blocking: arming returns in `< DELAY_MS` (the fire-and-forget contract). ✔
- The durable timer is **pending**: exactly 1 `clockWakeups` row
  (`workflowName = firegrid.agent_tools.schedule_me`,
  `clockName = scheduled-prompt:<scheduleId>`, `status = "pending"`). ✔
- **NOT delivered early:** `inputIntents` count `== 0` while the wakeup is
  pending and the clock is before the deadline. ✔
  The driving fiber is then **interrupted** — the persisted wakeup must survive
  without it.

**Phase B — let the host clock pass the deadline, reconstruct the engine:**
- `Date.now() > when` is asserted before resuming. ✔
- Re-`execute` on a **fresh engine** (= restart) with the same `idempotencyKey`
  resumes the same execution; the deadline has passed, so the body fires.
- **Delivered exactly once after the due time:** `inputIntents` length `== 1`,
  and the row's `contextId` matches. ✔

**Phase C — replay/restart again:**
- A further re-`execute` on another fresh engine leaves `inputIntents` count
  `== 1` — **no duplicate, no loss** across the replay boundary. ✔

Results:
```
✓ schedule_me true-future durable delivery (tf-sto7)  (4.7s)
  3× repeat: 1 passed each (no flake)
  full workflow-engine suite: 23 passed (23)  — incl. the existing
    VALIDATION.3 DurableClock-after-reconstruction test, unaffected
  tsc --noEmit: clean
```

## 3. How this is distinct from the overdue/immediate case

The discriminator is **Phase A**: with a true-future `when`, the test observes a
**pending** durable wakeup AND **zero** delivered intents simultaneously, while
the host clock is still before the deadline. An overdue/immediate `when`
(`duration = max(0, when-now) = 0`) would fire without ever parking a pending
wakeup, so `inputIntents == 0`-while-pending could not be observed. The
exact-once count (`== 1`, never `2`) across two engine reconstructions is the
durability/idempotency proof the overdue live run could not provide.

## 4. Mechanism confirmed (source)

- **Durable arm:** `ScheduledPromptWorkflow` (`scheduled-prompt.ts:51`)
  `DurableClock.sleep({ duration: max(0, when - now), inMemoryThreshold: 0 })`
  — the zero in-memory threshold forces the wakeup to persist, so it cannot
  fire before the deadline and survives restart (the first deadline wins on
  replay).
- **Exact-once delivery:** `appendScheduledPromptIntent`
  (`scheduled-prompt-append.ts:41`) `inputIntents.insertOrGet(intent)` with
  `intentId` derived from `scheduleId` — a replay/restart re-append dedups.
- **Resumable after the delay:** the handler is registered on the host-engine
  scope, so the engine resumes the parked execution when the timer is due.

## 5. Boundary outcome

Per the tf-sto7 STOP/EXIT rule: true-future validation revealed **no** duplicate
prompts, **no** lost wakeup after restart/resume, and **no** scheduler /
workflow-engine ownership redesign need. Validation is complete within the
harness/test scope. The deterministic test is the standing regression gate that
PR #637 recommended; it is more reproducible than a live Zed retest (which is
also blocked from exercising a true future `when` until the agent has a
host-clock-read affordance — a separate concern from durable scheduling).
