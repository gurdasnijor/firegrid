# `@effect/workflow` as Firegrid's Durable Execution Substrate

Status: research / decision proposal. Not a spike result. Reads
`docs/research/durable-clock-spike.md` as evidence for one specific
claim (the in-process Clock path), but the substantive question
here is independent: should Firegrid adopt `@effect/workflow` for
cross-process durable execution, and if so what does Firegrid
actually have to build?

Source files referenced are pinned to Effect SHA
`54e61b3e08ab30a52fb20eba3104a83b99f443fa` at
`/Users/gnijor/gurdasnijor/effect/packages/workflow/src/`.

## Premise

The Durable Clock spike (`docs/research/durable-clock-spike.md`)
established that a `Layer.setClock`-installed Clock cannot, on its
own, carry continuation across process death. The durable wake-up
record survives; the suspended work does not.

That gap can be closed in one of two ways:

1. Firegrid designs and ships its own primitive — variously named
   `RunStep`, `DurableContinuation`, `DurableProcessor` — that
   associates a durable wake-up with re-runnable work and replays
   it when the dispatcher fires.
2. Firegrid adopts `@effect/workflow`, which already provides this
   primitive as `WorkflowEngine` + `Workflow` + `Activity` +
   `DurableDeferred` + `DurableClock`.

This document evaluates option 2. It claims the integration is
small and well-bounded: one `WorkflowEngine.Encoded` implementation
backed by Durable Streams + State Protocol, plus Firegrid's typed
descriptor surface mapped onto upstream `Workflow` definitions.

## What `@effect/workflow` provides

| Concept | File | Role |
|---|---|---|
| `Workflow.make({ name, payload, idempotencyKey, success?, error? })` | `Workflow.ts:263-359` | Workflow definition. `executionId` is derived deterministically from `name + idempotencyKey(payload)`. Has `execute / poll / interrupt / resume / toLayer / executionId / withCompensation` operations. |
| `Workflow.Result<A, E> = Complete<A, E> \| Suspended` | `Workflow.ts:400-489` | The discriminated union returned by every workflow / activity / deferred-await execution. Serializable via `Result.Schema`. |
| `Workflow.intoResult(effect)` | `Workflow.ts:511-555` | Wraps an Effect so its outcome becomes a `Workflow.Result`. Drives the `instance.suspended` flag, `SuspendOnFailure` annotation, scope close. |
| `Workflow.suspend(instance)` | `Workflow.ts:680-685` | Sets `instance.suspended = true` and self-interrupts the running fiber. |
| `Activity.make({ name, success?, error?, execute, interruptRetryPolicy? })` | `Activity.ts:85-126` | Journaled side-effect primitive. Returns an Effect requiring `WorkflowEngine \| WorkflowInstance`. Builds an `executeEncoded` that round-trips success/error through Schema. Includes interrupt-retry under a default `Schedule.exponential(100, 1.5) ∪ Schedule.spaced("10s") ∪ Schedule.recurs(10)` filtered to interrupted causes. |
| `Activity.retry(effect, options)` | `Activity.ts:152-169` | Provides `CurrentAttempt` (a `Context.Reference`) per retry. Engine receives the attempt number and uses it as part of the durable activity key. |
| `Activity.idempotencyKey(name, options?)` | `Activity.ts:183-199` | Hash digest of `${executionId}-${attempt?}-${name}` for adapter-side idempotency. |
| `DurableDeferred.make(name, options?)` | `DurableDeferred.ts:62-87` | Persisted promise. Schema-typed; encodes/decodes exits via `exitSchema = Schema.ExitFromSelf({ success, failure, defect: Schema.Defect })`. |
| `DurableDeferred.await(self)` | `DurableDeferred.ts:102-122` | Reads `engine.deferredResult(self)`; if absent, calls `Workflow.suspend(instance)`. On engine resume, this read returns the durable exit and the workflow continues. |
| `DurableDeferred.into(effect, self)` | `DurableDeferred.ts:136-183` | Run an Effect and on exit call `engine.deferredDone(self, ...)`. Used to fold an arbitrary Effect outcome into a durable deferred slot. |
| `DurableDeferred.token(self) / done / succeed / fail / failCause` | `DurableDeferred.ts:310-524` | Out-of-process resolver: a `Token` is `base64url(JSON.stringify([workflowName, executionId, deferredName]))`, allowing external code to write into a deferred slot from a different process. |
| `DurableClock.sleep({ name, duration, inMemoryThreshold? })` | `DurableClock.ts:71-105` | Workflow-side sleep API. ≤ 60s default → `Activity.make({ execute: Effect.sleep(duration) })` (honors the live Effect Clock). > threshold → `engine.scheduleClock(...) + DurableDeferred.await(clock.deferred)`. |
| `WorkflowEngine` `Context.Tag` | `WorkflowEngine.ts:20-183` | Typed surface workflows consume. Eight typed methods + `register` ⇒ nine total. |
| `WorkflowInstance` `Context.Tag` | `WorkflowEngine.ts:189-246` | Per-execution mutable state: `executionId`, `workflow`, `scope: Scope.CloseableScope`, `suspended`, `interrupted`, `cause`, `activityState: { count, latch }`. |
| `WorkflowEngine.Encoded` | `WorkflowEngine.ts:252-311` | The implementation surface — nine methods, all with `unknown`-typed payloads/exits. Schema encode/decode lives in the typed wrapper, not here. |
| `WorkflowEngine.makeUnsafe(encoded)` | `WorkflowEngine.ts:317-458` | Wraps an `Encoded` impl with the typed boundary: handles Schema encode/decode, attempt loop on `Suspended`, parent-workflow interrupt linkage, `suspendedRetrySchedule` driver. |
| `WorkflowEngine.layerMemory` | `WorkflowEngine.ts:468-639` | Reference in-memory implementation. Four Maps + a `FiberMap` of pending clock fibers. ~170 LOC. |

