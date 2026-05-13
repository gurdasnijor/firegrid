# SDD: Firegrid Runtime Host Dispatcher and Durable Claims

Date: 2026-05-13

Status: Proposal, docs-only

Scope: A product-neutral runtime host dispatcher for `@firegrid/runtime` that
materializes runtime context work, publishes host liveness, claims eligible
contexts before live side effects, and starts local-process runtime attempts
through the existing runtime host primitives.

Non-scope: Product session semantics, provider registries, private host mesh
transport, leader election as a public API, exactly-once external side effects,
or moving `NodeRuntime.runMain` into `@firegrid/runtime`.

## Context

The Flamecast toy surfaced a real architectural gap. The app currently owns a
small host plane in `apps/flamecast/src/runtime/host.ts`: it creates a Firegrid
client, watches contexts filtered by `createdBy`, checks snapshots, then calls
`startRuntime`. That shape was useful for a smoke test, but it is not the
runtime architecture we want.

The problems are concrete:

- Every host pointed at the same namespace can observe every
  `RuntimeControlPlaneTable.contexts` row. A local in-process `running` set only
  prevents duplicate execution inside one process.
- The `createdBy === "flamecast-toy"` predicate is a product tag filter, not an
  ownership model. It avoids unrelated contexts in a toy namespace, but it does
  not decide which compatible host owns a context.
- The Flamecast host uses one materialized Firegrid client to observe context
  rows and a separately materialized runtime host table to read and execute the
  context. On Electric Cloud those table instances can be at different replay
  points, so a watch event can arrive before a point lookup in another client
  sees the same row.
- The current app watcher has no explicit replay/live boundary. Initial retained
  rows and new live rows flow through the same side-effect path, so a restarted
  host can attempt side effects before it has materialized all relevant context,
  run, and ownership evidence.
- There is no durable host identity, heartbeat, claim, release, or stale-owner
  record in the runtime launch lane. A new host cannot distinguish "unclaimed",
  "owned by a live host", "owned by a stale host", and "already terminal" using
  durable facts.
- `startRuntime` currently assumes a single writer per context and allocates
  attempt numbers by reading existing run rows. That is acceptable for v0, but a
  multi-host dispatcher needs durable fencing before live process side effects.

The desired correction is not to patch around eventual consistency with local
retries. The runtime host should have a durable dispatcher model: replay all
retained facts, materialize the current work and ownership view, append a claim
for eligible work, observe the authoritative claim winner, and only then start
live side effects.

## Fireline Prior Art

Fireline has a similar pattern in:

- `/Users/gnijor/gurdasnijor/fireline/crates/fireline-runtime/src/launch/dispatcher.rs`
- `/Users/gnijor/gurdasnijor/fireline/crates/fireline-substrate/src/active_claim/decision.rs`
- `/Users/gnijor/gurdasnijor/fireline/crates/fireline-substrate/src/active_claim/processor.rs`
- `/Users/gnijor/gurdasnijor/fireline/crates/fireline-runtime/src/sandbox/deployment.rs`
- `/Users/gnijor/gurdasnijor/fireline/crates/fireline-substrate/src/session/host_identity.rs`

Useful ideas to carry forward:

- The dispatcher reads the durable state stream from the beginning and tracks
  `WorkPhase::Replay` until the stream reports `up_to_date`. Replay updates
  materialized state but does not start live execution.
- Work requests and claim rows are separate durable facts. A request does not
  itself grant authority to execute.
- Multiple hosts may append claims, but the first claim observed for a work key
  is the authoritative winner in the materialized view.
- A process executes only when the winning claim is authored by that process.
  Non-local winners are observed and skipped.
- In-process duplicate scheduling guards are still useful, but only after the
  durable claim winner says this process owns the work.
- Host liveness is modeled separately from work claims. Fireline's deployment
  index folds registration, heartbeat, deregistration, provisioned, and stopped
  events into a queryable freshness view.

Fireline also exposes a useful boundary: claim mechanics do not know product
execution semantics. Domain code owns eligibility, terminal rows, execution,
and dead-owner policy. The shared claim code only decides whether to append a
claim, evaluate a claim, execute an owned claim, skip another live owner, or
invoke dead-owner policy.

## Design Principle

Runtime context rows are intent. Runtime host claim rows are execution
authority. Runtime output and run rows are durable evidence.

```txt
client appends RuntimeContext
runtime host materializes replay state
runtime host appends RuntimeContextClaim if eligible
dispatcher materializes authoritative claim winner
winning host starts process side effects
host writes run and output rows
```

