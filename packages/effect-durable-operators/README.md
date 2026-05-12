# effect-durable-operators

Generic, Effect-native durable operators composed over
`effect-durable-streams`, `@durable-streams/state`, and `@tanstack/db`.

```ts
import {
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  DurableConsumer,
  DurableProjection,
  DurableTable,
} from "effect-durable-operators"
```

## Mental model

- **`DurableTable`** — a queryable, last-write-wins table derived from a
  durable State-Protocol change-event stream. Scope-managed: materialize on
  acquire, close on scope release.
- **`DurableProjection`** — converts a durable *fact* stream into a durable
  *change-event* stream a `DurableTable` can materialize. Projection state
  is allocated inside Effect (`Ref` / `SynchronizedRef`), so replay over
  retained facts is deterministic.
- **`DurableConsumer`** — "process each logical item once per subscriber."
  Selects facts, keys them, and writes a durable claim/completion via the
  `ConsumerCheckpointStore` service. Delivery policy is explicit
  (`AtMostOnce`, `AtLeastOnce`, `AtLeastOnceWithClaim`).
- **Workflows and tools sit *above* these operators.** Workflow suspension,
  durable clocks, required actions, prompts, and tool contracts belong to
  `@effect/workflow` (or your own runtime). This package is the primitives
  layer; it does not implement them.

## First consumer

A complete program: a domain `Effect.Service`, a `DurableConsumer.define`,
a `run` call that composes the service through `process`, and a
`Layer.mergeAll` at the application edge. This exact shape is
dry-typechecked against the package — see
`test/__readme-first-consumer-typecheck.ts`.

```ts
import { FetchHttpClient } from "@effect/platform"
import {
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  DurableConsumer,
} from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import { Effect, Layer, Option, Schema } from "effect"

const Order = Schema.Struct({
  type: Schema.Literal("order.created", "order.cancelled"),
  orderId: Schema.String,
  customer: Schema.String,
})

// 1. Domain service. `process` will compose this through R.
class EmailService extends Effect.Service<EmailService>()(
  "example/EmailService",
  {
    succeed: {
      sendReceipt: (orderId: string) =>
        Effect.succeed({ delivered: true, orderId }),
    },
  },
) {}

// 2. The consumer is a plain value — define once, run anywhere.
const SendReceiptEmails = DurableConsumer.define({
  name: "send-receipt-emails",
  select: (fact: typeof Order.Type) =>
    fact.type === "order.created" ? Option.some(fact) : Option.none(),
  key: (order) => order.orderId,
})

const ordersStreamUrl = "https://durable-streams.example/orders"
const checkpointsStreamUrl = "https://durable-streams.example/orders-checkpoints"

// 3. The program: process composes EmailService through R; delivery
//    semantics are explicit; checkpoint state is owned by the service.
const program = DurableConsumer.run({
  source: DurableStream.define({
    endpoint: { url: ordersStreamUrl },
    schema: Order,
  }),
  checkpoint: { subscriberId: "email.receipt.v1" },
  definition: SendReceiptEmails,
  policy: ClaimPolicy.AtLeastOnce(),
  process: (order) =>
    Effect.flatMap(EmailService, (svc) => svc.sendReceipt(order.orderId)),
})

// 4. Wire infrastructure at the edge.
const Live = Layer.mergeAll(
  EmailService.Default,
  ConsumerCheckpointStoreLive({
    streamOptions: {
      endpoint: { url: checkpointsStreamUrl },
      producerId: "email-receipt-consumer",
    },
  }),
  FetchHttpClient.layer,
)

const application = program.pipe(Effect.provide(Live), Effect.scoped)
```

`application` is `Effect<{ readonly processed: number }, …, FetchHttpClient.Fetch>`.
The host wires `FetchHttpClient.Fetch` at the top of its program (Node's
global `fetch`, a test-server stub, etc.) and runs the resulting effect.

The `process` effect can require any services (`R`) and fail with any
errors (`E`); they flow through `DurableConsumer.run` into the resulting
Effect's signature without being bent into a fixed shape.

## Triggers are named consumers

A "trigger" in this package is a named `DurableConsumer` program. There
is no separate DSL. The predicate is `select`; the per-key idempotency is
`key`; the durable side effect is `process`. Below is a permission-flow
trigger that records a derived fact when the upstream `permission.granted`
fact arrives.

