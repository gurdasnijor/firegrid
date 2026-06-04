# tf-bp2t Restate Primitive Compatibility Spike

## Summary

This spike built a hostless tiny-firegrid simulation at
`packages/tiny-firegrid/src/simulations/restate-primitive-compat/`.

The sim now targets the `@restatedev/restate-sdk-gen` center of gravity:
free-standing `Operation<T>` / `Future<T>` combinators (`gen`, `execute`,
`run`, `sleep`, `awakeable`, `all`, `race`, `select`, `spawn`). It does not
model Restate services/objects/workflows first; those are higher-level nouns
that can be rebuilt once the composable scheduler shape is credible.

Compatibility verdict: Firegrid has enough low-level durable pieces to build a
Restate-like composable API, and the lower-layer scheduler shape is promising.
The important proof is that `race` and `select` can resolve a waiter without
owning or interrupting the losing futures. The expanded spike also exercises
state/sharedState, channels, workflow promises, typed-ish clients, generic
call/send, cancellation rows, routine rows, and long-clock schedule/fire.

The spike is still not a product API. The important correction after source
verification is that Firegrid already has workflow-level durable claim/recovery
semantics in `DurableStreamsWorkflowEngine`; the raw Durable Streams HTTP probe
is not the product scheduler surface. The remaining hard gaps are narrower:
the Restate-like `Operation`/`Future` scheduler is not productized over that
engine, `spawn` is not yet mapped to a restart-safe workflow-engine
execution/deferred handle, cancellation is signal fanout rather than Restate's
TerminalError semantics, and typed codegen/descriptors are thin sim helpers.

Primary trace:
`packages/tiny-firegrid/.simulate/runs/2026-06-04T03-38-20-413Z__restate-primitive-compat/trace.jsonl`

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

The trace still records a raw RFC-shaped pull-wake endpoint probe returning
`404 Not Found`. That is a useful layer check, but it should not be read as
"Firegrid lacks durable claim/recovery semantics."

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

Recommendation adjustment: continue the spike at the
`DurableStreamsWorkflowEngine` boundary. Do not design a separate raw RFC 7.2
subscription worker unless a future product decision intentionally bypasses the
workflow engine.

## Mapping

| Restate concept | Firegrid/lower substrate used in sim | Evidence | Tier |
|---|---|---|---|
| `Operation<T>` | Lazy generator factory consumed by `execute` | `gen_body` returns the combined output; summary line 685 lists the free functions exercised | Source-verified in sim |
| `Future<T>` | Scheduler-owned row in `DurableTable` `futures`, plus an eager memoized handle | Future ledger has 39 rows in summary line 685; `state.future_upsert` spans show `pending/running/succeeded` lifecycle | Source-verified in sim |
| `execute(ctx, op)` | `Workflow.make` + `DurableStreamsWorkflowEngine` execute | First and duplicate execute produce identical output in summary line 685 | Source-verified in sim |
| `run(action)` | `Activity.make` under a future row | Step futures succeed via `state.future_upsert`; duplicate execute does not recompute beyond the first workflow execution | Source-verified in sim |
| `sleep(duration)` | `DurableClock.sleep` under a timer-backed future | `tick` participates in `select`; short timer path exercised | Source-verified for short branch; long park/resume not exercised |
| `awakeable<T>()` | `DurableDeferred` token/succeed/await under a future row | Summary line 685 includes `awakeableValue:"awakeable-resolved"` | Source-verified in sim |
| `workflowPromise(name)` | Workflow-bound `DurableDeferred` wrapper | Summary line 685 includes `workflowPromiseValue:"workflow-promise-ok"` | Source-verified in sim |
| `all([...])` | Combinator future awaiting child futures | `all-a-b` and `spawn-and-awakeable` futures reach `succeeded` | Source-verified in sim |
| `race([...])` | Waiter row over child futures, not `Effect.raceAll` owning child fibers | Losing `slow-loser` still writes `succeeded` at line 135; summary line 685 reports 3 losing-branch successes | Source-verified in sim |
| `select({ tag })` | Tagged futures plus waiter row over branch futures | Losing `done` branch writes `succeeded` at lines 215 and 238 | Source-verified in sim |
| `spawn(op)` | Routine-backed future plus `routines` table row | Routine row span at line 284; summary line 685 includes `spawnedValue:"A1-B2:child-step"` and `routine_row_count:1` | Source-verified in sim; product mapping gap inferred |
| `state<T>()` / `sharedState<T>()` | `DurableTable` `stateRows` keyed by workflow or shared scope | State set/get spans at lines 302/316/330/344; summary line 685 reports `state_row_count:2` | Source-verified in sim |
| `channel<T>()` | Single-shot in-memory channel plus durable observation row | Channel receive/send spans at lines 373/375; summary line 685 includes `channelValue:"channel-ok"` and `channel_row_count:1` | Source-verified in sim; durability gap inferred |
| service/object/workflow clients | Thin sim helpers writing `serviceCalls` rows | Client call spans at lines 464/466/468; summary line 685 includes service/object/workflow results | Source-verified in sim; codegen gap inferred |
| `genericCall` / `genericSend` | Thin sim helpers writing `serviceCalls` rows | Generic call span at line 470; send spans include line 538; summary line 685 reports `service_call_row_count:8` | Source-verified in sim |
| `cancel(invocationId)` | Cancellation row plus AbortSignal fanout to `run` closure | Cancel span at line 627; summary line 685 reports `cancellation_row_count:1` | Source-verified in sim; TerminalError semantics not implemented |
| Long `sleep` | Direct `DurableClock` schedule/fire probe | Schedule/schedule_wakeup at lines 571/572 and fire at line 600; blocking await timed out in earlier trace `2026-06-04T03-28-56-091Z` | Source-verified partial support |
| Pull-wake claim/ack/release | Sim-local `claims` table rows + raw RFC-shaped HTTP probe; runtime source provides workflow-level claim/recovery through `DurableStreamsWorkflowEngine` | Summary line 685 reports 39 sim claim rows and raw probe `404 Not Found`; raw probe span at line 12; runtime claim/recovery evidence is listed above | Source-verified at both sim and runtime source layers |
| State protocol rows | `DurableTable` future/waiter/claim collections | Mapping line 8 and `firegrid.durable_table.*` spans show State Protocol-backed table writes | Source-verified in sim |