No product app should need to recreate that loop. Product apps can launch
contexts and observe tables; `@firegrid/runtime` owns the host dispatcher.

## Claim Modeling: Durable Concurrency Primitives

The dispatcher's "one host per contextId" invariant is a special case of
a small family of recurring durable-concurrency patterns. Rather than the
dispatcher inventing its own claim/release/expired/transferred row
schemas, **claim mechanics are a substrate concern** — owned by typed
durable concurrency primitives that the dispatcher consumes.

See `PROPOSAL_DURABLE_CLAIM_PRIMITIVE_2026-05-13.md` for the primitive
definitions and the broader cross-codebase migration. Summary of how the
primitives map to this SDD:

| Concern | Primitive | Notes |
|---|---|---|
| Cross-host mutual exclusion: "one host runs each contextId" | `DurableKeyedMutex<contextId>` | The load-bearing dispatcher fence. Mutex-shaped (no capacity knob, one holder per key, release on entry-effect exit). Replaces the explicit `claims` / `claimOutcomes` row design described in earlier drafts of this SDD. |
| Per-host process budget: "this host runs at most N concurrent contexts" | In-memory `Semaphore(N)` | In-process throttling. Doesn't need to be durable — only this host process consults it. |
| Cluster-wide process budget (optional, future): "this Firegrid environment runs at most M concurrent contexts" | `DurableSemaphore` | Optional. Useful if external resource constraints (sandbox quotas, license limits) require a cluster-wide bound. Not blocking on. |
| Cluster-wide fairness across workflows or capability classes (optional, future) | `DurablePartitionedSemaphore<workflowName>` or `<capabilityClass>` | Optional fairness layer on top of the cluster budget. "No single workflow monopolizes the host pool." Not blocking on. |
| In-process duplicate suppression: "don't launch this contextId twice in this host process" | Optional `Set<contextId>` or per-key in-process latch | Belt-and-braces. The durable mutex is the load-bearing fence; the in-process guard is redundant correctness insurance for the same host process. |

`DurableKeyedMutex<contextId>` is the **only required new primitive** for
this dispatcher to be correct. The `DurableSemaphore` and
`DurablePartitionedSemaphore` lines are documented here so the dispatcher
SDD doesn't quietly bake in unbounded host concurrency assumptions — if
product pressure introduces those layers later, they slot in at the
documented seams.

This SDD is the **first declared customer** of `DurableKeyedMutex`. The
Flamecast toy host's in-process `Set<contextId>` becomes the second
consumer once its watcher moves into `@firegrid/runtime` and consumes
the dispatcher's mutex directly.

The proposal also defines a sibling primitive, `DurableClaim<K>`, with
**different lifecycle semantics** — write-once, no release — for
AtMostOnce side effects (stdin delivery, workflow activity claims).
`DurableClaim` is not used by this SDD; the distinction matters because
the dispatcher's contextId ownership is release-on-exit (the workflow
terminates and the slot frees), not write-once. Conflating the two
primitives would break either AtMostOnce delivery or dispatcher slot
recovery. See the proposal's decision-rule table for the criteria.

### Implementation precondition

`DurableKeyedMutex` requires a cross-host fence at the substrate level
— specifically, a Durable Streams **server-side conditional append**
that rejects duplicate writes for the same logical key. A client-side
`.get`-then-`.upsert` against `DurableTable` is **not** sufficient: two
hosts with stale local views can each observe "no holder exists" and
both upsert successfully.

The proposal recommends amending `firegrid-durable-tools.BOUNDARIES.8`
to permit a `DurableTable.insertIfAbsent(row)` action implemented over
the Durable Streams idempotent-producer append pattern (the same fence
mechanism the existing activity-claim path uses today, lifted into a
typed action).

**`Path A` (first-by-stream-offset materialization without
`insertIfAbsent`) is single-host / dev only**: under multi-host
deployment, two hosts can each observe the absence of a holder, each
append a row, and each act on their own write before the materializer
selects a winner. That is exactly the failure mode this SDD is
intended to eliminate, so **the dispatcher cannot ship on Path A**.
The dispatcher's correctness invariants require `Path B`
(`insertIfAbsent` + server-rejected duplicates). See the proposal's
"Substrate fence" section for the concrete substrate guarantee
required.

## Materialized Host State

Add a runtime-owned durable table, tentatively `RuntimeHostTable`, on a stream
derived from the same service base URL and namespace as the existing runtime
tables.

Candidate collections:

