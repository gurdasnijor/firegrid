# `@effect/workflow`: clocks, races, and deferred done

Three non-obvious behaviors of `@effect/workflow` that cost real time on
first encounter. Distilled from the `durable-tools/wait_for` implementation
(`packages/runtime/src/durable-tools/internal/wait-for.ts`,
`packages/runtime/src/workflow-engine/internal/`).

> Canonical source for everything below:
> `repos/effect/packages/workflow/src/DurableClock.ts`,
> `repos/effect/packages/workflow/src/DurableDeferred.ts`,
> `repos/effect/packages/workflow/src/WorkflowEngine.ts`.

---

## 1. `DurableClock.sleep` runs in-memory below a threshold (default 60s)

`DurableClock.sleep({ name, duration })` decides between two paths:

- **Below `inMemoryThreshold`** (default `Duration.seconds(60)`): the sleep
  runs as an Activity that calls plain `Effect.sleep(duration)`. The
  workflow fiber blocks for that duration.
- **At or above the threshold**: the sleep persists a clock wakeup row, calls
  `DurableDeferred.await` on a `DurableClock/<name>` deferred, and the
  workflow fiber **suspends durably**. Some external driver (Firegrid's
  `fireDueWorkflowClocks`, or your runtime host's equivalent) must observe
  the due wakeup and call `engine.deferredDone`.

### Why this matters when racing against a deferred

If you race `DurableDeferred.await(someDeferred)` against a 10-second
`DurableClock.sleep` with the default threshold, the workflow body runs
`Effect.sleep(10s)` synchronously inside the workflow fiber. The
`engine.deferredDone(someDeferred)` call from another fiber **cannot resume
the workflow** until the 10s sleep completes, because the engine's
`resume()` no-ops when the workflow fiber is already running. Net effect:
your "deferred wins, timeout loses" race always looks like the timeout won.

### Fix

Pass `inMemoryThreshold: Duration.zero` to force the durable suspend path:

```ts
import { DurableClock } from "@effect/workflow"
import { Duration } from "effect"

DurableClock.sleep({
  name: "wait-for/foo/clock",
  duration: Duration.millis(timeoutMs),
  inMemoryThreshold: Duration.zero,
})
```

This is what `wait_for`'s timeout path does. Reference:
`packages/runtime/src/durable-tools/internal/wait-for.ts`.

If you don't have an external clock driver in your runtime host yet, **you
need one** before you can use the durable suspend path. Firegrid tests fork
a small loop that calls `fireDueWorkflowClocks(Date.now())` every ~25–100ms;
production wiring is the runtime host's responsibility.

---

## 2. `DurableDeferred.raceAll` infers `any` in its requirements channel

`DurableDeferred.raceAll` (vendored at
`repos/effect/packages/workflow/src/DurableDeferred.ts`) has a generic
tuple-parameter signature that infers `any` into the `R` (requirements)
channel of the result `Effect`. The runtime contract is fine — the actual
required services come from the racer effects — but TypeScript can't
recover the precise `R` type.

### Symptom

ESLint's `@typescript-eslint/no-unsafe-return` flags any function that
returns the result of an `Effect.gen` body using `raceAll`, because the
gen body's inferred return type carries an `any` in `R`.

### Fix

Declare a precise return type on the outer function and add a narrow
`eslint-disable` for the gen body. **Do not** add an
`as Effect.Effect<...>` cast — the repo's spec gates prohibit such casts
(`firegrid-durable-tools.BOUNDARIES.4`, also enforced by the Effect-quality
metric `anyNoContextCastCount`).

```ts
type MatchImplResult<A> = Effect.Effect<
  WaitForOutcome<A>,
  WaitForError | ParseResult.ParseError | DurableTableError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableToolsTable
  | Scope.Scope
>

const matchImpl = <A>(options: WaitForOptions<A>): MatchImplResult<A> =>
  // `DurableDeferred.raceAll` surfaces `any` in its requirements channel via
  // a generic-inference quirk on its array-tuple parameter; the gen body
  // requires only the services declared on MatchImplResult<A>.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() { /* ... use raceAll ... */ })
```

Reference: `packages/runtime/src/durable-tools/internal/wait-for.ts`.

### When the fix is fix-the-upstream

If `raceAll`'s typing improves in a future `@effect/workflow` release, both
the precise return-type annotation and the `eslint-disable` should be
removed. Track this when bumping `@effect/workflow`.

---

## 3. `engine.deferredDone` is idempotent per `(executionId, deferredName)`

The Firegrid Durable Streams workflow engine
(`packages/runtime/src/workflow-engine/internal/engine-runtime.ts`)
implements `deferredDone` as:

```ts
deferredDone: options =>
  Effect.gen(function* () {
    const key = `${options.executionId}/${options.deferredName}`
    const existingDeferred = yield* orDieTable(table.deferreds.get(key))
    if (Option.isNone(existingDeferred)) {
      yield* orDieTable(table.deferreds.upsert({ /* ... */ }))
    }
    yield* resume(options.executionId)
  })
```

Key behavior:

- **The first call wins.** If a deferred row already exists for
  `(executionId, deferredName)`, the second `deferredDone` is a no-op — the
  row is not overwritten, and the value passed by the second caller is
  discarded.
- **`resume()` is always called.** Even on the no-op path, the workflow is
  re-driven. This is what makes recovery loops safe: re-issuing
  `deferredDone` after a crash advances the workflow to the next durable
  point without changing the resolution value.

### Why this matters

This is the **single primitive** that makes the following correct:

- **Crash recovery** — a reconciler can replay a "completion row authoritative"
  decision by re-calling `deferredDone` after a crash, knowing the second
  call cannot accidentally overwrite a different exit value if the first
  call had succeeded. See
  `packages/runtime/src/durable-tools/internal/reconcile.ts`.
- **Match-vs-timeout race resolution** — `wait_for`'s match and timeout
  paths both end with `deferredDone`. The workflow's actual outcome is
  determined by whichever `deferredDone` call lands first. Completion-row
  divergence in the narrow race window is irrelevant to the workflow
  resolution; the engine guarantees exactly one outcome.

### What it does *not* give you

- `deferredDone` is **not** transactional with completion-row writes. If
  you write a completion row and then call `deferredDone`, a crash between
  those steps leaves an authoritative completion row plus an in-flight
  workflow. Bridging that gap is the consumer's responsibility (see the
  Firegrid reconciler pattern).
- `deferredDone` is **not** an external API for cancelling a workflow. It
  resolves a specific `DurableDeferred` the workflow is awaiting. To
  cancel, use the engine's `interrupt(workflow, executionId)`.

---

## Pattern summary

For any "wait for X with optional timeout" pattern on `@effect/workflow`:

1. **One workflow body**, one `DurableDeferred.raceAll` over a match deferred
   and a `DurableClock.sleep`-driven timeout.
2. **`inMemoryThreshold: Duration.zero` on the clock** so the workflow
   suspends durably.
3. **Match-path resolver calls `engine.deferredDone(matchDeferred, ...)`**
   from a separate fiber (Firegrid's subscription router does this).
4. **Crash recovery** replays the resolver via a reconciler that re-issues
   `deferredDone` from authoritative durable state. Idempotency makes this
   safe.
5. **Drive `fireDueWorkflowClocks`** somewhere in your runtime host so
   persisted clock wakeups actually fire.

The Firegrid `wait_for` implementation
(`packages/runtime/src/durable-tools/`) is the reference. Cross-reference
its router (`subscription-router.ts`), reconciler (`reconcile.ts`), and the
race wiring in `wait-for.ts`.
