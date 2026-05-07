# Durable Clock Substitution Spike

Status: completed. Branch `spike/durable-clock-dispatch`. Scratch
artifact at `scripts/spikes/durable-clock/`. Zero edits to
`packages/`.

## Question

Can Firegrid replace its own wait/sleep/timeout/schedule APIs with a
custom Effect `Clock` Layer that records durable wake-ups, parks
fibers, and resumes them via a separate dispatcher — including
across process restart?

## Method

Built a custom `Clock` implementation, installed it via
`Layer.setClock(...)`, and exercised the standard Effect time stack
against it under Vitest. Six files, isolated under
`scripts/spikes/durable-clock/`, outside the pnpm workspace, no
production package edits.

| File | Purpose |
|---|---|
| `src/wakeup-store.ts` | Durable wake-up record store. Interface (`appendWakeup`, `listPending`, `listDue`, `markDispatched`, `cancel`, `snapshot`) shaped so a Durable Streams + State Protocol backing can later satisfy it. Spike uses an in-memory implementation with explicit `snapshot()` round-trip for restart simulation. |
| `src/durable-clock.ts` | `makeDurableClockDispatcher(...)` builds an Effect `Clock` (with the proper `Clock.ClockTypeId` brand) installed via `Layer.setClock`. `Clock.sleep` appends a durable wake-up before parking the calling fiber via `Deferred`. Exposes `nowMs / advance / tick / liveCount`. |
| `src/__tests__/durable-clock.spike.test.ts` | Five test cases covering live substitution and the restart boundary. |
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Self-contained, ignores workspace. |

## Commands run

```sh
git worktree add -b spike/durable-clock-dispatch \
  /Users/gnijor/gurdasnijor/firegrid/.worktrees/spike-durable-clock origin/main

cd scripts/spikes/durable-clock
pnpm install --ignore-workspace
pnpm test          # 5/5 passed
npx tsc --noEmit   # clean
```

## Acceptance criteria + outcomes

| # | Criterion | Outcome |
|---|---|---|
| 1 | `Clock.sleep` records a durable wake-up, parks the fiber, dispatcher resumes when due. | PASS |
| 2 | `Effect.sleep`, `Effect.timeoutOption`, `Schedule.exponential` (under `Effect.retry`), and one Clock-backed `Stream` operator (`Stream.fromSchedule(Schedule.spaced(...))`) work unchanged under the layer. | PASS |
| 3 | Restart proof: pending wake-up records survive dispatcher/layer teardown; recreated dispatcher discovers due wake-ups and durably marks them dispatched. | PASS for the durable record. KEY FINDING for the suspended work — see verdict. |
| 4 | No Effect Scheduler override. | PASS — only `Layer.setClock`. |
| 5 | No Firegrid wait/sleep/timeout wrapper APIs. | PASS — tests import only stock `effect` APIs. |
| 6 | Tests assert only on the Firegrid substitution boundary, not Effect or Durable Streams behavior. | PASS — assertions cover durable-store contents, fired-record set, parked-fiber count. |

## Verdict

**Q1: Can a `Layer.setClock(...)`-installed Clock back the standard
Effect time stack with durable wake-up records that survive
dispatcher/layer recreation?**

Yes. The substitution is small (~120 LOC) and drives `Effect.sleep`,
`Effect.timeoutOption`, `Schedule.*` under `Effect.retry`, and
Clock-backed `Stream` operators with no wrappers. The
`Deferred`-per-sleep idiom from Effect's own `TestClock` works
equally well over a durable record store: append the record first
(emit-then-wait), park on `Deferred`, dispatcher resolves the
`Deferred` when the record is due. `Layer.setClock` is the
supported install path; no monkey-patching, no Scheduler override.

**Q2: Can that same Clock substitution carry continuation across
process death?**

No. The durable wake-up record survives a dispatcher/layer teardown
— and a recreated dispatcher backed by the rehydrated store
correctly identifies the record as due and durably marks it
dispatched — but the in-memory `Deferred` and the Effect fiber that
was awaiting it are gone with the process. Promoting the durable
record to "dispatched" without something else does nothing for the
suspended logical work. This is encoded as an explicit assertion in
the restart test (`liveCount === 0` after restart-time fire).

This is a Clock-layer **limit**, not a Clock-layer bug. The Clock
service does not own continuations; it owns time. Continuation
across process death needs a separate primitive that associates a
durable wake-up with re-runnable work and is invoked when the
dispatcher fires.