## The `Encoded` surface — what an implementation actually provides

From `WorkflowEngine.ts:252-311`. Nine methods, all on `unknown`-typed
exits:

| Method | What it does |
|---|---|
| `register(workflow, execute)` | Record workflow definition + handler in-process. Scope-bound. |
| `execute(workflow, { executionId, payload, discard, parent? })` | Drive execution. Returns `Workflow.Result<unknown, unknown>` (or void for discard). |
| `poll(workflow, executionId)` | Non-blocking peek at the result. |
| `interrupt(workflow, executionId)` | Set interrupted flag + re-fire `resume`. |
| `resume(workflow, executionId)` | Re-run the registered handler under a fresh `WorkflowInstance`. Activity / deferred reads short-circuit on durable-row presence. |
| `activityExecute(activity, attempt)` | Run an activity once; persist its `Workflow.Result`. Attempt is part of the durable key. |
| `deferredResult(deferred)` | Read encoded `Exit` for the current instance's `${executionId}/${deferredName}`. |
| `deferredDone({ workflowName, executionId, deferredName, exit })` | Write encoded exit. First-write-wins. After write, `resume(executionId)`. |
| `scheduleClock(workflow, { executionId, clock })` | After `clock.duration`, call `deferredDone(clock.deferred, Exit.void)`. Dedup on `(executionId, clockName)`. |

Schema encode/decode is owned by `makeUnsafe`:

- `makeUnsafe.deferredDone` (`WorkflowEngine.ts:437-455`) calls
  `Schema.encode(deferred.exitSchema)` before passing to
  `Encoded.deferredDone`.
- `makeUnsafe.deferredResult` (`WorkflowEngine.ts:420-435`) calls
  `Schema.decodeUnknown(deferred.exitSchema)` on what
  `Encoded.deferredResult` returns.
- `Activity.make.executeEncoded` (`Activity.ts:116-119`)
  round-trips through `Schema.encode` for success and error before
  the engine sees the value.

The implementation treats stored exits as opaque blobs.

## Storage shape for a Durable Streams + State Protocol implementation

`layerMemory` (`WorkflowEngine.ts:482-498, 535-537`) uses four
in-process Maps + a `FiberMap`. Each Map is a primary-keyed insert/update
collection — i.e. exactly what `@durable-streams/state`'s
`createStateSchema` expresses.