| Collection | Primary key | Purpose |
| --- | --- | --- |
| `hosts` | `hostId` | Durable host descriptor: topology, provider, capabilities, status, started timestamp, last heartbeat timestamp, and public metadata tags. |
| `heartbeats` | `heartbeatId` | Append-only heartbeat evidence for liveness and load. |
| `hostEvents` | `hostEventId` | Optional audit/event rows for registration, readiness, retirement, and stale-owner evidence. |

The `claims` and `claimOutcomes` collections that earlier drafts of this
SDD owned are **moved out of this design** and into
`DurableKeyedMutex<contextId>` as its private implementation rows. The
dispatcher does not read or write claim rows directly; it consumes
`DurableKeyedMutex.tryWithLock` / `withLock` and treats the mutex as an
opaque substrate primitive. This is the same separation Fireline's prior
art recommends: shared claim code decides whether to acquire, evaluate,
or skip; product code owns eligibility and execution.

Claim rows remain append-only facts inside the primitive's
implementation. The dispatcher's correctness depends on the
**server-side conditional append** described in the Implementation
precondition section above: only one of two racing hosts has its claim
row accepted by Durable Streams, and the dispatcher only sees the
winner-or-skip decision through the primitive's interface.

## Materialized Views

The dispatcher should maintain local materialized views built from retained rows
before it performs live side effects.

Required views:

- `ContextWorkView`: context row, latest run status, terminal status, provider
  compatibility, and existing attempts for each `contextId`.
- `HostPresenceView`: current host descriptors, heartbeat freshness, readiness,
  retired/stale status, and capabilities.
- `ClaimWinnerView`: first valid claim winner for each `contextId`, plus
  released, expired, or transferred evidence.
- `OwnedWorkView`: contexts whose authoritative claim winner is this host and
  whose work is not terminal.

The replay/live boundary addresses the Electric Cloud race directly. A host may
observe a retained context row during replay, but it must not call
`startRuntime` until it has also replayed relevant run rows, claim rows, host
liveness rows, and reached the live boundary.

Once live, the dispatcher reacts to incremental changes. It can still use
DurableTable collection subscriptions and TanStack-derived queries for UI and
local projection, but side-effect authority comes from the materialized
claim-winner view, not from a naked context subscription.

## Claim Lifecycle

With claim mechanics absorbed into `DurableKeyedMutex<contextId>`, the
dispatcher's logical loop collapses to:

```ts
contextStream.pipe(
  Stream.runForEach((context) =>
    Effect.gen(function*() {
      if (yield* isTerminalOrIncompatible(context)) return     // step 2
      yield* mutex.tryWithLock(context.contextId,              // steps 3–6
        Effect.gen(function*() {
          // step 7: dead-owner policy is invoked by the mutex's
          // stalePolicy callback, not by inline dispatcher code.
          yield* startRuntime({                                 // step 8
            contextId: context.contextId,
            claimId: yield* mutex.currentClaimId(context.contextId),
            hostId,
            fenceToken: yield* mutex.currentFenceToken(context.contextId),
            epoch,
          })
        }),
      ).pipe(
        Effect.tap(Option.match({                               // step 9
          onNone:  () => Effect.void,                           //   skipped: another host won
          onSome:  () => Effect.void,                           //   ran: runs/output rows written inside startRuntime
        })),
        Effect.forkScoped,
      )
    })
  ),
)
```

Mapping the previous step-by-step list to the new shape:

| Previous step | New owner |
|---|---|
| 1. Observe context and run state | `contextStream` (replay/live-aware materialization, unchanged) |
| 2. Skip terminal or incompatible contexts | Eligibility filter `isTerminalOrIncompatible(context)` |
| 3. Append a claim with this host id | `DurableKeyedMutex.tryWithLock` (entry) |
| 4. Observe claim rows through the materializer | Internal to `DurableKeyedMutex` |
| 5. Schedule execution if winner | The `Option.some` branch returned by `tryWithLock` |
| 6. Skip if another live host owns the winner claim | The `Option.none` branch |
| 7. Stale-holder takeover policy | `stalePolicy` option on the mutex; consumes `HostPresenceView` |
| 8. Start runtime attempt after ownership established | Inside the `tryWithLock` body; fence metadata is what the primitive emits |
| 9. Write run + output rows with claim/fence identity | `startRuntime` (passes the metadata through to run rows) |

The v0 mutex implementation refuses stale-holder takeover by default —
that is the spec-aligned conservative choice. The dispatcher gets
stale-holder takeover the same way other consumers will: by configuring
the mutex's `stalePolicy` with `HostPresenceView` once the
`firegrid-runtime-ownership-transfer.*` evidence rows are in place. The
dispatcher SDD does not re-implement the policy machinery.

