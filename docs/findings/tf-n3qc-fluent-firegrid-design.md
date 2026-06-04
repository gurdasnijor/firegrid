# tf-n3qc Fluent Firegrid Keystone Design

## Verdict

The corrected keystone slice now follows `@restatedev/restate-sdk-gen`'s
user-visible shape: `Operation<T>` is an iterable built with `gen`, `Future<T>`
is a yieldable operation returned by the free-standing `run`, and the handler
calls `execute(ctx, op)` to wire the scheduler.

The working slice:

```ts
const greeter = service({
  name: "greeter",
  handlers: {
    greet: (ctx, name: string) =>
      execute(
        ctx,
        gen(function* () {
          const greeting = yield* run(() => `Hello, ${name}!`, {
            name: "compose",
          })
          return greeting
        }),
      ),
  },
})
```

`run(action, { name })` returns a yieldable `Future<T>`. On first invocation,
the scheduler executes `action`, appends `StepSucceeded` to the Durable Stream
journal, and returns the value. On re-invocation with the same journal endpoint,
the scheduler replays the `StepSucceeded` event and does not execute `action`
again.

This package deliberately does **not** import `@effect/workflow`,
`effect-durable-operators`, `@firegrid/runtime`, `@firegrid/protocol`, or
DurableTable. Runtime dependencies are only `effect` and
`effect-durable-streams`.

## Implemented Slice

Files:

- `packages/fluent-firegrid/src/index.ts`
- `packages/fluent-firegrid/test/durable-run.test.ts`
- `features/firegrid/fluent-firegrid-keystone.feature.yaml`

Public surface in this slice:

- `service({ name, handlers })`
- `object({ name, handlers })`
- `workflow({ name, handlers })`
- `client(service, ctx)`
- `invoke(service, handlerName, input, ctx)`
- `gen(factory)`
- `execute(ctx, operation)`
- `run(action, options?)`
- `sleep(durationMs, name?)`
- `all(futures)`
- `race(futures)`
- `any(futures)`
- `allSettled(futures)`
- `select(branches)`
- `spawn(operation)`
- `Operation<T>`
- `Future<T>`

The service/client helpers are only a thin wrapper around the scheduler proof.
The important part is the sdk-gen-shaped Operation/Future path: `Operation<T>`
is any iterable, `Future<T>` yields an internal primitive leaf, and free
functions inside a generator read the active scheduler from a synchronous
current slot set while `execute` drives the generator. There is no `ops`
parameter and no AsyncLocalStorage.

## Journal Event Shape

```ts
type JournalEvent =
  | {
      readonly type: "StepSucceeded"
      readonly stepKey: string
      readonly name: string
      readonly value: unknown
    }
  | {
      readonly type: "StepFailed"
      readonly stepKey: string
      readonly name: string
      readonly message: string
      readonly cause?: unknown
    }
  | {
      readonly type: "SleepCompleted"
      readonly sleepKey: string
      readonly name: string
      readonly durationMs: number
    }
  | {
      readonly type: "RaceCompleted"
      readonly raceKey: string
      readonly name: string
      readonly winnerIndex: number
    }
```

The keystone writes `StepSucceeded`, `SleepCompleted`, and `RaceCompleted`.
`StepFailed` remains a read shape for a future retry/failure-policy slice.

## Raw Log Algorithm

Each handler invocation gets one durable journal endpoint.

1. `execute(ctx, op)` binds `JournalEventSchema` to `ctx.journal.endpoint` with
   `DurableStream.define`.
2. `execute` creates the stream idempotently and snapshots the journal with
   `collect`.
3. `execute` constructs a scheduler and drives a fresh iterator from
   `op[Symbol.iterator]()`.
4. The module-level current-scheduler slot is set only while advancing the
   generator.
5. Free-standing `run(action, { name })` reads that slot and returns a
   `Future<T>`.
6. `yield* future` yields a primitive leaf operation to the scheduler.
7. The scheduler computes `stepKey = "<index>:<name>"`.
8. If the snapshot has `StepSucceeded(stepKey)`, the recorded value resumes the
   generator.
9. Otherwise the scheduler runs `action({ signal })`, appends
   `StepSucceeded`, and resumes the generator with the result.

This is direct event sourcing over the Durable Streams append/read protocol. No
table materialization is required for the keystone replay behavior.

## Restate API Mapping