```ts
import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

const ExitEncoded = Schema.Unknown    // shape provided by deferred.exitSchema / activity.exitSchema at the typed boundary
const ResultEncoded = Schema.Unknown  // Workflow.Result<unknown, unknown> after Schema.encode

const workflowEngineSchema = createStateSchema({
  executions: {
    type: "workflow.execution",
    primaryKey: "executionId",
    schema: Schema.standardSchemaV1(Schema.Struct({
      executionId: Schema.String,
      workflowName: Schema.String,
      payloadEncoded: Schema.Unknown,
      parentExecutionId: Schema.optional(Schema.String),
      suspended: Schema.Boolean,
      interrupted: Schema.Boolean,
      causeEncoded: Schema.optional(Schema.Unknown),
      finalResultEncoded: Schema.optional(ResultEncoded),
    })),
  },
  activities: {
    type: "workflow.activity",
    primaryKey: "activityKey",          // = `${executionId}/${activity.name}/${attempt}`
    schema: Schema.standardSchemaV1(Schema.Struct({
      activityKey: Schema.String,
      executionId: Schema.String,
      activityName: Schema.String,
      attempt: Schema.Number,
      resultEncoded: ResultEncoded,
    })),
  },
  deferreds: {
    type: "workflow.deferred",
    primaryKey: "deferredKey",          // = `${executionId}/${deferredName}`
    schema: Schema.standardSchemaV1(Schema.Struct({
      deferredKey: Schema.String,
      executionId: Schema.String,
      deferredName: Schema.String,
      workflowName: Schema.String,
      exitEncoded: ExitEncoded,
    })),
  },
  clockWakeups: {
    type: "workflow.clock-wakeup",
    primaryKey: "clockKey",             // = `${executionId}/${clockName}`
    schema: Schema.standardSchemaV1(Schema.Struct({
      clockKey: Schema.String,
      executionId: Schema.String,
      workflowName: Schema.String,
      clockName: Schema.String,
      deferredName: Schema.String,      // == clock.deferred.name
      deadlineMs: Schema.Number,
      status: Schema.Literal("pending", "fired"),
    })),
  },
})
```

Four collections. `register` is in-memory only; handlers live in app
code and are re-registered on every process startup before any
resume sweep runs.

State Protocol primary-key insert/update semantics give us the
properties the engine needs:

- First-write-wins on `deferreds[deferredKey]` is the durable-race
  guarantee `DurableDeferred.done` relies on. `layerMemory`
  enforces this with `if (deferredResults.has(id)) return` at
  `WorkflowEngine.ts:618-622`. State Protocol's PK uniqueness
  enforces it without explicit conditional.
- `activities[activityKey]` short-circuit on replay is "row exists"
  → return persisted result. Same shape.
- `clockWakeups[clockKey]` dedup on `(executionId, clockName)` is
  what `FiberMap.run({ onlyIfMissing: true })` does in
  `layerMemory.scheduleClock` (`WorkflowEngine.ts:624-634`).

## Two non-trivial implementation pieces

Everything else in `Encoded` is direct read/write. These two need
care:

### 1. Suspended-execution resume sweep on process startup

`Workflow.suspend` (`Workflow.ts:680-685`) self-interrupts the fiber
after setting `instance.suspended = true`. The typed `execute`
wrapper (`WorkflowEngine.ts:391-401`) catches the suspend and loops
under a `defaultRetrySchedule = Schedule.exponential(200, 1.5) ∪
Schedule.spaced(30s)`. Without process-death survival, this is the
live retry mechanism: the workflow polls itself back into runnable
state at most every 30 seconds.

For Firegrid's implementation, on process startup:

1. Wait for app code to call `register` for every workflow definition.
   Handlers cannot be reconstructed from durable rows; they live in
   app code and must be re-registered.
2. Sweep `executions` rows where `suspended = true` and
   `finalResultEncoded` is absent. For each, fork
   `engine.resume(workflow, executionId)`. The handler re-runs;
   `activityExecute` and `deferredResult` short-circuit on durable
   rows; the handler reaches the same `Workflow.suspend` /
   `Activity` / `DurableDeferred.await` point and either makes
   progress or suspends again.

This sweep is the cross-process re-dispatch the Clock spike named
as missing. It is owned by the engine implementation.

### 2. Clock wakeup dispatcher

`scheduleClock` in `layerMemory` (`WorkflowEngine.ts:624-634`):

```ts
scheduleClock: (workflow, options) =>
  engine.deferredDone(options.clock.deferred, { ... exit: Exit.void })
    .pipe(
      Effect.delay(options.clock.duration),
      FiberMap.run(clocks, `${options.executionId}/${options.clock.name}`,
                   { onlyIfMissing: true }),
      Effect.asVoid,
    )
```

Two semantic atoms: **delay by `clock.duration`** and **dedup by
`(executionId, clockName)`**.

Firegrid's durable equivalent:

- On `scheduleClock`, append a `clockWakeups` row keyed by
  `clockKey = ${executionId}/${clockName}`. Primary-key uniqueness
  gives the dedup that `FiberMap.run({ onlyIfMissing: true })`
  gives in-process.
