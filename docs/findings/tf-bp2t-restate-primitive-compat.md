# tf-bp2t Restate Primitive Compatibility Spike

## Summary

This spike built a hostless firelab simulation at
`packages/firelab/src/simulations/restate-primitive-compat/`.

The sim now targets the `@restatedev/restate-sdk-gen` center of gravity:
free-standing `Operation<T>` / `Future<T>` combinators (`gen`, `execute`,
`run`, `sleep`, `awakeable`, `all`, `race`, `select`, `spawn`). It does not
model Restate services/objects/workflows first; those are higher-level nouns
that can be rebuilt once the composable scheduler shape is credible.

Compatibility verdict: the direct Durable Streams path is viable for a
Restate-like composable API. After bumping to `@durable-streams/server@0.3.7`,
the sim can drive the reserved pull-wake HTTP routes directly: create data and
wake streams, create a pull-wake subscription, append work, claim it, ack it,
and observe no pending work afterward. The same trace also proves release /
reclaim, stale-token fencing, next-wake chaining, lease-expiry reclaim, and a
timer-as-append wake. That means this direction is not blocked on
`@effect/workflow`; a Restate-style `Operation`/`Future` scheduler can be built
directly over Durable Streams subscriptions plus durable state rows.

The spike is still not a product API because the scheduler itself is not yet
implemented as a reusable package. The remaining hard work is concrete:
durable routine-backed `spawn`, waiter rows for `race`/`select`, persisted
journal futures for `run`/`sleep`/awakeables, and cancellation semantics. The
existing `DurableStreamsWorkflowEngine` proves a parallel workflow-engine path,
but it is no longer required as the substrate for this Restate-style API.

Primary trace:
`packages/firelab/.simulate/runs/2026-06-04T04-10-57-267Z__restate-primitive-compat/trace.jsonl`

Runner summary:

```text
outcome: DriverCompleted
spans: 689
sides: driver=688
```

This is a simulation finding, not a computed pass/fail test verdict.

## Source References

- Restate sdk-gen design:
  https://github.com/restatedev/sdk-typescript/blob/main/packages/libs/restate-sdk-gen/DESIGN.md
- Restate sdk-gen guide:
  https://github.com/restatedev/sdk-typescript/blob/main/packages/libs/restate-sdk-gen/guide.md
- Restate sdk-gen implementation files sampled:
  `src/operation.ts`, `src/future.ts`, `src/free.ts`, `src/scheduler.ts`,
  `src/fiber.ts`, `src/current.ts`, `src/awaitable.ts`, `src/channel.ts`
- Durable Streams pull-wake claim/ack/release:
  https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md#72-pull-wake-claim-ack-and-release
- Durable Streams reserved subscription APIs:
  https://github.com/durable-streams/durable-streams/pull/361
- Durable Streams server subscription routes at the referenced merge:
  https://github.com/durable-streams/durable-streams/blob/82f9963ae0b489566352393be9b4796c788c99c2/packages/server/src/subscription-routes.ts
- Durable Streams server subscription manager at the referenced merge:
  https://github.com/durable-streams/durable-streams/blob/82f9963ae0b489566352393be9b4796c788c99c2/packages/server/src/subscription-manager.ts
- Durable Streams State Protocol:
  https://github.com/durable-streams/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md
- Firegrid / Effect primitives read:
  `packages/effect-durable-operators/src/DurableTable.ts`,
  `repos/effect/packages/workflow/src/Workflow.ts`,
  `repos/effect/packages/workflow/src/Activity.ts`,
  `repos/effect/packages/workflow/src/DurableClock.ts`,
  `repos/effect/packages/workflow/src/DurableDeferred.ts`,
  `packages/runtime/src/engine/durable-streams-workflow-engine.ts`

## Correction After Source Verification

