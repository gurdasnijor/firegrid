# tf-28b8 — Shape D workflow admission boundaries · FINDING

**Verdict: GREEN.** Of the three target subscribers, only one (**scheduled
prompt**) genuinely needs Shape D `@effect/workflow` machinery. **Tool execution**
and **wait routing** are Shape C — keyed handlers over `DurableTable` — for their
correctness-load-bearing behavior. Empirically confirmed on the real
`DurableStreamsWorkflowEngine` + `DurableTable`, side-by-side Shape C / Shape D
arms across crash-and-reconstruct boundaries.

```
pnpm --filter @firegrid/tiny-firegrid simulate:run shape-d-workflow-admission
```

## The boundary this classifies

Two distinct things get conflated under "the RuntimeContext is a workflow":

- **Shape C — durable state ownership.** The keyed entity (`contextId`) is durable
  state in `DurableTable`. A handler materializes for one fact, reads rows,
  applies a pure transition, writes the next state/result row, and returns. No
  long-lived body, no parked entity body between events (C1, C2, C5). At-most-once
  and async-wait recovery come from **durable row identity**, read back on
  reconstruction — not from anything the engine holds in memory.
- **Shape D — execution bindings.** A *bounded* `@effect/workflow` invocation used
  inside event handling **only** where restart-safe execution machinery earns its
  keep: `Activity` (memoized side-effect execution), `DurableDeferred` (durable
  race), `DurableClock` (durable timer). These are execution bindings, **not** the
  state owner. tf-tvg1's allowance — "workflows are a kind of subscriber when
  restart-safe execution machinery earns its keep" — is exactly this set.

The probe asks, per subscriber: **is the load-bearing capability state ownership
(Shape C) or an execution binding (Shape D)?**

## Probe 1 — Tool execution → **Shape C**

- **Load-bearing capability:** durable result identity (constraint C3), i.e.
  `insertOrGet` on a `tool/<toolUseId>`-keyed row. **Activity memoization is NOT
  load-bearing** for at-most-once.
- **Evidence:** `firegrid.tf28b8.tool_probe`. Shape C — 3 deliveries / replays of
  the same `toolUseId`, **1** genuine execution, **1** physical side effect
  (`firegrid.tf28b8.tool.shape_c.execute` ×3, side-effect counter = 1), identical
  results. Shape D — `tf28b8-tool-workflow.execute` ×2 (two engine generations
  across a reconstruction) but `tf28b8-tool-activity/tool-d-1` ×1 and one
  `firegrid.workflow_engine.activity.execute`: the Activity memoized, so the
  external effect also ran once. **Same outcome ⇒ the durable row, not the engine,
  is the at-most-once authority.**
- **Falsifier:** if the Shape C side-effect counter were >1 across the 3
  deliveries (durable row failed to fence), OR if the Shape D counter were >1
  across reconstruction (Activity failed to memoize). Either fails the driver
  loudly.
- **Residual Shape-D earn (narrow):** the durable row fences the *result*, not a
  *non-idempotent side effect under concurrent execution*. If two workers both
  read "absent" then both execute, the effect runs twice though only one row
  persists. Closing that needs claimed-work discipline (claim-before-execute) —
  itself expressible as a Shape C claim row, OR an Activity's claim. The probe is
  sequential, so this is documented, not demonstrated. Engine-managed
  retry/backoff of a flaky effect is an Activity *convenience*, not a correctness
  requirement the durable row cannot meet.
- **Production rewrite dependency:** **tf-jpcg** (owning-workflow tool
  input/result seam). This finding says the tool-result seam is a durable
  completion keyed by `toolUseId` recorded by the owning RuntimeContext handler
  (Shape C); it does **not** need a per-call `ToolCallWorkflow` (matches the
  runtime-design-constraints "Tool Calls" section). Shape D admission for tools is
  limited to the optional claimed-work/retry binding.

## Probe 2 — Wait routing → **Shape C** (timeout is the one Shape-D seam)

- **Load-bearing capability:** durable completion keyed by stable identity
  (constraint C4), reconstructed from the row with snapshot-first reads.
  **DurableDeferred-as-mailbox is NOT load-bearing** — it is the bridge primitive
  the constraints retire.
- **Evidence:** `firegrid.tf28b8.wait_probe`. A producer resolves a
  `completion/perm-1` row; after scope-close (crash, no in-memory waiter) a fresh
  handler point-reads the row and recovers `value=approved`
  (`recovered-from-state=true`). The "race" reduces to reading N rows and taking
  the first resolved one: `race first-valid-terminal-wins=winner-a`. No
  `DurableDeferred`, no engine combinator on this path.
- **Contrast already on record:** S1 (`input-suspend-crash-recovery`) proved a body
  parked on `Workflow.suspend` is **not** re-armed by reconstruction. A durable
  completion *row* sidesteps that entirely — it is read, not awaited, so there is
  no parked waiter to re-arm. That asymmetry is why the completion is Shape C and
  the `DurableDeferred` mailbox is bridge debt.
