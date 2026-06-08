# Fluent Firegrid

Fluent Firegrid is the application authoring layer for Effect-native durable
work over Durable Streams. The current design goal is intentionally narrow:
settle the `packages/fluent-firegrid` API from application needs first, then
push every generic durable mechanism that can be pushed down into
`packages/durable-streams`.

The key inversion is:

- **Durable Streams** owns state and the durable half of coordination.
- **Effect** owns computation and local structured concurrency.
- **`packages/fluent-firegrid`** defines the application authoring surface over
  typed handlers, Effect bodies, named durable steps, and durable wait/timer
  vocabulary.

The architecture is not "a second runtime" beside Durable Streams. The desired
shape is a thin authoring API over Durable Streams substrate capabilities:
append, read, close, fork, producer fencing, named consumers, pull-wake, webhook
wake, lease, ack, retry, TTL, and any generic scheduled-wake or predicate
subscription machinery the Durable Streams fork exposes.

## Design Order

Fluent design starts at the application layer, not at a deployment package. The
acceptance order is:

1. Define the `fluent-firegrid` authoring contract: typed definitions, handler
   descriptors, `run`, replay schemas, deterministic journal keys, durable
   wait/timer vocabulary, and local Effect composition.
2. For each durable behavior, decide whether it can be described without
   Firegrid product nouns.
3. Push every generic behavior into `packages/durable-streams` or consume an
   existing Durable Streams fork primitive.
4. Leave ingress, harness, and deployment shape out of scope until the authoring
   API and substrate contracts are settled.

This order is a guardrail against the previous drift: a missing Durable Streams
capability must not be rebuilt inside `fluent-firegrid` or hidden behind a
"runtime" name. If a behavior can be described without Firegrid nouns, it is a
Durable Streams substrate candidate. If it requires Firegrid nouns, it is not
part of the `fluent-firegrid` authoring API.

## Current Scope

This document intentionally does not define a deployment shape. It defines only
the authoring package and the substrate pushdown target.

| Surface | In scope now | Out of scope for now |
|---|---|---|
| `fluent-firegrid` | typed definitions, handlers, `run`, schemas, local Effect composition, durable wait/timer authoring vocabulary | HTTP/MCP/ACP servers, harness lifecycle, product ingress, stream URL topology |
| `packages/durable-streams` fork | stream log, producers, fork/close/TTL, named consumers, wake/claim/ack/lease/retry, generic schedule/wait primitives where available | Firegrid product semantics or harness protocol fidelity |
| Effect | computation, local concurrency, interruption, finalizers, dependency services | durable storage or wake ownership |

Managed sessions, harness reconstruction, ACP/native adapters, product APIs,
and entity operations such as send, fork, tag, schedule, read, head, and delete
are real Firegrid concerns, but they are downstream of this decision and should
not shape the `fluent-firegrid` API yet.

See [`fluent-firegrid-design.md`](fluent-firegrid-design.md) for the
application-layer authoring contract that must be settled before expanding
deployment or adapter work.

## Providers And Pushdown Boundary

The settled architecture has two providers and one thin authoring package.

```text
APPLICATION AUTHORING                         DURABLE SUBSTRATE

┌──────────────────────────────────────┐       ┌──────────────────────────────┐
│ packages/fluent-firegrid             │       │ packages/durable-streams fork │
│ - typed definitions                  │       │ - append/read/tail/head       │
│ - handler descriptors                │       │ - close/fork/TTL              │
│ - run(name, effect, schemas)         │       │ - producer fencing/dedupe     │
│ - wait/sleep/invoke vocabulary       │       │ - named consumers             │
│ - local Effect composition           │       │ - wake/claim/ack/lease/retry  │
│                                      │       │ - scheduled wake if exposed   │
│ no DS clients, workers, endpoints,   │       │ - generic predicate/subs if   │
│ routes, ACP/MCP, timer wheels,       │       │   exposed                     │
│ predicate scanners, or leases        │       │                              │
└───────────────────┬──────────────────┘       └───────────────┬──────────────┘
                    │ abstract durable capabilities             │ HTTP/client APIs
                    │ StepJournal / WaitJournal / TimerJournal  │
                    └───────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ Effect                                                                       │
│ fibers, scopes, all/race/fork, interruption/finalizers, Schema, Clock/Random │
└──────────────────────────────────────────────────────────────────────────────┘
```

The package split follows the role split:

| Layer | Owns | Must not own |
|---|---|---|
| `fluent-firegrid` | Application authoring surface, typed definitions, handler descriptors, `run`, replay schemas, durable primitive vocabulary, local Effect composition | Durable Streams clients, leases, worker pools, HTTP/MCP/ACP servers, product ingress, timer wheels, predicate scanners |
| Durable Streams fork | Storage, offsets, closure, fork, TTL, producer fencing, consumer cursor, claim/ack/release, retry, subscription-webhook wake/signing, scheduled wake if exposed, generic predicate/subscription matching if exposed | Firegrid product semantics, harness protocol fidelity |
| Effect | Local computation and structured concurrency | Durable storage, claims, wakes, or replay persistence |

The pushdown rule is intentionally aggressive:

- **Named step replay:** if this is generic enough for any Effect body, Durable
  Streams can own the storage and producer semantics; `fluent-firegrid` only
  names and decodes steps.
- **Durable sleep:** if Durable Streams exposes scheduled wake, use it. If it
  does not, specify it in Durable Streams before adding a Firegrid scheduler.
- **Durable wait:** if matching is "predicate over stream/state facts after a
  cursor," specify or consume it as Durable Streams substrate. `fluent-firegrid`
  only records wait intent and replays recorded resolution.
- **Fork/tag/read/head/delete:** these are substrate/read-model operations, not
  authoring-package APIs.

## State, Coordination, Computation

Durable Streams is more than a log in this design. It supplies the substrate
properties that make the Fluent API small:

- catch-up reads from any offset;
- live tailing over SSE or long-poll;
- stream closure as durable EOF;
- copy-free fork from a prefix;
- producer id / epoch / seq fencing;
- named consumers, wake delivery, claim, ack, release, leases, retry;
- subscription-webhook signing and delivery;
- stream TTL and expiry.

Effect supplies the computation model that Restate-shaped generator schedulers
normally have to rebuild:

- lazy `Effect` values instead of bespoke `Operation`;
- eager `Fiber` handles instead of bespoke `Future`;
- `Effect.all`, `race`, `fork`, `forkScoped`, and scopes;
- interruption with finalizers instead of manual cancellation fan-out;
- `Layer`/`Context` for durable capability services;
- `Schema`, `Clock`, and `Random` as controlled boundary services.

Fluent's job is to expose a small authoring API without weakening either
provider. It should not become the place where missing Durable Streams features
are rebuilt.

## Deployment Topology Deferred

Deployment topology is deliberately deferred. A deployment binding may later
connect `fluent-firegrid` definitions to product ingress and Durable Streams
endpoints, but that shape is not settled here.

The only topology contract this document asserts is negative:

- application-authored code imports `fluent-firegrid`, not Durable Streams
  clients;
- `fluent-firegrid` does not expose listeners, workers, stream URLs, claims,
  acks, leases, or endpoint topology;
- generic durable mechanics go into `packages/durable-streams`, not into a
  deployment binding under a runtime-shaped name.

`@durable-streams/proxy` is a separate transport edge for resumable upstream
HTTP streams, such as AI token streams or SSE feeds. Fluent may use it inside a
LanguageModel, native, or cloud adapter, but it does not own waits, timers,
children, replay, redrive, tool results, or session authority.

See [`architecture.md`](architecture.md) for the current package-boundary
contract. It supersedes older host-fronted diagrams that described a concrete
`fluent-runtime EventIngress` path.

## Concepts Mapped To The Substrate

| Concept | Fluent spelling | Durable Streams / Effect mechanism |
|---|---|---|
| Durable step | `run(name, effect, { value, error })` | append schema-encoded `StepSucceeded` / `StepFailed` |
| Replay | keyed lookup by `stepKey` | catch-up `GET ?offset=-1`, decode from schema |
| Parallel work | `Effect.all`, `Effect.fork` | local Effect fibers; no journal I/O except leaf `run`s |
| Race | `Effect.race` plus explicit winner policy when durable | Effect interruption locally; journal winner where replay must be stable |
| Time and randomness | journaled `Clock` / `Random` layers | recorded readings in the journal |
| Durable sleep | `sleep` / `sleepUntil` | timer intent + Durable Streams scheduled wake or equivalent substrate primitive + recorded resolution |
| Durable wait | `awaitEvent` / `wait_for` | wait intent + Durable Streams subscription/predicate primitive when generic + recorded resolution |
| Child invocation/session | `invoke` or `spawn` at the coordination layer | child stream/session + terminal append-and-close + parent subscription |
| Completion / attach | live read or head of the journal/session stream | `GET ?live=sse`, `HEAD`, `Stream-Closed` |
| Branching | `fork` / tag from offset | Durable Streams fork from prefix; producer state resets |
| Idempotency | stream id, step key, producer id | idempotent `PUT`, keyed replay, producer fencing |
| GC | stream TTL / expiry | sliding `Stream-TTL`, `Stream-Expires-At` |

The exact wire sequences are in [`substrate-protocol.md`](substrate-protocol.md).