Earlier traces recorded a raw pull-wake endpoint probe returning `404 Not
Found`. That was a useful local dependency/harness check, but it should not be
read as "Durable Streams lacks pull-wake" or "Firegrid lacks durable
claim/recovery semantics." After upgrading this spike to
`@durable-streams/server@0.3.7`, the sim now exercises the reserved subscription
routes successfully.

Source-verified upstream evidence:

- `durable-streams` PR #361 was merged on 2026-05-25 and states that it adds
  the reserved `/v1/stream/__ds/*` subscription control namespace, including
  pull-wake claim/ack/release flows.
- At `durable-streams` commit `82f9963`, `packages/server/src/subscription-routes.ts`
  defines `RESERVED_CONTROL_PREFIX = "/v1/stream/__ds"` and dispatches
  `claim`, `ack`, and `release` actions.
- The same file implements `handleClaim`, `handleAck`, and `handleRelease`.
  `packages/server/src/subscription-manager.ts` implements the subscription
  manager state and pull-wake subscription validation.
- This worktree originally had `@durable-streams/server@0.3.1`, whose npm
  tarball did not contain `subscription-routes.ts`. The spike now pins
  `@durable-streams/server@0.3.7`; the npm tarball and installed package both
  contain `SubscriptionRoutes`.
- The final trace proves the route flow at the public HTTP surface:
  `createData:201`, `createWake:201`, `createSubscription:201`,
  `appendData:204`, `claim:200`, `ack:200`, and post-ack `claimAfterAck:409`
  with `NO_PENDING_WORK`. It also proves `claimWhileHeld:409 ALREADY_CLAIMED`,
  `release:204`, `reclaimAfterRelease:200`, stale ack `409 FENCED`,
  `ackNextWake:true`, lease-expiry `leaseClaimAfterTtl:200`, and
  timer wake `timerClaimAfterAppend:200`.

Source-verified runtime evidence:

- `packages/runtime/src/engine/internal/table.ts:18` defines durable workflow
  `executions`; `:34` completed `activities`; `:42` `activityClaims`; `:52`
  `deferreds`; and `:60` `clockWakeups`.
- `packages/runtime/src/engine/internal/engine-runtime.ts:63` implements
  durable activity claiming with `activityClaims.insertOrGet`, giving
  first-writer-wins worker ownership for an activity attempt.
- `packages/runtime/src/engine/internal/engine-runtime.ts:182` rehydrates and
  forks an execution body from its persisted execution row.
- `packages/runtime/src/engine/internal/engine-runtime.ts:275` recovers
  suspended executions whose `DurableDeferred` result was persisted but whose
  in-process resume was lost.
- `packages/runtime/src/engine/internal/engine-runtime.ts:386` implements
  workflow interruption through the durable execution row and `resume`.
- `packages/runtime/src/engine/internal/engine-runtime.ts:408` short-circuits
  completed activities from durable state and uses the claim row before running
  an uncompleted activity body.
- `packages/runtime/src/engine/internal/engine-runtime.ts:515` persists
  `DurableDeferred` completion and resumes the owning execution.
- `packages/runtime/src/engine/internal/engine-runtime.ts:548` persists clock
  wakeups with `insertOrGet`; `:149` re-arms pending wakeups at engine startup.

Recommendation adjustment: the next design decision is no longer "is there a
pull-wake primitive?" There is. The direct path should be treated as viable:
build the Restate-like scheduler over Durable Streams subscriptions and state
rows, using `DurableStreamsWorkflowEngine` only as prior art or a compatibility
bridge where useful.

## Open Questions Answered