- **The one Shape-D seam — timeout:** bounding a wait needs a timer that fires at a
  wall-clock instant with no producer. That is the DurableClock capability of
  Probe 3. So `DurableDeferred.raceAll([matchActivity, DurableClock.sleep])` (the
  `inv2-waitforworkflow` shape) decomposes into: completion + race = Shape C; the
  `DurableClock.sleep` timeout arm = the Shape D binding from Probe 3. The match
  side does not need to be an Activity if the matched fact is itself a durable
  completion row.
- **Falsifier:** if `recovered-from-state` were false (the wait could not be
  rebuilt from the row and required a surviving in-memory waiter / engine re-arm),
  wait routing would be Shape D. The driver asserts the opposite.
- **Production rewrite dependency:** **tf-vrz6** (input table) and the
  permission/child-completion paths. Input arrival, permission response, and
  child-session completion are all durable completions keyed by domain identity
  (Shape C). The retiring per-sequence `DurableDeferred` input mailbox is the
  bridge this displaces.

## Probe 3 — Scheduled prompt → **Shape D** (DurableClock is load-bearing)

- **Load-bearing capability:** `DurableClock` — an engine-recovered wall-clock
  wakeup. A scheduled/true-future prompt produces a **new fact at a future instant
  with no external producer to resolve a completion**, so the durable-completion
  shape (Probe 2) does not apply.
- **Evidence:** `firegrid.tf28b8.scheduled_probe`. Shape D — park on
  `DurableClock.sleep(400ms)`, crash before fire, reconstruct: the body
  auto-completes with **no explicit resume**
  (`auto-completed after restart=true`; `clock.schedule_wakeup` ×2 + `clock.fire`
  ×1 in the trace). This is the engine's `recoverPendingClockWakeups` — the **one**
  recovery mechanism it has (also the load-bearing contrast in the S1 FINDING).
  Shape C — a `due/sched-c-1` row with a future `fireAtMs`: after reconstruction it
  does **not** fire itself (`auto-fired after restart=false`); it is
  `observable only by external poll=true`. `DurableTable` offers no wall-clock
  push.
- **Maps to tf-tvg1's A/B/C:** the Shape C alternative for a timer is exactly
  tf-tvg1 **outcome C** for the timer sub-case — progress requires polling / an
  external trigger (a tick subscriber scanning due rows). It does not falsify the
  short-edge plan for *fact-driven* subscribers (tool/wait, which are push/read);
  it scopes the **timer** as the subscriber kind that needs either the engine
  clock (Shape D) or an external scheduler.
- **Falsifier:** if the Shape C due-time row auto-fired after restart with no
  external tick (some substrate-native wall-clock push existed), the scheduled
  prompt would collapse to Shape C and DurableClock would not be load-bearing. The
  driver asserts the row does not self-fire.
- **Production rewrite dependency:** `schedule_me` / true-future delivery
  (validated separately by tf-sto7). Scheduled prompt keeps a **bounded** Shape D
  `DurableClock` binding; the RuntimeContext state around it stays Shape C (the
  clock wakeup writes a fact that the keyed handler then processes).

## Summary table

| Subscriber | Verdict | Load-bearing capability | Shape D execution binding (if any) |
|---|---|---|---|
| Tool execution | **Shape C** | durable result identity (C3) | optional only: claimed-work / retry (`Activity`) |
| Wait routing | **Shape C** | durable completion (C4) | timeout bound only → `DurableClock` |
| Scheduled prompt | **Shape D** | `DurableClock` wall-clock recovery | `DurableClock.sleep` |

**One sentence:** RuntimeContext **state** is Shape C (durable rows + keyed
handlers) in all three cases; Shape D admission is confined to **bounded execution
bindings** — an optional claimed-work/retry binding for tools, and a `DurableClock`
binding for timeouts and scheduled prompts — never to a context-lifetime parked
body.

## Constraint Check

```
C1 keyed durable state:                complies — all state is DurableTable rows keyed by identity.
C2 handler, not long-lived body:       complies — Shape C arms are fresh per-delivery handlers; Shape D arms are bounded executions, not context-lifetime loops.
C3 durable result identity:            complies — Probe 1 proves at-most-once from the toolUseId-keyed row, not Activity memo.
C4 durable completion:                 complies — Probe 2 reconstructs the wait from the row alone, no in-memory waiter.
C5 no parked entity body:              complies — the only parked body is the bounded DurableClock timer (Probe 3), which the engine recovers.
C6 typed source observation:           not applicable — no new agent-tool channel/cursor taxonomy added.
C7 first-class schemas:                complies — every row is an explicit Schema.Struct.
```

No production bridges built; tiny-firegrid simulation only.