- A long-running engine fiber polls `clockWakeups` for `status =
  "pending" AND deadlineMs <= now`. For each due row, update
  `status = "fired"` AND call `engine.deferredDone(...)` for
  `clock.deferred` with `Exit.void`. `deferredDone` is itself
  first-write-wins on the `deferreds` row, so duplicate dispatcher
  fires are idempotent.

This dispatcher is structurally identical to the
`WakeupStore` + `DurableClockDispatcher` pair built in the spike.
The spike's
`scripts/spikes/durable-clock/src/{wakeup-store,durable-clock}.ts`
files are not the production artifacts but they are the structural
template for this dispatcher.

### The in-memory spike's lifecycle complexity disappears here

The Durable Clock spike documents a "snapshot before interrupt
fires" technique it had to use to make its restart test honest.
That is an artifact of the in-memory store, not a property the
production substrate inherits.

With Durable Streams as the source of truth for `clockWakeups`,
the durability boundary is the State Protocol append — outside
the dying process. Cancel-vs-dispatch becomes a normal State
Protocol concurrency case: both are appends keyed by `clockKey`,
and the per-key materialization rule plus offset ordering picks
the winner. The dispatcher does not need clever lifecycle handling
to defend against its own cleanup handlers, because the cleanup
handler can only run on graceful teardown (and even then, "append
a cancel" is just another State Protocol message that races
fairly with "append a dispatched"). A hard-killed process appends
nothing on its way out; the `pending` row stays `pending` until a
restarted dispatcher fires or cancels it.

The production restart test methodology is correspondingly
shorter:

```
1. Append a wake-up via the engine's scheduleClock against a real
   Durable Streams server.
2. Kill the dispatcher process (graceful or `kill -9`).
3. Start a fresh dispatcher pointed at the same stream URL.
4. Verify the new dispatcher observes the wake-up as pending and
   fires it when due.
```

No "snapshot inside scope" caveat. The Phase 1 validation spike's
restart proofs should use this shape, not the in-memory shape.

## How `DurableClock.sleep`'s threshold path interacts with this

`DurableClock.ts:81-99` routes sleeps ≤ 60s default through
`Activity.make({ execute: Effect.sleep(duration) })`. That
`Effect.sleep` honors whatever `Clock` is installed at the runtime
— including a Firegrid `Layer.setClock(durableClock)` install.

So the live-Clock substitution validated by the spike (5/5 tests
passing for `Effect.sleep` / `Effect.timeoutOption` /
`Schedule.exponential` / `Stream.fromSchedule`) is exactly the path
`@effect/workflow`'s `DurableClock.sleep` takes for short waits.

The > 60s path goes through `engine.scheduleClock(...)` and
`DurableDeferred.await(clock.deferred)` — both implemented by the
DS+SP-backed engine described above.

The two paths coexist. App code calls one API
(`DurableClock.sleep({ name, duration })`); the workflow runtime
picks the path based on duration and the installed engine.

## Activities, attempts, and the `Suspended` short-circuit

Two subtleties from `Activity.ts` and `WorkflowEngine.ts`:

1. **Attempt counter is owned by the typed retry wrapper, not the
   engine.** `Activity.retry` (`Activity.ts:152-169`) wraps an
   effect in a per-call `Effect.provideService(effect,
   CurrentAttempt, attempt++)`. The engine just receives `attempt:
   number` and uses it as part of the activityKey.
2. **Suspended activity rows are cleared on resume**, not deleted.
   `layerMemory.activityExecute` (`WorkflowEngine.ts:577-602`)
   sets `state.exit = undefined` if the persisted exit was a
   `Suspended` result, then re-runs. Firegrid's impl mirrors this:
   when reading an `activities` row whose `resultEncoded` decodes
   to a `Suspended` variant, treat it as absent and run the
   activity body again, then overwrite the row.

## Tokens

`DurableDeferred.Token` (`DurableDeferred.ts:264-303`) is
`base64url(JSON.stringify([workflowName, executionId,
deferredName]))`. Tokens are durable cross-process pointers to a
deferred slot. They unlock the "fire-and-forget then wake from
elsewhere" pattern: external code receives a `Token` from a
workflow, performs some work, and calls `DurableDeferred.done({
token, exit })` from a different process; the engine writes the
durable exit and `resume(executionId)` re-drives the workflow.

For Firegrid, this is a bigger surface than just durable sleep — it
covers webhook callbacks, external job results, human-in-the-loop
signals. Worth flagging as a property the integration unlocks.

