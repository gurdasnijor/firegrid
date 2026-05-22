# S1 — input-suspend-crash-recovery · FINDING

**Verdict: GREEN — the axis-2 durability gap CC3 inferred from the engine source
(Q3 §3) is empirically REAL and characterized.** From
`docs/architecture/2026-05-22-runtime-rearch-closeout.md` §3 / §4: this is the
one open architectural call, and this sim turns it into "pick the variant that's
GREEN under crash + restart."

## What it does

Real `DurableStreamsWorkflowEngine` over a run-scoped Durable Streams server. A
"generation" is one engine scope; closing it drops the in-memory
`running`/`workflows` maps and forked wakeup fibers (= process death) while the
durable rows persist on the server. A fresh engine layer over the SAME stream
URL is a faithful reconstruction — the same move
`DurableStreamsWorkflowEngine.test.ts` VALIDATION.3/.5 make across `runWith`.

The body is the tf-e5rf shape: point-read a workflow-owned input row; if absent,
`Workflow.suspend` (no `DurableDeferred` mailbox); if present, write a durable
processed-marker and complete. The marker is the engine-independent witness that
the body actually ran its consume step.

## Probes & results

| Probe | Sequence | After reconstruction (no re-drive) | After explicit re-drive |
|---|---|---|---|
| **A** — crash between write & resume | park → write input → DROP before `engine.resume` | `processed=false`, `suspended=true`, `finalResult` absent, `deferreds=0` — **input durable, body NEVER ran** | `resume`+`execute` → `processed=true`, value=`delivered-by-A` |
| **B** — restart while parked, input present | park → write input → crash | `processed=false` — **reconstruction alone did NOT re-arm** | single `execute` → `processed=true`, value=`delivered-by-B` |
| **C** — clock contrast control | park on `DurableClock` (400ms) → crash before fire | **`auto-completed=true` with NO explicit resume** | n/a (auto-recovered) |

The assertions encode the *inferred* behavior, so a green run = inference
confirmed; a falsification (e.g. reconstruction silently processing the input)
would `Effect.fail` the driver loudly. Probes A/B observe the parked state
**passively** after reconstruction — calling `execute`/`resume` there would mask
the gap, so the re-drive is a separate generation/step.

## The load-bearing contrast

Probe C is the control: the engine's `recoverPendingClockWakeups`
(`engine-runtime.ts:142`, run at `:500`) re-arms clock wakeups on construction,
so a clock-parked body completes after restart with **no** external action. A
**table-wait-parked body has no equivalent sweep**, so it stays parked until
something explicitly calls `resume`/`execute`. Same engine, same crash, opposite
outcome — that asymmetry is the gap, and it points straight at the fix shape.

## Implication for the architect's axis-2 decision

The recovery a table-wait needs is exactly what clocks already get. The two
fix variants the close-out lists map cleanly:
- **(ii) restart pending-suspension recovery sweep** — mirror
  `recoverPendingClockWakeups` for non-clock suspensions (re-`resume` parked
  executions on construction). Directly closes Probe A *and* B.
- **(iii) kernel-owned writer that owns write+arm as one step** — makes the
  write-then-resume pair atomic from the caller's view (closes the Probe A race
  at the source).

This sim already exercises the *recovery primitive both fixes rely on* — an
explicit `resume`/`execute` after reconstruction deterministically recovers the
parked body (Probes A & B "after re-drive" columns). What it does **not** yet
build is variant (i) "atomic append-and-arm" as an engine primitive (that
crosses into engine internals) or the automatic sweep itself; those are the
follow-on implementation slices the GREEN verdict unblocks.

## Run

```
pnpm --filter @firegrid/tiny-firegrid simulate run input-suspend-crash-recovery
```

Spans: ~156, all under `firegrid.s1.*`; per-phase observation booleans
(`*.input_processed`, `*.has_final_result`, `*.suspended`, `*.deferred_count`)
and markers (`wrote-input-resume-lost`, `reconstructed-no-redrive`,
`resume-replayed-recovered`, `reconstructed-input-present-no-rearm`,
`reconstructed-clock-auto-fired`) make the crash/restart boundary observable in
the trace.