## Host Liveness

Host liveness should be durable and advisory until paired with claim/fence
rules.

On startup, a runtime process creates a host descriptor:

```txt
hostId
topologyId
namespace
providerKinds
capabilities
status = starting | ready | draining | retired | broken
startedAt
lastHeartbeatAt
tags
```

During execution, it appends heartbeat evidence at a configured cadence. The
presence projection exposes freshness using a documented threshold. Other hosts
may use freshness as input to dead-owner policy, but freshness alone must not
transfer ownership. Transfer requires durable stale-owner evidence plus a new
claim/fence fact.

This matches `firegrid-runtime-presence.CONSISTENCY.1`: presence is discovery
state, not authority. Claims and fences are authority.

## Runtime Package Surface

`@firegrid/runtime` should expose platform-neutral Effects and Layers. It
should not import or run `NodeRuntime` for applications.

Candidate exports:

```ts
export class RuntimeHostIdentity extends Context.Tag(...)

export const RuntimeHostTable: DurableTableTagClass<...>

export interface RuntimeHostDispatcherOptions {
  readonly providerKinds?: ReadonlyArray<string>
  readonly tags?: Record<string, string>
  readonly heartbeatInterval?: DurationInput
  readonly staleAfter?: DurationInput
  /**
   * In-process concurrent-context cap. Defaults to unbounded; set to
   * the host's resource budget if the deployment has one.
   */
  readonly maxConcurrentContexts?: number
}

export const RuntimeHostDispatcherLive: Layer.Layer<...>

export const runRuntimeHostDispatcher:
  Effect.Effect<never, RuntimeHostDispatcherError, ...>
```

The dispatcher Layer's internal dependencies include a
`DurableKeyedMutex<contextId>` configured with the `RuntimeHostTable`'s
backing stream URL plus the host's `stalePolicy` callback. The mutex's
public type is `DurableKeyedMutex.Type<string>` (contextId as the
string-encoded key), exported from `effect-durable-operators`. The
dispatcher does not re-export the mutex — consumers that need their own
durable lock should import the primitive directly.

The root app owns the platform boundary:

```ts
import { NodeRuntime } from "@effect/platform-node"
import {
  FiregridRuntimeHostFromConfig,
  RuntimeHostDispatcherLive,
  runRuntimeHostDispatcher,
} from "@firegrid/runtime"
import { Effect } from "effect"

NodeRuntime.runMain(
  Effect.scoped(
    runRuntimeHostDispatcher.pipe(
      Effect.provide(RuntimeHostDispatcherLive),
      Effect.provide(FiregridRuntimeHostFromConfig),
    ),
  ),
)
```

Flamecast should then delete its app-owned host watcher. The Flamecast UI keeps
using `@firegrid/client` for `launch`, `prompt`, and `open`, and uses
DurableTable React live queries for observation. Runtime execution is handled by
the shared runtime dispatcher.

## Interaction With Existing Runtime Tables

The existing tables remain:

- `RuntimeControlPlaneTable.contexts`: launch intent.
- `RuntimeControlPlaneTable.runs`: run lifecycle evidence.
- `RuntimeIngressTable.inputs`: stdin/input delivery.
- `RuntimeOutputTable.events` and `RuntimeOutputTable.logs`: durable process
  output.

The new host dispatcher adds ownership and liveness materialization. It does
not replace `startRuntime`; it decides when a host may call `startRuntime`.

`startRuntime` should eventually accept claim/fence context so rows can carry
ownership evidence:

```ts
startRuntime({
  contextId,
  claimId,
  hostId,
  fenceToken,
  epoch,
})
```

Until that exists, `startRuntime({ contextId })` remains a single-host/dev
primitive, and the dispatcher should be the only production path that invokes
it.

## How This Addresses The Flamecast Failure

The current Flamecast host races because a context subscription and a context
point read occur in different materialized clients. The dispatcher model removes
that race from the execution decision:

- One dispatcher materializes replay state before live side effects.
- Context intent, run status, host liveness, and claims are folded into a single
  local execution view.
- A context event alone is insufficient to start work.
- The host appends a claim and waits to observe itself as authoritative winner.
- Duplicate hosts may observe the same context, but only the winning claim owner
  starts side effects.
- Browser/UI live queries can lag independently without affecting execution
  authority.

The result is a clean split:

```txt
Flamecast app: launch and observe runtime contexts.
Firegrid runtime host: claim and execute eligible contexts.
Durable Streams: source of truth for intent, ownership, liveness, runs, output.
```

## Rollout Plan

