# Workflow Body Authoring Rule: Single-Suspension-Per-Step

Status: load-bearing authoring rule
Created: 2026-05-20
Last amended: 2026-05-20 (Lane 2 / tf-xw0w second-rail confirmation)
Owner: Firegrid Runtime / Workflow Engine
Empirical origins:
- tf-vnc8 Phase-1 Lane 1 (PR #471, commit b31174a73) — Stream.merge case
- tf-xw0w Phase-1 Lane 2 (engine-runtime patches under tf-xw0w) — `DurableDeferred.raceAll` case

## The Rule

> **Workflow bodies are single-fiber-sequential-execution. Each step must have
> a single coherent suspension point: one `DurableDeferred.await`, one
> `Activity.execute`, or one engine primitive that internally manages its own
> coordination. Any combinator that forks concurrent fibers within the body —
> stream-, race-, or fiber-based, including durable variants — composes
> against the engine's single-fiber suspension model and will pin or
> misbehave on engines that lack cluster-style coordination machinery.**

This is a structural property of how `@effect/workflow` + Firegrid's
`DurableStreamsWorkflowEngine` model execution. It is not a temporary
limitation, not a TODO, and not a recycle-invariant bug. The engine's
execution model is sequential-with-deferred-suspension by design; concurrent
fiber composition inside the body violates the model.

**Important nuance**: some `@effect/workflow`-shipped primitives
(`DurableDeferred.raceAll`, `Activity.raceAll`) ARE intended to be used
inside workflow bodies, but they require **engine-side coordination
machinery** to work correctly. `ClusterWorkflowEngine` has that machinery
(RPC FiberId discrimination + active-deferred resume flow);
`DurableStreamsWorkflowEngine` does not, so those primitives misbehave there
unless additional engine work fills the gap. Portable workflow bodies should
not rely on them.

## Canonical Working Pattern

Lane 1 (tf-vnc8) landed the production runtime-context body using a sequential
peek/await state machine. The pattern is the canonical shape for "wait on
multiple potential progress sources without forking concurrent fibers":

`packages/host-sdk/src/host/runtime-context-workflow-core.ts:486-531`

```ts
const loop = (lastOutputSequence, nextInputSequence) =>
  Effect.gen(function*() {
    // 1. Non-blocking peek on side A (input)
    const input = yield* completedRuntimeInput(context, nextInputSequence)
    if (input !== undefined) {
      // Process the side that already has progress; no suspension
      yield* handleRuntimeInput(...)
      return yield* loop(lastOutputSequence, nextInputSequence + 1)
    }
    // 2. Neither side has progress → single blocking await on side B (output)
    return yield* followAgentOutput(lastOutputSequence, nextInputSequence)
  })
```

Two primitives make this work:

**Non-blocking peek** (`runtime-context-workflow-core.ts:241-261`):

```ts
const completedRuntimeInput = (context, sequence) =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const exit = yield* Workflow.wrapActivityResult(
      engine.deferredResult(runtimeInputDeferredFor(...)),
      Predicate.isUndefined,
    )
    if (exit === undefined) return undefined   // not yet resolved → no suspend
    return yield* exit
  })
```

The `Workflow.wrapActivityResult(..., Predicate.isUndefined)` wrapping
converts "deferred not yet resolved" into a non-suspending `undefined`
return. The body decides whether to commit to a blocking wait *after*
checking what is already available.

**Blocking await** (`runtime-context-workflow-core.ts:263-276`):

```ts
const awaitRuntimeInput = (context, sequence) =>
  DurableDeferred.await(runtimeInputDeferredFor(...))
```

Standard single-deferred await. Exactly one suspension point per loop
iteration.

The combined pattern: **peek both sides non-blockingly; process whichever has
progress; suspend on one side only if neither has progress.**

## First Failure Case: `Stream.merge` Inside The Body

The literal `Stream.merge(inputs, outputs).runForEach(handler)` shape that
Lane 1 attempted before pivoting pins workflow suspension. Mechanism:

1. `Stream.merge` forks two pulling fibers — one per upstream stream.
2. Each pulling fiber, when its upstream durable stream has no available row,
   suspends on the stream's underlying deferred.
3. The workflow engine's suspend/resume model is single-fiber-per-execution:
   it expects exactly one `Workflow.suspend(instance)` call to define the
   wake signal.
4. With two concurrent pulling fibers each potentially suspended, the engine
   cannot coherently model "what wakes this execution."
5. When one side's deferred resolves and the workflow resumes, the body
   replays from the start. `Stream.merge` re-forks both pulling fibers. They
   re-check their deferreds. One has a result; the other doesn't. The
   unresolved-side fiber re-suspends. Workflow re-enters suspended state.

Net: the workflow is **pinned in a suspend/resume cycle** that makes no
forward progress beyond the side that initially had a row.

## Second Failure Case: `DurableDeferred.raceAll` Inside The Body

Lane 2 (tf-xw0w) cutting agent-tool `wait_for` over to the INV-2 shape hit
the same structural pattern at a different combinator. The `WaitForWorkflow`
body:

```ts
DurableDeferred.raceAll({
  name,
  effects: [
    Activity.make({ execute: Stream.runHead(filteredSource) }),
    DurableClock.sleep({ duration: timeoutMs }),
  ],
})
```

is **race-based multi-fiber composition** with two independent suspension
points. Same class as `Stream.merge`; just durable.

Empirical observations from Lane 2:

- **Match case passes** — when the Activity branch wins (source row matches
  before timeout), the result propagates up through `raceAll` inside the
  same fiber. No cross-fiber coordination needed; works fine.
- **Same-generation timeout case hangs** — when the Clock branch wins:
  1. Clock fires externally; `engine.deferredDone(clockDeferred, Success)`
     called.
  2. Clock-deferred row written; `resume(executionId)` called.
  3. Resume sees the body fiber is alive-but-not-terminated (still inside
     `raceAll`'s coordination); early-exits without re-executing.
  4. raceAll never receives the clock resolution; Activity branch stays
     blocked on `Stream.runHead`; no race deferred written.
  5. Workflow pinned, Activity claim never released.

This is the same multi-fiber pinning pattern Stream.merge exhibits, expressed
through `DurableDeferred.raceAll`. The engine's running-fiber tracking
can't model "the body is inside raceAll waiting on N independent deferreds"
distinctly from "the body fiber is just running normally."

## Why `DurableDeferred.raceAll` Works In Cluster But Not Here

`@effect/workflow` ships `DurableDeferred.raceAll` and `Activity.raceAll`
intending them to be safe inside workflow bodies.
`ClusterWorkflowEngine.ts` makes them work via **cluster-specific
coordination machinery**:

- **RPC FiberId discriminator** (line 322-333): the activity execution path
  checks `Cause.interruptors(cause)` for the `RpcServer.fiberIdClientInterrupt.id`
  fiber. ONLY that specific FiberId converts an interrupt to `Suspended`.
  raceAll-coordinator interrupts have different FiberIds → propagate as
  failures. This cleanly distinguishes engine-recycle from in-workflow
  coordination.
- **Active-deferred resume flow** (line 219-234, `sendResumeParent`): when
  any deferred completes, the engine actively pokes the awaiting workflow
  via `engine.deferredDone` → write row → resume entity. The cluster entity
  model handles the wake-up.
- **`interruptedActivities` set** (line 110): tracks which activities have
  been interrupted-as-suspends so the engine knows which ones to re-execute
  on resume.

`DurableStreamsWorkflowEngine` doesn't have these. Lane 2's patches are
retrofitting cluster-equivalent machinery one piece at a time:

- PR #470's recycle invariant ≈ partial RPC-FiberId-discriminator (uses a
  durable `interrupted` flag + a new in-memory `recycling` Ref as the
  discriminator)
- Lane 2's force-interrupt-on-deferred-done patch ≈ partial active-deferred
  resume flow (forces fiber termination when external deferred resolves,
  so resume can re-execute)

Both patches keep working only because they're closing a specific gap. The
underlying body shape (`raceAll` inside the body) keeps surfacing more
gaps because the rule above is being violated structurally.

## Why This Is NOT The Engine-Recycle Bug

PR #470 (tf-gyxc) fixed the engine-recycle invariant: scope-close interrupts
must classify as `Workflow.Suspended`, not as cancellation. That fix concerns
how the engine interprets interrupt *causes* during scope teardown.

The body-suspension pins from both Stream.merge and `DurableDeferred.raceAll`
happen during normal execution, not during scope close. The mechanisms are
related but distinct:

| Concern | Recycle (PR #470) | Body-suspension pin |
| --- | --- | --- |
| Trigger | Scope close during in-flight Activity | Normal body execution with concurrent fiber composition |
| Cause | Interrupt misclassified as cancellation | Multi-fiber suspension state in single-fiber-model engine |
| Fix shape | Engine-side interrupt classification | Body-authoring rule (this document) + engine primitive replacement |
| Code location | `engine-runtime.ts` `activityExecute` | Workflow body composition |

PR #470 + Lane 2's follow-on patches partially compensate the engine for
the body-suspension issue by re-implementing cluster-engine machinery.
That compensation has a finite useful life — once an engine-native
multi-source primitive lands (next section), the patches become dead code
because the body shape they're propping up no longer exists in production.

## The Legitimate Multi-Source Use Case

Workflow bodies that genuinely need "wait on N sources, wake on the first to
emit" should NOT compose this from fiber-based combinators in the body —
durable or otherwise. The correct shape is an **engine-native primitive**
that handles multi-source coordination internally and exposes a single
suspension point to the body.

Per `docs/sdds/SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH.md`, the
`streamWaitAny` primitive is the right resolution:

```ts
// Correct shape, once the primitive lands:
yield* engine.streamWaitAny({
  name,
  waits: [
    { source: inputStream, predicate: ... },
    { source: outputStream, predicate: ... },
  ],
  timeoutMs,
})
```

The engine internally:
- Persists one parent wait-any intent
- Persists child stream-wait intents
- First child winner finalizes the parent
- Re-attaches all unresolved children across engine generations
- Surfaces as exactly **one** `Workflow.suspend(instance)` call from the
  body's perspective

**Decision-trigger status (escalated 2026-05-20)**: with Lane 2 confirming
the same composition leak at a second combinator, `streamWaitAny` has moved
from "P1 design bead" to **load-bearing follow-up for Lane 2's eventual
cleanup**. Lane 2's engine patches keep working in the short term, but the
target end state is `WaitForWorkflow` lowered onto `streamWaitAny` — at
which point the patches become unnecessary or scope down dramatically.

Until `streamWaitAny` lands:
- Lane 1's peek/await state machine pattern is the canonical workaround for
  multi-source coordination
- Lane 2's engine patches keep `DurableDeferred.raceAll` working in the
  durable-streams engine
- New workflow bodies should prefer the peek/await pattern over `raceAll`
  where possible

## Combinators To Avoid In Workflow Bodies

Non-exhaustive but indicative — any of these inside a body will pin or
misbehave for the same reason:

| Forbidden | Reason |
| --- | --- |
| `Stream.merge(a, b).runForEach(...)` | Forks N pulling fibers; multi-fiber suspension |
| `Stream.race(a, b).runHead` | Same as above |
| `Stream.zipLatest(a, b)` with potentially-empty sides | Requires both sides emit; multi-fiber wait |
| `Effect.race(eA, eB)` where either effect suspends | Multi-fiber suspension |
| `Effect.fork(eA)` followed by waiting in the body | Same |
| `Fiber.join` on any forked fiber | Same |
| `DurableDeferred.raceAll([effA, effB])` where branches have independent suspension points | Same class; durable variant. Works in `ClusterWorkflowEngine` via cluster-side coordination machinery; needs equivalent retrofits in `DurableStreamsWorkflowEngine` to behave correctly. Use `streamWaitAny` engine primitive instead. |
| `Activity.raceAll([actA, actB])` | Same — racing activities racks the same multi-fiber issue. |

A useful test before writing a body: **can you describe its execution as a
sequential chain of "do work, then suspend on exactly one deferred, then
resume" steps?** If not, the body is forking concurrency that the engine
cannot model coherently without engine-side coordination machinery.

Multi-source coordination, retries with timeouts, parallel work — all valid
needs. They belong inside Activities (which run outside the body's execution
model and are recycle-safe per PR #470) or inside engine primitives, not
inside the body itself.

## What To Do When You Need This Shape

In priority order:

1. **Sequential peek/await state machine** (this document's canonical
   pattern). Works today on `DurableStreamsWorkflowEngine` and any other
   engine. Lane 1's implementation is the reference.
2. **Move concurrency into an `Activity.make`** body. Activities run
   outside the workflow body's execution model; their internal concurrency
   doesn't interact with the engine's suspension model. Activity result is
   surfaced as one resolved value to the body.
3. **Wait for `engine.streamWaitAny`** (engine-primitives SDD). Cleanest
   long-term shape for "wait on N sources." Now elevated to load-bearing
   follow-up per Lane 2's empirical confirmation.

## Engine-Implementation-Dependent Primitives

Some `@effect/workflow`-shipped primitives ARE designed for use inside
workflow bodies but require engine-side coordination machinery. Treat as
**engine-implementation-dependent**:

| Primitive | Cluster engine | Durable-streams engine |
| --- | --- | --- |
| `DurableDeferred.await` (single deferred) | Works | Works |
| `DurableDeferred.raceAll` (multi-source) | Works (cluster machinery) | Requires engine-side patches |
| `Activity.raceAll` | Works (cluster machinery) | Same as raceAll above |
| `DurableClock.sleep` | Works | Works |
| `Activity.make + Activity.execute` (single Activity) | Works | Works |

Portable workflow bodies should rely only on the "works in both" row.
Engine-dependent primitives are acceptable when you know which engine the
body runs on, but PR reviews should flag them and require either:
- explicit migration path to an engine-native equivalent, or
- explicit annotation that the body is engine-specific.

## References

- Lane 1 commit: `b31174a73` — tf-vnc8 Phase-1 Lane 1 runtime-context stream body (Stream.merge case)
- Lane 2 work: tf-xw0w Phase-1 Lane 2 WaitForWorkflow cutover (`DurableDeferred.raceAll` case)
- Production peek/await state machine:
  `packages/host-sdk/src/host/runtime-context-workflow-core.ts:486-531`
- Non-blocking peek primitive:
  `packages/host-sdk/src/host/runtime-context-workflow-core.ts:241-261`
- Engine recycle invariant (PR #470, distinct from this rule):
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`
  commit `1ca9e4696` (tf-gyxc)
- Lane 2 engine-runtime patches (recycling Ref + force-interrupt-on-deferred-done):
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts` tf-xw0w branch
- Forward-looking primitive:
  `docs/sdds/SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH.md` §
  Candidate Primitives §2 `streamWaitAny`
- Workflow engine execution model:
  `repos/effect/packages/workflow/src/Activity.ts:239-259` (single-fiber
  Activity execution boundary)
  `repos/effect/packages/workflow/src/Workflow.ts` (`Workflow.suspend`
  instance-flag-based suspension)
- Cluster-engine reference machinery (for understanding what
  `DurableStreamsWorkflowEngine` is retrofitting):
  `repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts:298-345`
  (activity execution with FiberId discrimination)
  `repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts:219-234`
  (resume flow)

## Status For Coordinator

This document closes the Stream.merge pinned-suspension investigation
(originally proposed as tf-h17r) and the conceptual half of Lane 2's
`DurableDeferred.raceAll` blocker. Verdict: both are instances of the same
workflow-body authoring constraint, not engine-recycle contingency-triggers.

**Actions outstanding:**

1. **Lane 2's engine patches** ship as-is for tactical unblock. They
   correctly compensate for the missing cluster-engine machinery in the
   durable-streams adapter.
2. **`streamWaitAny` engine primitive** is escalated to load-bearing
   follow-up. Per engine-primitives SDD; Lane 2's findings are the
   second-rail confirmation that the primitive is needed structurally, not
   just as optimization.
3. **`WaitForWorkflow` migration** to `streamWaitAny` (once available)
   becomes the long-term cleanup that retires Lane 2's engine patches.
4. **tf-0mt5 contingency anchor** should record: contingency-trigger #1 did
   **not** fire on either case; both shapes were structurally incompatible
   with the engine model from the start.

**Memory item worth adding for future-coordinator recall**: "Workflow bodies
are single-fiber-sequential. Concurrent stream/race/fiber combinators —
including durable variants like `DurableDeferred.raceAll` — pin execution
on engines without cluster-style coordination machinery. Multi-source needs
go through engine primitives (`streamWaitAny`), not body-level composition."