```ts
const PermissionGranted = Schema.Struct({
  type: Schema.Literal("permission.requested", "permission.granted", "permission.denied"),
  requestId: Schema.String,
  decision: Schema.optional(Schema.String),
})

class DerivedFactsService extends Effect.Service<DerivedFactsService>()(
  "example/DerivedFactsService",
  {
    succeed: {
      recordGranted: (requestId: string) =>
        Effect.succeed({ recorded: true, requestId }),
    },
  },
) {}

const PermissionGrantedTrigger = DurableConsumer.define({
  name: "permission-granted-trigger",
  select: (fact: typeof PermissionGranted.Type) =>
    fact.type === "permission.granted" ? Option.some(fact) : Option.none(),
  key: (fact) => fact.requestId,
})

const triggerProgram = DurableConsumer.run({
  source: DurableStream.define({
    endpoint: { url: permissionFactsUrl },
    schema: PermissionGranted,
  }),
  checkpoint: { subscriberId: "permission.granted.trigger.v1" },
  definition: PermissionGrantedTrigger,
  policy: ClaimPolicy.AtMostOnce(),
  process: (granted) =>
    Effect.flatMap(DerivedFactsService, (svc) =>
      svc.recordGranted(granted.requestId),
    ),
})
```

The trigger is a subscriber, not a workflow. If the side effect needs to
complete a workflow-owned coordination point, that's covered in the next
section.

## Higher-layer patterns (not exports of this package)

The following patterns are usage sketches for *runtime/workflow* code
that composes these operators with `@effect/workflow`. They are not
exports of `effect-durable-operators`.

### `wait_for(predicate, timeout?)` — `DurableTable` + workflow `DurableDeferred`

`effect-durable-operators` does not own workflow suspension. To "wait
until a condition holds," compose `DurableTable` (snapshot query for
current state) with `DurableTable.changes` (subscription for future
updates), and let `@effect/workflow` complete its own `DurableDeferred`
from the matched value.

```ts
// pseudocode — composes operators with @effect/workflow primitives
import { DurableDeferred } from "@effect/workflow"
import { Stream } from "effect"

const waitForPermit = (
  table: DurableTable.DurableTable<typeof permits.collections>,
  deferred: DurableDeferred.DurableDeferred<Permit>,
  requestId: string,
) =>
  Effect.gen(function* () {
    // 1. Snapshot path: maybe the permit is already there.
    const existing = yield* table.get("permits", requestId)
    if (Option.isSome(existing)) {
      yield* DurableDeferred.succeed(deferred, existing.value)
      return
    }
    // 2. Live path: subscribe; first matching change completes the
    //    workflow-owned Deferred. Workflow suspension is the workflow's
    //    job, not ours.
    const changes = table.changes<"permits", Permit>("permits", (coll, emit) => {
      const sub = coll.subscribeChanges(
        (chs) => {
          for (const c of chs) {
            if (c.value !== null && c.value !== undefined && c.value.requestId === requestId) {
              emit(c.value)
            }
          }
        },
        { includeInitialState: false },
      )
      return () => sub.unsubscribe()
    })
    yield* Stream.runForEach(changes, (permit) =>
      DurableDeferred.succeed(deferred, permit),
    )
  })
```

The package gives you the *primitives* (`get`, `changes`, last-write-wins
table). Suspension is `@effect/workflow`'s responsibility; the timeout is
a `Schedule` on a workflow durable clock.

### `schedule_me_if(when, condition, fact)` — workflow durable clock pattern

A workflow-side pattern, not a package API. The workflow uses
`@effect/workflow`'s durable clock to sleep, queries a `DurableTable` to
check the condition, and only then appends a session-input fact through
whatever ingress service the runtime exposes.

```ts
// pseudocode — actual scheduling lives in @effect/workflow
import { DurableClock } from "@effect/workflow"

const scheduleMeIf = (when: Date, condition: Effect.Effect<boolean>, fact: SessionInputFact) =>
  Effect.gen(function* () {
    yield* DurableClock.sleepUntil(when)
    const stillRelevant = yield* condition
    if (!stillRelevant) return
    yield* RuntimeIngress.appendInput(fact)
  })
```

The `condition` effect is typically a `DurableTable.get` or `query` —
`schedule_me_if` is just "wait → check → fact-append" wired through
workflow primitives.

### `spawn(child, fact)` / `spawn_all(tasks)` — projected child terminals

