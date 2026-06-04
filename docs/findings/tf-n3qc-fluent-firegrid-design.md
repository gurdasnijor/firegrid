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
- `client(service, ctx)`
- `invoke(service, handlerName, input, ctx)`
- `gen(factory)`
- `execute(ctx, operation)`
- `run(action, options?)`
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
```

The keystone currently writes only `StepSucceeded`. The `StepFailed` read shape
is present so a future slice can choose whether failures are replayed, retried,
or policy-gated.

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
| `sleep(duration)` | Timer event plus wake stream append | Not implemented |
| `awakeable<T>()` / `workflowPromise(name)` | Promise-created / promise-resolved events plus waiter keys | Not implemented |
| `state<T>()` / `sharedState<T>()` | State log events folded by key; optional snapshots later | Not implemented |
| `all` / `race` / `select` | Waiter events over Future ids; losers must continue | Not implemented |
| `spawn(op)` | Routine journal plus routine result Future | Not implemented |
| service/object/workflow clients | Typed descriptors over invocation journals and send rows | Not implemented |
| Cancellation | Durable cancellation event plus AbortSignal and boundary throw | Not implemented |

## Next API Surface

1. **Journal read model.** Add a fold over journal events so future steps,
   state, promises, waiter registration, and cancellation all use one replay
   snapshot.
2. **Step failure policy.** Decide whether `StepFailed` is replayed as terminal,
   retried by policy, or excluded until retry semantics are designed.
3. **Future lifecycle.** Persist Future ids separately from step keys so
   combinators can wait on already-created handles.
4. **`all`.** Implement the first combinator over journal-backed futures.
5. **`race` / `select`.** Add waiter events with loser-continuation semantics;
   this is the main Restate semantic constraint from the #914 spike.
6. **State.** Add `state<T>()` / `sharedState<T>()` as folded log events, not
   DurableTable rows.
7. **Sleep.** Add `SleepScheduled` / `SleepFired` events and a tiny timer worker
   that appends a wake event. This is the direct-log equivalent of the #914
   timer-as-append proof.
8. **Awakeables / workflow promises.** Add promise ids, creation events, and
   resolver events. External resolver ingress is a separate API.
9. **Routine-backed spawn.** Append routine-start events and settle a routine
   result future. Restart safety needs a worker claim/reclaim contract.
10. **Service/object/workflow clients.** Layer typed descriptors on top after
   the durable journal and future semantics are stable.

## Known Gaps

- `Future<T>` is yieldable and replay-backed, but not yet eager/backgrounded for
  parallel construction before `yield* all(...)`.
- Failure delivery into `generator.throw(...)` is not implemented yet, so
  user-level `try/catch` around `yield* run(...)` is future work.
- The current client uses one caller-supplied journal endpoint. A product API
  needs an invocation id to stream URL mapping.
- `run` values are stored as `unknown`; typed result decoding should be added
  before this becomes a public package contract.
- The current replay snapshot is read at invocation start. Long-running
  handlers that park and resume will need a live follow/wake mechanism.

## Validation

Focused validation:

```text
pnpm --filter @firegrid/fluent-firegrid typecheck
pnpm --filter @firegrid/fluent-firegrid test
```

The keystone test:

- first invoke: handler calls `execute(ctx, gen(...))`; inside the generator,
  `yield* run(action, { name: "compose" })` executes `action`, appends
  `StepSucceeded`, and returns `Hello, Ada! run=1`;
- simulated restart: a new client invokes the same service against the same
  journal endpoint;
- replay: free-standing `run` returns a `Future` whose scheduler result comes
  from the journal and does not increment the side-effect counter.

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
