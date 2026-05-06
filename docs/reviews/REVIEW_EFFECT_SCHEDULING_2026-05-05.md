# Effect-TS Scheduling Review — Firegrid

**Date:** 2026-05-05
**Scope:** Production Effect scheduling surfaces (runtime, substrate, client). Tests, scripts, and docs excluded by request.
**Primary skill:** `claude-skill-effect-ts/skills/scheduling/SKILL.md`.
**Detector cache:** `/tmp/effect-detect-packages.txt` carries no `scheduling` rule category, consistent with the design posture below.

## Summary

Firegrid is, by design, a **Schedule-free** runtime. The hot-path discipline encoded in `firegrid-runtime-process.RUNTIME_HOT_PATH.1` and enforced by the custom ESLint rule `local/no-fixed-polling` (`eslint.config.js:244-285`) explicitly forbids fixed-cadence repetition primitives (`Schedule.fixed`, `Schedule.spaced`, `Schedule.recurs`, `Stream.tick`, and `Effect.sleep` with a fixed `Duration` inside loops). The canonical pattern is **subscription/deadline-driven wakes**: a `wakeStream` whose emissions originate from `subscribeChanges` callbacks plus a single derived deadline-sleep computed from durable rows (`dueAtMs`, `whenMs`, `deadlineAtMs`).

A repository-wide search for `Schedule.*`, `Effect.repeat`, `Effect.retry`, `Effect.timeout`, `Effect.race`, `Effect.sleep`, `Stream.tick`, and `Cron.*` across non-test production code returned exactly two hits:

- `packages/runtime/src/runtime/internal/runner.ts:153-155` — the deadline-derived `Effect.sleep(Duration.millis(delayMs))` that wakes on the next durable due-time. This is the explicitly-allowed pattern.
- `packages/substrate/src/projection-service.ts:83-86` — `Effect.timeoutFail` inside `Projection.until`, used to bound a one-shot wait on a stream-derived predicate.

That is the entire Effect-scheduling surface in production code. The absence of `Schedule.exponential`, `Schedule.jittered`, retry budgets, circuit breakers, and cron schedules is **deliberate**: durable rows already encode "when to do work next," and the substrate kernel — not Effect's scheduler — is the source of truth for both due-time evaluation and idempotent re-attempt semantics. This review therefore focuses on whether the policy is applied consistently and whether the two surviving uses are idiomatic, not on what Schedule combinators are missing.

## Findings by Concept

### 1. Durable deadline scheduling (intentional, idiomatic)

The runner is the only scheduling engine in the system. Per-wake it (a) reads a snapshot from the live `SubstrateStreamDB`, (b) runs the subscriber's scan, (c) reads `Clock.currentTimeMillis`, (d) computes the next durable due-time, (e) interrupts any in-flight deadline fiber, and (f) forks a fresh `Effect.sleep(Duration.millis(delayMs)).pipe(Effect.tap(wake), Effect.fork)` (`runner.ts:148-156`). On every external `subscribeChanges` callback (`runner.ts:158`), the deadline fiber is interrupted and re-derived after the new scan.

Notes on idiomaticity:

- `Duration.millis(delayMs)` is constructed from a runtime-computed `Math.max(0, nextDue - nowMs)` (`runner.ts:152`). This is correctly *not* a literal duration — the ESLint rule's `isFixedDurationExpression` predicate (`eslint.config.js:278`) is precisely calibrated to allow this case.
- The fiber lifecycle is correct: `Fiber.interrupt` runs to `void` (`runner.ts:146`) before the next sleep is forked, ensuring at most one outstanding deadline fiber.
- Coalescing semantics are documented in the file header (`runner.ts:51-52`): an in-flight scan plus concurrent wakes collapse into exactly one follow-up scan via `wakeStream`'s `bufferSize: 1, strategy: "sliding"` (`wake-stream.ts:20`). This is the Stream-shaped replacement for the previous `Effect.race(latch, deadline)` pattern (R1 migration referenced in primary instructions).