| Restate sdk-gen shape | Fluent Firegrid keystone | Status |
|---|---|---|
| `Operation<T>` | Iterable `Operation<T>` from `gen(factory)` | Implemented |
| `Future<T>` | Yieldable `Future<T>` backed by an internal primitive leaf | Implemented |
| `gen(function* () { ... })` | Fresh generator factory stored on `Operation<T>` | Implemented |
| `execute(ctx, op)` | Builds scheduler from `ctx.journal.endpoint` and drives the operation | Implemented |
| Free-standing `run(action, opts?)` | Reads current scheduler slot; returns journal-backed `Future<T>` | Implemented for success replay |
| `yield* future` | Future iterator yields marker and resumes with scheduler value | Implemented |
| `service({ name, handlers })` | Stores a typed service definition | Implemented minimal wrapper |
| Client invoke | `client(service, ctx).handler(input)` calls `invoke` | Implemented minimal wrapper |
| `sleep(duration)` | Effect timer then `SleepCompleted`; replay skips waiting | Implemented keystone timer |
| `awakeable<T>()` / `workflowPromise(name)` | Promise-created / promise-resolved events plus waiter keys | Not implemented |
| `state<T>()` / `sharedState<T>()` | State log events folded by key; optional snapshots later | Not implemented |
| `all` | Concurrent wait over Futures with ordered tuple results | Implemented |
| `race` | First-settled Future wins; `RaceCompleted` fixes replay winner; losers continue in daemon fibers | Implemented keystone combinator |
| `any` | First successful Future wins; all failures throw `AggregateError` through the generator boundary | Implemented keystone combinator |
| `allSettled` | Ordered settled results without rejecting | Implemented |
| `select` | Tagged first-settled branch plus winning Future; replay uses `RaceCompleted` | Implemented |
| `spawn(op)` | Routine-backed Future driven by the current scheduler | Implemented non-restart-safe routine |
| service/object/workflow clients | Typed descriptors over invocation journals and send rows | Not implemented |
| Cancellation | Durable cancellation event plus AbortSignal and boundary throw | Not implemented |

## Next API Surface

1. **Step failure policy.** Decide whether `StepFailed` is replayed as terminal,
   retried by policy, or excluded until retry semantics are designed.
2. **Future lifecycle.** Persist Future ids separately from step keys so
   combinators can wait on already-created handles.
3. **State.** Add `state<T>()` / `sharedState<T>()` as folded log events, not
   DurableTable rows.
4. **Durable timers.** Split the current in-process `sleep` into scheduled/fired
   rows plus wake delivery for long parks.
5. **Awakeables / workflow promises.** Add promise ids, creation events, and
   resolver events. External resolver ingress is a separate API.
6. **Routine-backed spawn durability.** The current spawn composes in-process;
   restart safety needs routine-start/result rows plus worker claim/reclaim.
7. **Service/object/workflow clients.** Layer typed descriptors on top after
   the durable journal and future semantics are stable.

## Known Gaps

- `spawn(op)` is routine-backed and composable, but not restart-safe yet.
- `sleep` is journaled for replay but still uses an in-process Effect timer for
  the first run; it is not a parked durable wake worker.
- The current client uses one caller-supplied journal endpoint. A product API
  needs an invocation id to stream URL mapping.
- `run` values are stored as `unknown`; typed result decoding should be added
  before this becomes a public package contract.
- The current replay snapshot is read at invocation start. Long-running
  handlers that park and resume will need a live follow/wake mechanism.

## E2E Plan From Vendored Restate

Source-checked upstream files:

- `repos/sdk-typescript/packages/libs/restate-sdk-gen/e2e/concurrency.e2e.test.ts`
- `repos/sdk-typescript/packages/libs/restate-sdk-gen/e2e/polling.e2e.test.ts`
- `repos/sdk-typescript/packages/libs/restate-sdk-gen/e2e/state.e2e.test.ts`
- `repos/sdk-typescript/packages/libs/restate-sdk-gen/e2e/terminal-errors.e2e.test.ts`

The nearest Firegrid e2e analog should start with a Durable Streams-backed
concurrency service and run each handler twice against the same invocation
journal, matching Restate's default/alwaysReplay split. The first suite should
cover `all`, `race`, `select`, `spawn`, and mixed journal/routine Futures. The
current unit test `test/combinators.test.ts` already covers the critical replay
property locally: `race` returns the original winner on replay and losing
branches continue far enough to journal.

Later e2e suites line up with missing primitives:

- polling requires durable channel or external wake delivery;
- state requires `state<T>()` / `sharedState<T>()` log folding;
- terminal/transient errors require the step failure/retry policy;
- signal sharing and cancellation require cancellation rows plus AbortSignal
  fanout.

## Validation

Focused validation:

```text
pnpm --filter @firegrid/fluent-firegrid typecheck
pnpm --filter @firegrid/fluent-firegrid test
pnpm --filter @firegrid/fluent-firegrid diagnostics
```

The keystone tests:

- first invoke: handler calls `execute(ctx, gen(...))`; inside the generator,
  `yield* run(action, { name: "compose" })` executes `action`, appends
  `StepSucceeded`, and returns `Hello, Ada! run=1`;
- simulated restart: a new client invokes the same service against the same
  journal endpoint;
- replay: free-standing `run` returns a `Future` whose scheduler result comes
  from the journal and does not increment the side-effect counter;
- combinators: `race`, `any`, `allSettled`, `select`, and `spawn` match the
  Restate-shaped local semantics covered by the vendored unit/e2e examples.

## Source References

- Restate sdk-gen README / API shape:
  https://github.com/restatedev/sdk-typescript/tree/main/packages/libs/restate-sdk-gen
- Restate sdk-gen design:
  https://github.com/restatedev/sdk-typescript/blob/main/packages/libs/restate-sdk-gen/DESIGN.md
- Restate sdk-gen guide:
  https://github.com/restatedev/sdk-typescript/blob/main/packages/libs/restate-sdk-gen/guide.md
- Local substrate used:
  `packages/effect-durable-streams/src/Writer.ts`,
  `packages/effect-durable-streams/src/Reader.ts`,
  `packages/effect-durable-streams/src/DurableStream.ts`