## What this proves and what it does not

Proves:
- `Layer.setClock` is the right install primitive.
- `Clock.ClockTypeId`-branded custom Clock + `Deferred`-per-sleep is
  a viable durable-time substitution.
- The store interface (`appendWakeup` / `listPending` / `listDue` /
  `markDispatched` / `cancel`) is structurally sufficient to back a
  durable Clock; the spike's in-memory implementation can later be
  swapped for a Durable Streams + State Protocol implementation
  without changing the Clock code.
- Real "process death" simulation has to take the durable snapshot
  *inside* the live runtime scope, before any graceful interrupt
  fires — otherwise structured-concurrency cleanup will mark the
  record cancelled, which is the wrong baseline. The test does
  this and it works.

Does not prove:
- Anything about cross-process resumption of suspended work. That
  requires a different primitive.
- Anything about a Durable Streams + State Protocol implementation
  of the store. Spike used in-memory.

## Methodological note: the in-memory artifact

The "snapshot inside the live runtime scope, before any graceful
interrupt fires" technique used in the restart test is an artifact
of the spike's in-memory store, not a fundamental property of a
durable Clock substrate.

Why it was needed here: the spike's `WakeupStore` lives in the
process. Effect's structured-concurrency cleanup runs on graceful
teardown, including the Clock's `onInterrupt` handler, which
appends a `cancel` mutation to the in-memory store. If the
snapshot is taken after that cleanup runs, every pending wake-up
is `cancelled` and the restart simulation tests nothing useful.
The fix was to capture the snapshot before the scope closes.

Why it disappears in production: a real Durable Streams append is
a write to a server outside the process. Once the wake-up record
is appended, it exists regardless of what the local process does
next — graceful shutdown, `kill -9`, kernel panic, or host loss
cannot retroactively modify the appended record. Cancellation has
to be an explicit new append (a State Protocol `delete` or
`update`), and a hard-killed process never gets to make that
append. So the production restart test methodology is just:

```
1. Append a wake-up to a real Durable Streams server.
2. Kill the dispatcher process however you like (graceful or hard).
3. Start a fresh dispatcher pointed at the same stream URL.
4. Verify the new dispatcher observes the wake-up as pending.
```

No "snapshot inside scope" caveat needed. The durability boundary
is the stream append, not anything the test does.

This also exposes a property the in-memory spike could not test:
the cancel-vs-dispatch race. In durable terms, both are appends
to the same primary key; their offset ordering and the State
Protocol's per-key materialization rules decide the winner. The
in-memory spike could not surface this because there was no
shared total order between in-memory operations.

The "Q2 / continuation across process death" finding is unaffected
by all of this. Wake-up durability is not fiber durability; the
in-memory `Deferred` and the closure-over-locals the parked fiber
was holding still die with the process. That gap is closed by a
separate primitive, not by a smarter store.

## Adjacent observation worth recording

`Effect.timeout(duration)` fails with `TimeoutException` on
expiration. The "race and report which won" shape Firegrid users
will likely want is `Effect.timeoutOption(duration)` (returns
`Option.none()` on timeout) or `Effect.timeoutTo({ ... })`. Not a
Firegrid concern; documentation note for downstream callers.

## Files added

```text
scripts/spikes/durable-clock/package.json
scripts/spikes/durable-clock/pnpm-lock.yaml
scripts/spikes/durable-clock/tsconfig.json
scripts/spikes/durable-clock/vitest.config.ts
scripts/spikes/durable-clock/README.md
scripts/spikes/durable-clock/src/durable-clock.ts
scripts/spikes/durable-clock/src/wakeup-store.ts
scripts/spikes/durable-clock/src/__tests__/durable-clock.spike.test.ts
docs/research/durable-clock-spike.md   (this file)
docs/research/workflow-engine-integration.md   (separate; reads this as evidence)
```

Zero edits to existing files. `packages/` untouched.

## Decision the spike unlocks

The Clock substitution is viable for in-process durable time.
Cross-process continuation requires a separate primitive. Whether
to design that primitive in Firegrid or adopt one upstream is a
separate decision; see
`docs/research/workflow-engine-integration.md` for the analysis of
`@effect/workflow` as a candidate.

This document does not recommend an adoption path. It reports the
spike result.