The same shape appears for the operation-handler dispatch loop (`operation-handler.ts:188-217`) — except there is no deadline component because operation dispatch is purely event-driven (a started run either exists or it doesn't; there is no "do this later" semantic on the run row itself). This asymmetry is correct.

**Verdict:** the durable-deadline-driven pattern is applied consistently across runner-style subscribers (timer, scheduledWork, projection_match) and the operation-handler dispatch loop. No remediation.

### 2. `Effect.timeout` usage

Single production use: `projection-service.ts:81-87`.

```
const timeout = Duration.decode(options.timeout)
return findFirst.pipe(
  Effect.timeoutFail({
    duration: timeout,
    onTimeout: () => input.timeout(query.label, timeout),
  }),
)
```

This is idiomatic on three counts:

1. The input is `Duration.DurationInput` and decoded via `Duration.decode` before crossing the API boundary (`projection-service.ts:81`). The internal value passed to `Effect.timeoutFail` is a `Duration.Duration`, not a raw number. The skill explicitly encourages this shape (DurationInput at the boundary, decoded once).
2. `Effect.timeoutFail` is preferred over `Effect.timeout` here because the caller wants a typed `ProjectionWaitTimeout` (`facade/projection.ts:31-36`), not an `Option`. The skill's "Polling with Timeout" example collapses these but the typed-error variant is the right call inside a service contract.
3. The same Duration value is reused in the failure payload (`elapsed: timeout`), so downstream observers see exactly the budget that fired. (Minor caveat: `elapsed` here is the configured budget, not the actual elapsed; see Improvement 1.)

The same Duration-input pattern is mirrored throughout the choreography facade — `ChoreographyService.sleep` accepts `Duration.DurationInput` and decodes via `Duration.toMillis(Duration.decode(duration))` (`choreography/service.ts:251`), `waitFor` does the same for its optional `timeout` (`choreography/service.ts:284`). Consistency is good.

### 3. Schedule combinators we deliberately do **not** use

Confirmed absent from production code:

- `Schedule.exponential` / `Schedule.fibonacci` / `Schedule.linear` — no client- or server-side retry-with-backoff. Stream-append failures in the operator (`operator.ts:188-190`) and choreography service (`choreography/service.ts:123-132`) propagate the typed error untouched. Subscriber loop failures log via `Effect.tapErrorCause` + `Effect.logError` (`runner.ts:180-185`, `event-stream-materializer.ts:183-191`, `operation-handler.ts:209-216`) and let the forked fiber die.
- `Schedule.recurs` / `Schedule.spaced` / `Schedule.fixed` — banned by the ESLint rule.
- `Schedule.jittered` — irrelevant because there is no fixed-cadence retry surface to jitter.
- `Cron.parse` / `Schedule.cron` — substrate's `scheduledWork` primitive (`schema/rows.ts`, evaluated in `subscribers.ts:230-247`) handles all "scheduled at a specific time" semantics durably; an Effect-side `Cron` schedule would compete with that.

This is consistent with the SDD posture: retry budgets, dedup, and re-attempt are properties of durable rows, not in-memory scheduler state. A process restart should produce identical behaviour to a process that never failed; an Effect-scheduler-driven retry would not be replayable across restarts.

### 4. `Effect.race` patterns

None found in production code. The previous race-with-deadline shape in the runner has been replaced with `Stream.async` + sliding buffer (`wake-stream.ts:9-21`, R1 migration). The wake-stream design is the canonical "wake on either of {subscription edge, durable deadline}" implementation, and the deadline arm is just an `Effect.sleep` that calls `wake()` in its `Effect.tap`. There is no remaining race-with-deadline pattern that should be Stream-shaped — the migration is complete.

### 5. Cron-shape scheduling

Not present, and correctly so. Future cron-style scheduled work belongs on the substrate `scheduledWork` row (`subscribers.ts:230-247`): the subscriber compares `whenMs` against `Clock.currentTimeMillis` and resolves on the first scan where `whenMs <= nowMs`. A recurring cron would be modelled as "on resolve, append a fresh `scheduledWork` row for the next firing," not as `Schedule.cron` driving an in-process fiber.

### 6. Client-side retry / backoff on transient failures

`packages/client/src/firegrid/{event-client,operation-client,client}.ts` carry no `Schedule`, `Effect.retry`, `Effect.repeat`, `Effect.sleep`, or any timer primitive. Subscription is via the long-lived `DurableStream` session held by the `Projection` layer (`facade/projection.ts:78-98`); transient HTTP errors propagate as typed `ProjectionReadError` (`facade/projection.ts:25-29`). This is intentional: Durable Streams' state-protocol reader is itself the reconnect / catch-up layer, and a client-side `Schedule.exponential` retry around a stream subscription would race the state-protocol's own resume cursor. If the session dies, the user's Effect should fail loudly so the host can re-acquire the layer (re-running the no-gap snapshot+follow boundary).

## Out of Scope

- Tests (`__tests__/**`) — `Effect.sleep(Duration.millis(40))` appears in three test files (`client/__tests__/firegrid-event-streams.test.ts:121`, `client/__tests__/client-work.test.ts:168`, `:198`); these are intentional virtual-clock advances under `TestClock`, out of scope per instructions.
- `scripts/**` — out of scope.
- Lab / RawStreamInspector UI — UI is not a hot-path scheduling surface.
- The `local/no-fixed-polling` ESLint rule is currently configured at `"warn"` (`eslint.config.js:498`); whether to escalate to `"error"` post-baseline is a policy question, not an Effect-scheduling finding.

## Top Improvements (3, in priority order)

The current design is consistently applied; the items below are minor refinements, not gaps.

### 1. `ProjectionWaitTimeout.elapsed` reports the budget, not the elapsed time

`projection-service.ts:84-86` calls `input.timeout(query.label, timeout)` from inside `onTimeout`, where `timeout` is the configured `Duration.Duration` (the budget). The error is named `WaitTimeout` and its `elapsed` field is documented as `Duration.Duration` (`facade/projection.ts:35`), but it currently always equals the budget itself, not the actual time spent waiting. For a fixed-budget timeout this is a tautology, but the field is named `elapsed`, suggesting an actual measurement. Either rename the field to `budget` / `timeout`, or thread `Clock.currentTimeMillis` through `Effect.timed` (`Effect.timed(findFirst).pipe(Effect.map(([elapsed, value]) => value), Effect.timeoutFail(...))`) so the failure path can report the real wait. The latter requires an `Effect.timed` + `Effect.scoped` rework that is more intrusive than the bug warrants; renaming is probably correct.

### 2. Runner deadline fiber: document the sliding-buffer contract

`runner.ts:139-156` keeps `deadlineFiber` as a `let` inside the `wakeStream` subscribe callback and clears it via a closed-over `clearDeadline()`. The lifecycle is correct, but if `scheduleDeadline` is called while a previous deadline fiber is still pending and the interrupt at line 146 races the wake-tap, a stale deadline could re-emit. In practice, `wakeStream`'s sliding buffer (`wake-stream.ts:20`) collapses the duplicate, so the race is invisible. Worth a comment pinning the contract; not worth a code change unless the buffering strategy changes.

### 3. Document the deliberate absence of `Schedule.exponential` on stream-append failures

The operator's terminal append (`operator.ts:188-190`) and the choreography block-row append (`choreography/service.ts:123-132`) have no retry policy on `appendChange` failures. The timer/scheduledWork subscribers will *naturally* re-try on the next durable wake (the row stays pending, the next `subscribeChanges` callback fires another scan). The operator and choreography appends are different — they happen inside synchronous request paths, so a stream-append blip surfaces directly as an `IllegalCompletionTransition`-or-`ChoreographyVerificationError` to the caller. This is the right policy (the substrate is durable; the caller can re-issue), but it is not documented anywhere as a deliberate choice rather than an oversight. A header comment near each `appendChange` call site explicitly disclaiming retry would make the design intent legible to a reviewer who arrives expecting `Schedule.exponential`.

## What Strict Baseline Already Enforces

- `local/no-fixed-polling` ESLint rule (`eslint.config.js:244-285`) bans `Schedule.fixed`, `Schedule.recurs`, `Schedule.spaced`, `Stream.tick`, and `Effect.sleep` with a literal `Duration` inside any loop ancestor.
- `RUNTIME_HOT_PATH.1` annotations (`runner.ts:21`, `subscribers.ts:258,282,311`, `firegrid.ts:37`, `stream.ts:63`) tag every snapshot-input subscriber as part of the hot-path contract.
- Subscriber error policy is uniform: `Effect.tapErrorCause` filters `Cause.isInterruptedOnly` and routes everything else to `Effect.logError`. Forked subscriber fibers die loudly; there is no silent retry.
- Effect.timeout call sites consistently accept `Duration.DurationInput` and decode once via `Duration.decode` before crossing the typed API boundary.

---

**Real findings:** 0 design-level issues. 3 minor refinements (one naming bug, one comment-only clarification, one deliberate-design documentation item).
