# tf-n3qc Fluent Firegrid Keystone Design

## Verdict

The keystone slice works: `@firegrid/fluent-firegrid` can expose a
Restate-shaped `service({ name, handlers })` builder plus a client invocation
helper, and a handler can call `ctx.run("step", fn)` where the successful step
result is journaled directly to an append-only Durable Stream.

On re-invocation with the same journal endpoint, `ctx.run` reads the journal and
returns the prior `StepSucceeded` result without re-running `fn`. The validation
test simulates restart by creating a second client against the same journal URL
and asserts the side-effect counter remains `1`.

This package deliberately does **not** import `@effect/workflow`,
`effect-durable-operators`, `@firegrid/runtime`, `@firegrid/protocol`, or
DurableTable. Runtime dependencies are only `effect` and
`effect-durable-streams`.

## Implemented Slice

Files:

- `packages/fluent-firegrid/src/index.ts`
- `packages/fluent-firegrid/test/durable-run.test.ts`
- `features/firegrid/fluent-firegrid-keystone.feature.yaml`

Public shape:

```ts
const greeter = service({
  name: "greeter",
  handlers: {
    greet: (ctx, name: string) =>
      Effect.gen(function* () {
        return yield* ctx.run("compose", () => `Hello, ${name}!`)
      }),
  },
})

const greeterClient = client(greeter, {
  journal: { endpoint: { url: "https://durable/v1/stream/invocation-id" } },
})

const result = yield* greeterClient.greet("Ada")
```

Journal event shape:

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

1. `execute` binds `JournalEventSchema` to that endpoint with
   `DurableStream.define`.
2. `execute` creates the stream idempotently and snapshots the journal with
   `collect`.
3. The handler receives a `HandlerContext` with a deterministic step counter.
4. `ctx.run(name, fn)` computes `stepKey = "<index>:<name>"`.
5. If the snapshot has a `StepSucceeded` event for `stepKey`, the recorded
   value is returned.
6. Otherwise `fn({ signal })` runs once.
7. The successful result is appended as `StepSucceeded`.
8. The result is returned to the handler.

This is direct event sourcing over the Durable Streams append/read protocol. No
table materialization is required for the keystone replay behavior.

## Restate API Mapping

| Restate shape | Fluent Firegrid keystone | Status |
|---|---|---|
| `service({ name, handlers })` | `service({ name, handlers })` stores a typed service definition | Implemented |
| Handler ctx | `HandlerContext` passed to each handler | Implemented |
| `ctx.run(name, fn)` / sdk-gen `run(fn, { name })` | `ctx.run(name, fn)` journals `StepSucceeded` to the invocation stream | Implemented for success replay |
| Re-invocation replay | `collect` + deterministic `stepKey` returns journaled value | Implemented and tested |
| Client invoke | `client(service, { journal }).handler(input)` calls `execute` | Implemented minimal client |
| `ctx.sleep` / sdk-gen `sleep` | Timer event plus wake stream append | Not implemented |
| `ctx.get` / `ctx.set` state | State log events folded by key; optional snapshots later | Not implemented |
| Awakeables / durable promises | Promise-created / promise-resolved events plus waiter keys | Not implemented |
| Virtual objects | Keyed journal namespace plus state fold | Not implemented |
| Workflows | Long-lived invocation journal plus external resume/wake policy | Not implemented |
| Typed service/object/workflow clients | Client descriptors over invocation journals and send rows | Not implemented |
| `all` / `race` / `select` | Waiter rows/events over Future ids; losers must continue | Not implemented |
| `spawn` | Routine journal plus routine result Future | Not implemented |
| Cancellation | Durable cancellation event plus AbortSignal and boundary throw | Not implemented |

## Next API Surface

1. **Journal read model.** Add a small fold over journal events so `ctx.run`,
   `ctx.get`, `ctx.set`, promise resolution, and waiter registration all use one
   in-memory replay snapshot.
2. **Step failure policy.** Decide whether `StepFailed` is replayed as terminal,
   retried by policy, or excluded until retry semantics are designed.
3. **State.** Add `ctx.get(key)` / `ctx.set(key, value)` as `StateSet` events
   folded by key. This does not require DurableTable for the first slice.
4. **Sleep.** Add `SleepScheduled` / `SleepFired` events and a tiny timer worker
   that appends a wake event. This is the direct-log equivalent of the #914
   timer-as-append proof.
5. **Awakeables / workflow promises.** Add promise ids, creation events, and
   resolver events. External resolver ingress is a separate API.
6. **Futures and combinators.** Introduce `Future<T>` handles backed by journal
   step ids and waiter events. Implement `all` first; then `race` and `select`
   with loser-continuation semantics.
7. **Routine-backed spawn.** Spawn should append routine-start events and settle
   a routine result future. Restart safety needs a worker claim/reclaim contract.
8. **Service/object/workflow clients.** Layer typed descriptors on top after the
   durable journal and future semantics are stable.

## Known Gaps

- The current client uses one caller-supplied journal endpoint. A product API
  needs an invocation id to stream URL mapping.
- Only successful `ctx.run` replay is implemented. Failure replay, retries, and
  TerminalError-style cancellation are intentionally deferred.
- The current replay snapshot is read at invocation start. Long-running
  handlers that park and resume will need a live follow/wake mechanism.
- `ctx.run` values are stored as `unknown`; typed result decoding should be
  added before this becomes a public package contract.
- The keystone does not yet implement Restate's free-standing generator
  `Operation<T>` / `Future<T>` API. It proves the lower durable step primitive
  that those combinators can use.

## Validation

Focused validation:

```text
pnpm --filter @firegrid/fluent-firegrid typecheck
pnpm --filter @firegrid/fluent-firegrid test
```

The keystone test:

- first invoke: `ctx.run("compose", fn)` executes `fn`, appends
  `StepSucceeded`, returns `Hello, Ada! run=1`;
- simulated restart: a new client invokes the same service against the same
  journal endpoint;
- replay: `ctx.run("compose", fn)` returns the journaled result and does not
  increment the side-effect counter.

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