| Question | Answer | Evidence | Tier |
|---|---|---|---|
| Does the version bump give us the pull-wake transport? | Yes. `@durable-streams/server@0.3.7` exposes the reserved subscription routes and the sim can create, claim, ack, release, and reclaim through the public HTTP surface. | Trace line 12: `createSubscription:"201 Created"`, `claim:"200 OK"`, `ack:"200 OK"`; installed server package contains `src/subscription-routes.ts` and `src/subscription-manager.ts`. | Source-verified |
| Does `@durable-streams/client@0.2.6` already expose typed subscription helpers? | No. The installed client exports `stream`, `DurableStream`, `IdempotentProducer`, types, errors, constants, and fetch/backoff helpers, but no `subscription`, `claim`, `ack`, `release`, or `__ds` helper. | Installed `@durable-streams/client@0.2.6/src/index.ts` exports `createFetchWithBackoff` but no reserved subscription API. | Source-verified |
| Is worker exclusivity available? | Yes. A second claim while the first worker holds the lease is rejected. | Trace line 12: `claimWhileHeld:"409 Conflict"`, `claimWhileHeldError:"ALREADY_CLAIMED"`. | Source-verified |
| Is manual reclaim available? | Yes. A holder can release and another worker can claim the same pending work. | Trace line 12: `release:"204 No Content"`, `reclaimAfterRelease:"200 OK"`. | Source-verified |
| Are stale tokens fenced? | Yes. Acking with the released worker's old token after another worker reclaimed is rejected. | Trace line 12: `staleAckAfterRelease:"409 Conflict"`, `staleAckAfterReleaseError:"FENCED"`. | Source-verified |
| Can ack chain the next wake? | Yes. If new data arrives while a worker owns a wake, ack returns `next_wake:true` and the next claim succeeds. | Trace line 12: `ackNextWake:true`, `claimNextWake:"200 OK"`, `ackNextWakeClaim:"200 OK"`. | Source-verified |
| Is crash/lease reclaim represented by the substrate? | Yes. With a short `lease_ttl_ms`, another worker can claim after expiry. | Trace line 12: `leaseClaimWhileHeld:"409 Conflict"`, `leaseClaimAfterTtl:"200 OK"`. | Source-verified |
| Can long sleep be mapped without Effect Workflow? | Yes at the substrate level: a timer row/worker can append to the subscribed stream when due, which wakes the pull-wake subscription. The product scheduler still has to own that timer row and worker. | Trace line 12: `timerClaimBeforeAppend:"409 Conflict"`, `timerClaimBeforeAppendError:"NO_PENDING_WORK"`, `timerClaimAfterAppend:"200 OK"`, `timerWakeSeen:true`. | Source-verified substrate; scheduler mapping inferred |
| Can this get off Effect Workflow for this Restate-style API? | Technically yes. The direct scheduler can be built on Durable Streams subscription routes plus durable state rows. Effect Workflow remains useful prior art and the current sim harness still uses it for some exercises, but it is not required as the substrate. | Trace line 12 proves direct pull-wake transport; summary line 685 proves durable rows for futures/waiters/claims/state/routines/cancellations. | Source-verified substrate; productization inferred |

## Mapping