Each child writes terminal facts to a parent-known stream. A
`DurableProjection` rolls those facts into a `DurableTable` keyed by
child id, and the parent workflow polls or subscribes to determine
completion. The package gives you the table; "wait for all children" is
the parent workflow applying its own predicate.

```ts
// Children emit `child.terminal` facts; parent reads them as a table.
const childTerminals = DurableTable.collections({
  terminals: DurableTable.collection({
    type: "spawn.child.terminal",
    primaryKey: "childId",
    schema: Schema.Struct({
      childId: Schema.String,
      status: Schema.Literal("succeeded", "failed"),
    }),
  }),
})

const allDone = (
  table: DurableTable.DurableTable<typeof childTerminals.collections>,
  expected: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const rows = yield* table.query("terminals", (c) => c.toArray)
    const done = new Set(rows.map((r) => r.childId))
    return expected.every((id) => done.has(id))
  })
```

## Modules

| Module | Surface |
| --- | --- |
| `DurableTable` | `collection`, `collections`, `materialize`, `DurableTable<C>` with `get` / `query` / `changes` / `awaitTxId` |
| `DurableProjection` | `define`, `run` |
| `DurableConsumer` | `define`, `run`, `sink`, `stream`, `ClaimPolicy` |
| `ConsumerCheckpointStore` | service tag (`read`, `writeClaim`, `writeCompletion`) plus `ConsumerCheckpointStoreLive` |
| `Errors` | `DurableTableError`, `DurableProjectionError`, `DurableConsumerError`, `CheckpointError` (all `Schema.TaggedError`) |

## Not in v0

- Workflow suspension, durable clocks, required actions, prompts, tools.
- Append-only or pluggable checkpoint backends (one Live Layer, no
  alternates).
- Exactly-once external side effects.
- Windowing, `GlobalKTable` equivalents, SQL parsing.

## Implementation notes

### Checkpoint backend choice

The SDD and tracer text describe checkpoints as "State Protocol-backed."
The v0 `ConsumerCheckpointStoreLive` instead materializes checkpoint rows
directly from the underlying durable stream using
`effect-durable-streams.snapshotThenFollow`.

`State.make` runs its read-and-decode work in a forked fiber and does not
expose a deterministic "caught-up" signal. The State Protocol's
`SnapshotEnd` control event is not emitted on fresh streams by the test
server, so a SnapshotEnd-based preload would silently swallow the wait.
`snapshotThenFollow` returns `{ snapshot, live }` only after the catch-up
read has completed, which gives the Layer a precise sync barrier: the
first `read` after acquire is guaranteed to see all retained checkpoints,
so restart semantics for AtMostOnce/AtLeastOnce are deterministic.

The wire format remains State-Protocol-compatible; a future Layer could
swap to a `State`-backed implementation without changing the service
surface.

### Boundaries

- This package does **not** import Firegrid runtime, client, protocol,
  scenarios, apps, or `@firegrid/durable-streams`.
- It imports `@durable-streams/state` only (not other `@durable-streams/*`
  packages), enforced by `.dependency-cruiser.cjs` rules
  `durable-streams-imports-contained` and
  `effect-durable-operators-state-only`.

### Tracer 017 status

All tracer-017 ACIDs are satisfied by this package plus the Firegrid
runtime refactor in PR #N (this branch):

- `effect-durable-operators.PACKAGE.{1,2,3}` — generic package surface
- `effect-durable-operators.TABLE.{1,2,3,4,5}` — table operator
- `effect-durable-operators.PROJECTION.{1,2,3,4}` — projection operator
- `effect-durable-operators.CONSUMER.{1,2,3,4,5,6,7,8}` — consumer operator
- `effect-durable-operators.BOUNDARIES.{1,2,3,4,5}` — package boundaries
- `effect-durable-operators.FIREGRID_PROOF.{1,2,3}` — runtime input fold
  moved to `DurableConsumer`; the **generic** `ConsumerCheckpointStoreLive`
  owns delivery progress (no Firegrid-specific checkpoint Layer); no
  Firegrid symbols inside this package
- `effect-durable-operators.TRACER_017.{1,2,3,4,5}` — generic tests
  (`test/`) and scenario E2E (`scenarios/firegrid/src/tracer-017.test.ts`).

The transitional `firegrid.runtime_ingress.requested` row family remains
as the public input fact in this PR. Renaming to `firegrid.session.input`
is a separate decision; the operators package is agnostic to the row name.