In this document, "journal" means the minimal durable execution record an
authored Effect body needs. It is not a session authority, a deployment API, or
a deployment topology.

## Fluent-Firegrid API Scope

`fluent-firegrid` is process-free. It is the authoring package and should be
usable anywhere an Effect program can be built. Its durable concern is a small
set of abstract durable capabilities, not a deployment process.

The core primitive is `run`: record a named Effect outcome, then replay that
outcome by key.

```ts
const publish = (draftId: string) =>
  Effect.gen(function* () {
    const review = yield* run("submit", submitForReview(draftId), {
      value: ReviewSubmitted,
      error: SubmitError,
    })
    return yield* run("notify", notifyReviewer(review.reviewerId), {
      value: NotificationSent,
    })
  })
```

Authoring invariants:

1. **Replay is keyed, not positional.** Effect concurrency makes positional
   replay unsound. Step keys are part of correctness.
2. **Duplicate step keys fail loudly.** Reusing a key must not silently replay
   another step's outcome.
3. **Schema is the journal boundary.** Values and typed errors are encoded before
   append and decoded on replay. Unknown payload plus `as A` is not acceptable.
4. **Retry belongs inside `run`.** Retrying around `run` replays the journaled
   failure; retrying the wrapped Effect journals only the terminal outcome.
5. **Compensation is ordinary Effect.** Use `onError`, `ensuring`, or
   `acquireRelease`, with compensating side effects wrapped in their own `run`.
6. **Local concurrency is Effect's.** `Effect.all`, `race`, `fork`, scopes, and
   interruption are not reimplemented by fluent.
7. **Durable child/session work is not local `fork`.** A local fiber is an
   in-process computation. A durable child is a substrate-level relationship
   over durable streams, not an authoring scheduler feature.

The root package may expose service/object/workflow metadata and typed
definition helpers. It must not expose listeners, endpoint configuration,
Durable Streams clients, worker pools, claim/ack APIs, timer wheels, predicate
matching engines, or external control operations.

## Durable Capability Contracts

`fluent-firegrid` may depend on abstract capabilities that are implemented
elsewhere. Keep them minimal and named by authoring need:

| Capability | Authoring need | Pushdown target |
|---|---|---|
| `StepJournal` | `run` can read or commit a named terminal step outcome | Durable Streams stream append/read plus producer fencing |
| `TimerJournal` | `sleep` can record intent and replay a recorded timer resolution | Durable Streams scheduled wake or equivalent substrate primitive |
| `WaitJournal` | `waitFor` can record intent and replay a recorded event resolution | Durable Streams subscription plus generic predicate/state matching when generic |
| `ChildJournal` | `invoke` can record child intent and replay child terminal resolution | Durable Streams child stream/fork/close/subscription primitives |

These are contracts, not implementation packages. If a capability needs generic
scheduling, generic predicate scanning, cursor movement, wake delivery, or
claim ownership, that mechanism belongs in `packages/durable-streams`.

## Safety Rules

This README carries only the authoring/substrate safety rules:

- `fluent-firegrid` does not import Durable Streams clients.
- Durable step keys are explicit and stable.
- Replay decodes through declared schemas.
- Local concurrency is Effect concurrency.
- Durable wait and sleep are not process-local sleeps, promises, queues, or
  predicate scanners in `fluent-firegrid`.
- Claim, ack, lease, retry, cursor, fork, close, TTL, producer fencing, and
  generic wake mechanics are Durable Streams concerns.
- Ingress, harness, projection, and entity-operation design is deferred.

## Current Build Priorities

1. Finalize the thin `fluent-firegrid` API contract from application examples.
2. Inventory each desired durable primitive and classify it as authoring
   vocabulary, Durable Streams substrate, or deferred product behavior.
3. Push generic step journal, scheduled wake, wait matching, child stream, fork,
   and subscription mechanics into `packages/durable-streams` where they are not
   already present.
4. Keep `fluent-firegrid` substrate-free with import guards.
5. Defer deployment, harness, ingress, and managed-session design until the
   authoring/substrate split is accepted.

## Read Next

- [`architecture.md`](architecture.md): current package-boundary contract and
  `fluent-runtime` status.
- [`execution-models.md`](execution-models.md): replay vs reconstruction over
  the shared Durable Streams coordination core.
- [`substrate-protocol.md`](substrate-protocol.md): concrete Durable Streams
  operation sequences for suspend/resume, wait, timer, child, attach, fork, and
  TTL.
- [`harness-io.md`](harness-io.md): ACP client/conductor, native/cloud, and
  LanguageModel I/O boundaries.
- [`../../../sdds/fluent-firegrid-sdd.md`](../../../sdds/fluent-firegrid-sdd.md):
  execution-focused design details and acceptance context.