| Restate concept | Firegrid/lower substrate used in sim | Evidence | Tier |
|---|---|---|---|
| `Operation<T>` | Lazy generator factory consumed by `execute` | `gen_body` returns the combined output; summary line 685 lists the free functions exercised | Source-verified in sim |
| `Future<T>` | Scheduler-owned row in `DurableTable` `futures`, plus an eager memoized handle | Future ledger has 39 rows in summary line 685; `state.future_upsert` spans show `pending/running/succeeded` lifecycle | Source-verified in sim |
| `execute(ctx, op)` | `Workflow.make` + `DurableStreamsWorkflowEngine` execute | First and duplicate execute produce identical output in summary line 685 | Source-verified in sim |
| `run(action)` | `Activity.make` under a future row | Step futures succeed via `state.future_upsert`; duplicate execute does not recompute beyond the first workflow execution | Source-verified in sim |
| `sleep(duration)` | Timer-backed future; current sim uses `DurableClock.sleep` for short branches and direct pull-wake timer append for substrate proof | `tick` participates in `select`; route probe line 12 proves timer append wakes a pull-wake subscription | Source-verified substrate; scheduler mapping inferred |
| `awakeable<T>()` | `DurableDeferred` token/succeed/await under a future row | Summary line 685 includes `awakeableValue:"awakeable-resolved"` | Source-verified in sim |
| `workflowPromise(name)` | Workflow-bound `DurableDeferred` wrapper | Summary line 685 includes `workflowPromiseValue:"workflow-promise-ok"` | Source-verified in sim |
| `all([...])` | Combinator future awaiting child futures | `all-a-b` and `spawn-and-awakeable` futures reach `succeeded` | Source-verified in sim |
| `race([...])` | Waiter row over child futures, not `Effect.raceAll` owning child fibers | Losing `slow-loser` still writes `succeeded` at line 169; summary line 685 reports 3 losing-branch successes | Source-verified in sim |
| `select({ tag })` | Tagged futures plus waiter row over branch futures | Losing `done` branch writes `succeeded` at lines 218 and 244 | Source-verified in sim |
| `spawn(op)` | Routine-backed future plus `routines` table row | Routine row span at line 284; summary line 685 includes `spawnedValue:"A1-B2:child-step"` and `routine_row_count:1` | Source-verified in sim; product mapping gap inferred |
| `state<T>()` / `sharedState<T>()` | `DurableTable` `stateRows` keyed by workflow or shared scope | State set/get spans at lines 302/316/330/344; summary line 685 reports `state_row_count:2` | Source-verified in sim |
| `channel<T>()` | Single-shot in-memory channel plus durable observation row | Channel receive/send spans at lines 373/375; summary line 685 includes `channelValue:"channel-ok"` and `channel_row_count:1` | Source-verified in sim; durability gap inferred |
| service/object/workflow client helpers | Thin sim helpers writing `serviceCalls` rows | Client call spans at lines 464/466/468; summary line 685 includes service/object/workflow results | Source-verified in sim; outside the free-standing scheduler scope |
| `genericCall` / `genericSend` | Thin sim helpers writing `serviceCalls` rows | Generic call span at line 470; send spans include line 538; summary line 685 reports `service_call_row_count:8` | Source-verified in sim |
| `cancel(invocationId)` | Cancellation row plus AbortSignal fanout to `run` closure | Cancel span at line 627; summary line 685 reports `cancellation_row_count:1` | Source-verified in sim; TerminalError semantics not implemented |
| Long `sleep` | Direct Durable Streams timer-as-append wake plus prior `DurableClock` schedule/fire probe | Route probe line 12: no pending before timer append, `timerClaimAfterAppend:"200 OK"`, `timerWakeSeen:true`; `DurableClock` schedule/fire remains visible at lines 571/600 | Source-verified substrate; scheduler row mapping inferred |
| Pull-wake claim/ack/release | Direct Durable Streams reserved subscription routes plus sim-local scheduler `claims` rows | Route probe line 12: create subscription `201`, claim `200`, held second claim `409 ALREADY_CLAIMED`, release/reclaim `204/200`, stale ack `409 FENCED`, ack `200`, post-ack claim `409 NO_PENDING_WORK`; summary line 685 also reports 39 sim claim rows | Source-verified in sim and upstream source |
| State protocol rows | `DurableTable` future/waiter/claim collections | Mapping line 8 and `firegrid.durable_table.*` spans show State Protocol-backed table writes | Source-verified in sim |
| Restate workflow-pattern tests | Retry, timeout fallback, saga compensation, fan-out, polling loop, and sequential-vs-parallel composition need scheduler semantics rather than Effect Workflow specifically | `workflow-patterns.test.ts` exercises `gen`, `select`, `spawn`, `Scheduler.all`, and journal futures; direct pull-wake route flow plus durable rows gives the missing substrate shape | Source-verified against upstream test source |

## Exercise Scenarios