## Exercise Scenarios

| Scenario family | What the sim exercised | Resulting evidence | Gap |
|---|---|---|---|
| Basic `gen` / `execute` | One operation body yields multiple future families and returns a typed object | Summary line 685 shows values for all exercised primitive families | No published Firegrid package API yet |
| Future memoization | Futures are eager/memoized after first start | Future rows progress once from running to succeeded; duplicate workflow execute returns the same result | Restart recovery for scheduler-local future handles not proven |
| `run` journal step | Named activities beneath future rows | Step `A1`/`B2` output and duplicate execute summary line 685 | Retry policy and run-name parity not implemented |
| `race` | Fast branch wins without cancelling slow branch | Slow loser success at line 135; no interrupted loser spans | Failure/race-settlement semantics not fully modeled |
| `select` | Tagged winner returned while losing branch continues | Losing branch success at lines 215/238 | API shape is `selectByTag`, not final Restate-compatible `select` |
| `awakeable` / `workflowPromise` | Same-workflow resolver completes durable deferreds | Summary line 685 | Public external resolver ingress is not built |
| `spawn` | Child operation can run as a routine-like future and write a routine row | Trace line 284 and summary line 685 | Routine handle/result is not yet mapped onto workflow-engine execution/deferred recovery |
| State/channel/client/send/cancel | Thin Restate-shaped helpers over state rows and invocation rows | Summary line 685 plus spans listed above | Product API/codegen/restart semantics not implemented |
| Long sleep | Non-blocking durable clock schedule/fire probe | Lines 571/572/600 | Blocking await/resume timed out in earlier trace |

## Concrete Gaps

1. **The Restate-like scheduler is not productized over
   `DurableStreamsWorkflowEngine`.** The sim proves an `Operation`/`Future`
   shape and records claim/ack-like scheduler rows. Runtime source shows the
   product engine already has durable execution rows, activity claims, deferred
   recovery, interrupts, and clock wakeups. The next implementation question is
   how to express this scheduler on top of that engine boundary.

2. **`spawn` is not yet mapped as a Restate routine handle.** Child work can
   run and the sim writes routine rows, but the routine future should become a
   workflow-engine execution/deferred handle so restart and reclaim are inherited
   from the existing engine semantics.

3. **Cancellation is still only partial.** The `run` closure receives an
   `AbortSignal`, and `cancel` writes a cancellation row, but invocation-level
   cancellation is not yet mapped to `WorkflowEngine.interrupt`, terminal
   errors, and non-sticky cancellation boundaries.

4. **Long sleep schedule/fire works; blocking await/resume did not complete in
   this sim.** The final trace shows durable clock schedule and fire, and source
   shows startup recovery for pending clock wakeups. An earlier blocking attempt
   timed out after `firegrid.workflow_engine.clock.fire`, so this needs
   isolation as either a sim-scheduler interaction or an engine bug, not a claim
   that the engine lacks clock recovery.

5. **State/sharedState/channel/client primitives are spike helpers.** They are
   useful proof of shape over durable rows, but not polished public APIs and not
   restart/concurrency audited.

6. **Typed API/codegen parity is still unattempted.** This spike is about the
   free-standing combinator substrate. Restate's codegen and service/object
   descriptors remain separate work.

## Recommendation

If this direction is worth continuing, the next bead should not port Restate's
test suite directly. It should specify a tiny scheduler contract:

- future/routine row schema,
- waiter registration semantics for `race` and `select`,
- mapping of future/routine handles onto workflow-engine executions,
  activities, deferreds, and clock wakeups,
- restart behavior inherited from `DurableStreamsWorkflowEngine`,
- cancellation propagation through `WorkflowEngine.interrupt`.

The key design lesson is that Restate compatibility wants waiter ownership to
be separate from work ownership. Firegrid's existing workflow engine appears to
have the durable claim/recovery pieces for the work side; the missing layer is a
small, public scheduler contract that exposes those pieces as Restate-like
`Future` combinators.
