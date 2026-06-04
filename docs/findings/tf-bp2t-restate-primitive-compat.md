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
owning or interrupting the losing futures. The spike is still not a product API:
the future ledger and pull-wake lifecycle are sim-local, `spawn` is not durable
as a routine handle across restart, and cancellation/client/state/channel
families are not implemented.

Primary trace:
`packages/tiny-firegrid/.simulate/runs/2026-06-04T03-09-23-741Z__restate-primitive-compat/trace.jsonl`

Runner summary:

```text
outcome: DriverCompleted
spans: 327
sides: driver=326
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

## Mapping

| Restate concept | Firegrid/lower substrate used in sim | Evidence | Tier |
|---|---|---|---|
| `Operation<T>` | Lazy generator factory consumed by `execute` | `gen_body` returns the combined output; summary line 323 lists the free functions exercised | Source-verified in sim |
| `Future<T>` | Scheduler-owned row in `DurableTable` `futures`, plus an eager memoized handle | Future ledger has 16 rows in summary line 323; `state.future_upsert` spans show `pending/running/succeeded` lifecycle | Source-verified in sim |
| `execute(ctx, op)` | `Workflow.make` + `DurableStreamsWorkflowEngine` execute | First and duplicate execute produce identical output in summary line 323 | Source-verified in sim |
| `run(action)` | `Activity.make` under a future row | Step futures succeed via `state.future_upsert`; duplicate execute does not recompute beyond the first workflow execution | Source-verified in sim |
| `sleep(duration)` | `DurableClock.sleep` under a timer-backed future | `tick` participates in `select`; short timer path exercised | Source-verified for short branch; long park/resume not exercised |
| `awakeable<T>()` | `DurableDeferred` token/succeed/await under a future row | Summary line 323 includes `awakeableValue:"awakeable-resolved"` | Source-verified in sim |
| `all([...])` | Combinator future awaiting child futures | `all-a-b` and `spawn-and-awakeable` futures reach `succeeded` | Source-verified in sim |
| `race([...])` | Waiter row over child futures, not `Effect.raceAll` owning child fibers | Waiter resolves to `fast-winner` at trace line 128; losing `slow-loser` still writes `succeeded` at line 130 | Source-verified in sim |
| `select({ tag })` | Tagged futures plus waiter row over branch futures | Waiter resolves to `select/tick` at line 212; losing `done` branch still writes `succeeded` at lines 210 and 218 | Source-verified in sim |
| `spawn(op)` | Routine-backed future running a child operation | Summary line 323 includes `spawnedValue:"A1-B2:child-step"` | Source-verified in sim; durability gap inferred |
| Pull-wake claim/ack/release | `claims` table rows + claim/ack spans, modeled after Durable Streams RFC | Summary line 323 reports 16 claim rows; claim/ack spans appear throughout trace | Source-verified in sim; HTTP subscription worker is inferred future work |
| State protocol rows | `DurableTable` future/waiter/claim collections | Mapping line 8 and `firegrid.durable_table.*` spans show State Protocol-backed table writes | Source-verified in sim |

## Exercise Scenarios

| Scenario family | What the sim exercised | Resulting evidence | Gap |
|---|---|---|---|
| Basic `gen` / `execute` | One operation body yields multiple future families and returns a typed object | Summary line 323 shows `allValue`, `raceValue`, `selectTag`, `spawnedValue`, `awakeableValue` | No published Firegrid package API yet |
| Future memoization | Futures are eager/memoized after first start | Future rows progress once from running to succeeded; duplicate workflow execute returns the same result | Restart recovery for scheduler-local future handles not proven |
| `run` journal step | Named activities beneath future rows | Step `A1`/`B2` output and duplicate execute summary line 323 | Retry policy and run-name parity not implemented |
| `race` | Fast branch wins without cancelling slow branch | Waiter winner at line 128; slow loser success at line 130; no interrupted loser spans | Failure/race-settlement semantics not fully modeled |
| `select` | Tagged winner returned while losing branch continues | Select winner at line 212; losing branch success at lines 210/218 | API shape is `selectByTag`, not final Restate-compatible `select` |
| `awakeable` | Same-workflow resolver completes a durable deferred | Summary line 323 | Public external resolver ingress is not built |
| `spawn` | Child operation can run as a routine-like future | Summary line 323 | Routine handle/result is not durable across restart |

## Concrete Gaps

1. **No product scheduler yet.** The sim proves a lower-level shape, but the
   scheduler ledger is local to this workbench. A production design would need
   real Durable Streams subscription workers using claim/ack/release leases and
   generation fencing.

2. **`spawn` is not durable as a Restate routine handle.** Child work can run,
   and child activities can be durable, but the routine future itself is still
   owned by this process.

3. **Cancellation is only sketched.** The `run` closure receives an
   `AbortSignal`, but invocation-level cancellation, terminal errors, and
   non-sticky cancellation boundaries are not implemented.

4. **Long sleep/resume is not covered.** The trace exercises the short
   `DurableClock.sleep` branch so the sim completes quickly.

5. **State/sharedState/channel/client primitives are absent.** The ledger uses
   `DurableTable` internally, but the user-facing `state<T>()`,
   `sharedState<T>()`, channels, typed clients, generic calls, sends, workflow
   promises, and cancellation APIs were not built.

6. **Typed API/codegen parity is unattempted.** This spike is about the
   free-standing combinator substrate. Restate's codegen and service/object
   descriptors remain separate work.

## Recommendation

If this direction is worth continuing, the next bead should not port Restate's
test suite directly. It should specify a tiny scheduler contract:

- future/routine row schema,
- waiter registration semantics for `race` and `select`,
- pull-wake worker claim/ack/release lifecycle,
- restart behavior for routine-backed futures,
- cancellation propagation boundaries.

The key design lesson is that Restate compatibility wants waiter ownership to
be separate from work ownership. The lower Durable Streams protocols appear to
support that split; the higher Effect `race` abstraction does not provide it by
itself.