| Scenario family | What the sim exercised | Resulting evidence | Gap |
|---|---|---|---|
| Basic `gen` / `execute` | One operation body yields multiple future families and returns a typed object | Summary line 685 shows values for all exercised primitive families | Scheduler package not extracted yet |
| Future memoization | Futures are eager/memoized after first start | Future rows progress once from running to succeeded; duplicate workflow execute returns the same result | Restart recovery for scheduler-local future handles not proven |
| `run` journal step | Named activities beneath future rows | Step `A1`/`B2` output and duplicate execute summary line 685 | Retry policy and run-name parity not implemented |
| `race` | Fast branch wins without cancelling slow branch | Slow loser success at line 169; no interrupted loser spans | Failure/race-settlement semantics not fully modeled |
| `select` | Tagged winner returned while losing branch continues | Losing branch success at lines 218/244 | API shape is `selectByTag`, not final Restate-compatible `select` |
| Pull-wake route flow | Public Durable Streams reserved subscription APIs | Route probe line 12: data/wake streams created, subscription created, claim returned token/wake, held claim blocked, release/reclaim worked, stale ack fenced, ack chained next wake, lease expiry reclaimed, timer append woke subscription | Integration into scheduler is not implemented |
| `awakeable` / `workflowPromise` | Same-workflow resolver completes durable deferreds | Summary line 685 | Public external resolver ingress is not built |
| `spawn` | Child operation can run as a routine-like future and write a routine row | Trace line 284 and summary line 685 | Routine handle/result is not yet mapped onto durable routine rows and reclaim semantics |
| State/channel/client/send/cancel | Thin Restate-shaped helpers over state rows and invocation rows | Summary line 685 plus spans listed above | Scheduler integration/restart semantics not implemented |
| Long sleep | Direct timer-as-append wake plus non-blocking durable clock schedule/fire probe | Route probe line 12 and lines 571/600 | Product scheduler must own timer rows and resume claims |

## Concrete Gaps

1. **The Restate-like scheduler is not yet productized.** The substrate is now
   present: direct Durable Streams pull-wake routes work on
   `@durable-streams/server@0.3.7`, and durable state rows can hold futures,
   waiters, routines, cancellations, and service-call metadata. The missing work
   is the scheduler implementation that turns those rows/routes into reusable
   `Operation<T>` / `Future<T>` semantics.

2. **`spawn` is not yet mapped as a Restate routine handle.** Child work can
   run and the sim writes routine rows, but the routine future should become a
   durable routine row/claim/reclaim contract so restart and worker recovery are
   independent of the current process.

3. **Cancellation is still only partial.** The `run` closure receives an
   `AbortSignal`, and `cancel` writes a cancellation row, but invocation-level
   cancellation still needs a durable cancellation event plus TerminalError-like
   delivery at `yield*` boundaries.

4. **Long sleep needs a scheduler-owned timer row, not Effect Workflow.** The
   final trace proves the substrate wake shape: before the timer append there is
   no pending work; after append the subscription can be claimed. For the direct
   scheduler path, `sleep` should become a parked timer future plus wake/claim
   resume row.

5. **State/sharedState/channel/client primitives are spike helpers.** They are
   useful proof of shape over durable rows, but the free-standing scheduler
   contract should land first.

## Recommendation

If this direction is worth continuing, the next bead should not port Restate's
test suite directly. It should specify a tiny scheduler contract:

- future/routine row schema,
- waiter registration semantics for `race` and `select`,
- mapping of future/routine handles onto durable state rows, pull-wake claims,
  and parked waiter rows,
- direct pull-wake worker loop over `/v1/stream/__ds/subscriptions/*/claim`,
  `/ack`, and `/release`,
- restart behavior for routine-backed futures using durable rows and leases,
- cancellation propagation without relying on `WorkflowEngine.interrupt`.

The key design lesson is that Restate compatibility wants waiter ownership to
be separate from work ownership. With `@durable-streams/server@0.3.7`, Durable
Streams can provide the wake/claim/ack transport directly; the missing layer is
a small scheduler contract that exposes those pieces as Restate-like `Future`
combinators.