## Trade-offs vs. designing in Firegrid

| Dimension | Adopt `@effect/workflow` | Design Firegrid-native primitives |
|---|---|---|
| Substrate work | One `WorkflowEngine.Encoded` impl over DS+SP. Estimated 300–500 LOC of integration. | Design a `RunStep` / `DurableProcessor` API, replay rules, suspend/resume protocol, activity boundaries, deferred semantics, durable race rules. Multiple lanes of work. |
| Vocabulary in app code | `Workflow.make` / `Activity.make` / `DurableDeferred` / `DurableClock.sleep`. App code learns workflow words. | Firegrid-native words. App code stays in a Firegrid vocabulary. |
| Debugged corner cases | Many — `SuspendOnFailure`, parent-child workflow linkage, activity interrupt-retry, suspended-activity replay, durable-deferred race semantics, schema encode/decode boundaries, token cross-process resolver. All handled upstream. | All to design and prove from scratch. |
| Failure modes | Tied to `@effect/workflow`'s API stability and bugfix cadence. The package is at v1.0 at this SHA. | Owned by Firegrid; no upstream coupling. |
| Cross-process resolver (Tokens) | Free. | Has to be designed. |
| Scope of "what Firegrid is" | Firegrid becomes an integration layer between DS+SP and `@effect/workflow`, plus a typed descriptor surface. Substrate code shrinks. | Firegrid keeps a substantial substrate codebase. |
| Deviation from current SDD | Forces SDD substrate rewrite (see below). | Compatible with current SDD direction modulo refining the primitives. |

## What this means for the SDD

If option 1 (adopt) is taken, the SDD's `Substrate Implication`
section can be reduced to one paragraph. The five proposed
primitives (`DurableStreamSource`, `DurableProcessor`,
`DurableProjection`, `DurableLifecycle`, `DurableAdapterCall`)
collapse into:

- `WorkflowEngine.Encoded` over Durable Streams + State Protocol —
  Firegrid's one substrate contribution.
- A typed descriptor surface mapping Firegrid app-graph vocabulary
  (operations, event streams, planes, queries) onto upstream
  `Workflow` definitions and `EventPlane`-backed projections.

The SDD's Durable Clock Boundary section keeps its production
wall-clock framing: `Layer.setClock` for in-process durable time
(spike-validated), `DurableClock.sleep` for cross-process durable
time (engine-validated, follow-on integration spike recommended).

The SDD's Effect Stream / Schedule / Clock section is already
aligned with this result.

## Recommendation

Take option 1 — adopt `@effect/workflow` — but gate the decision on
one follow-on validation spike before committing the SDD edits:

> Implement a minimal `WorkflowEngine.Encoded` against
> `@durable-streams/state` for the four collections above and a
> simple in-process clock dispatcher. Run `@effect/workflow`'s own
> reference test suite against it. Confirm:
> 1. `executions` survive process restart correctly,
> 2. `activities` short-circuit on replay,
> 3. `deferreds` first-write-wins works,
> 4. `clockWakeups` fire after restart.
>
> Estimated work: 1 day.

If that spike passes, the substrate decision is settled and the SDD
edits proceed. If it surfaces a structural mismatch between
`Encoded` and DS+SP, that's the signal to either (a) request a
small State Protocol enhancement, or (b) reconsider option 2.

This document does not commit to the recommendation; it surfaces
the choice with enough detail that the coordinator and SDD lane
can decide.

## Open questions

1. **Is the workflow `register` graph stable across process
   restart?** Handlers are not durable. App code must re-register
   every workflow before the resume sweep. Is this a startup
   ordering concern Firegrid needs to model explicitly, or can the
   resume sweep tolerate handlers arriving out of order?
2. **What is `@effect/workflow`'s release/stability posture?**
   Adopting it as load-bearing substrate has a coupling cost worth
   pricing.
3. **Do `WorkflowProxy` / `WorkflowProxyServer`
   (`packages/workflow/src/WorkflowProxy{,Server}.ts`) belong in
   Firegrid's surface?** They're how an external HTTP/RPC server
   exposes workflow execution; this overlaps with Firegrid's
   `client.send` / `client.observe` machinery and may merit a
   separate read.
4. **Where does `DurableQueue` and `DurableRateLimiter`
   (siblings in `packages/workflow/src/`) fit?** They're upstream
   primitives Firegrid would otherwise design.

These are out of scope for this document but flagged for the next
research pass.