Sequenced to land the durable-concurrency primitives once (in
`effect-durable-operators`) and consume them from multiple sites:

1. **Spec amendment**: amend
   `firegrid-durable-tools.BOUNDARIES.8` to permit
   `DurableTable.insertIfAbsent`. Justified by this SDD plus
   `PROPOSAL_DURABLE_CLAIM_PRIMITIVE_2026-05-13.md` as concrete
   load-bearing customers. Docs-only PR.
2. **Substrate primitive**: implement `DurableTable.insertIfAbsent` in
   `effect-durable-operators`. New spec ACID under
   `effect-durable-operators.TABLE.*`. Spec + impl PR.
3. **Concurrency primitives**: implement `DurableKeyedMutex<K>` (the
   required one for this SDD) plus optional `DurableSemaphore` and
   `DurablePartitionedSemaphore<K>` in `effect-durable-operators`. New
   feature spec or extension to `effect-durable-operators.feature.yaml`.
4. **Migrate existing claim sites** to `DurableKeyedMutex` as a single
   PR that proves the API against three real consumers:
   - Workflow activity claims
     (`packages/runtime/src/workflow-engine/internal/engine-runtime.ts:42-105`)
   - Runtime ingress stdin delivery
     (`packages/runtime/src/providers/sandboxes/local-process-stdin-delivery.ts`)
   - Flamecast toy host duplicate-suppression
     (`apps/flamecast/src/runtime/host.ts:35-54`)
5. **Add `RuntimeHostTable` declarations** and a docs-backed feature
   spec for host descriptors, heartbeats, and host events. Note: the
   claims / claimOutcomes collections proposed in earlier drafts of this
   SDD are now `DurableKeyedMutex` internals, not RuntimeHostTable rows.
6. **Implement the dispatcher** as a runtime Layer consuming
   `DurableKeyedMutex<contextId>` plus the host-presence materializer.
7. **Move Flamecast's host watcher** out of `apps/flamecast` and replace
   it with the runtime dispatcher surface from `@firegrid/runtime`.
8. **Stale-holder takeover** lane: implement
   `firegrid-runtime-ownership-transfer.*` evidence rows and wire them
   into the mutex's `stalePolicy` callback.
9. **Extend `startRuntime`** and run rows to include claim/fence
   metadata emitted by the mutex.
10. **Multi-host tests** that prove replay has no side effects, first
    valid claim wins, non-winning hosts skip, duplicate scheduling is
    suppressed, and stale-holder policy fires only on durable
    stale-owner evidence.

Steps 3 and 4 can land as one PR — implementing the primitives alongside
the three migrations validates the API against real call sites before
the dispatcher consumes it. The dispatcher (steps 5–7) then becomes the
fourth consumer, with the primitives already battle-tested.

## Open Questions

- Should host identity be supplied by env/config, generated per process start,
  or derived from a stable deployment identity plus process instance id?
- How much host capability matching belongs in Firegrid v1 versus product-owned
  provider helpers?
- What is the smallest fence token primitive needed before stale-owner takeover
  can safely start live side effects? (Most likely: an epoch counter persisted
  on the host descriptor row, bumped on each `withLock` entry. Detail belongs
  in `DurableKeyedMutex`'s spec, not here.)
- Should the `DurableKeyedMutex<contextId>` live on the same stream as
  `RuntimeHostTable`, or on its own derived stream
  (`firegrid.runtimeHost.contextLocks`)? Recommendation: own stream — lock
  rows have a different retention profile than host descriptors and
  separating them keeps the mutex implementation reusable for other consumers
  who don't have a `RuntimeHostTable`.

### Resolved (folded into Claim Modeling section)

- ~~Should claim winner projection consume raw Durable Streams state envelopes
  so stream offset is the tie-breaker, or should DurableTable expose enough
  ordered change metadata for this materializer?~~ → The dispatcher
  requires a **substrate-level server-side conditional append**
  (`DurableTable.insertIfAbsent`, Path B), not a client-side materializer
  trick. Stream-offset materialization (Path A) is single-host / dev only
  and cannot be the dispatcher's correctness mechanism, because under
  multi-host both hosts can write before the materializer decides a
  winner. The dispatcher's interface to the mutex is the same regardless;
  the substrate guarantee is what differs.
- ~~Should claim rows live in the same stream as runtime control-plane rows
  or in a separate `firegrid.runtimeHost` stream?~~ → Claim rows are now
  internal to `DurableKeyedMutex` and are not part of the dispatcher's row
  ownership at all. See the "own stream" recommendation above for where the
  mutex's backing stream lives.

