# Proposal: Durable Concurrency Primitives Backed by `DurableTable`

**Date:** 2026-05-13
**Status:** Proposed (no implementation yet).
**Author:** OLA (durable-tools `wait_for` implementation feedback +
coordinator review).
**Related:**
- [`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`](./SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md) — the
  primary customer of the primitives proposed here.
- [`firegrid-durable-tools.feature.yaml`](../../features/firegrid/firegrid-durable-tools.feature.yaml) — `BOUNDARIES.8`
  currently forbids the fenced primitive these designs assume; this
  proposal recommends amending it.
- Effect upstream:
  [`Semaphore`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Semaphore.ts),
  [`PartitionedSemaphore`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/PartitionedSemaphore.ts).

## Summary

Implement durable analogs of Effect's concurrency primitives, backed by the
Firegrid durable substrate (`DurableTable` for state, fenced
`insertIfAbsent` for the cross-host fence). The public types are
**interface-compatible** with the existing Effect primitives where the
semantics match; we introduce a third primitive (`DurableKeyedMutex`) only
where neither existing interface fits.

Three primitives, in increasing order of distance from existing Effect
contracts:

1. **`DurableSemaphore`** — implements Effect's `Semaphore` interface.
   Total durable permit budget shared across all callers.
2. **`DurablePartitionedSemaphore<K>`** — implements Effect's
   `PartitionedSemaphore<K>` interface. Total durable budget, round-robin
   fair across partition keys.
3. **`DurableKeyedMutex<K>`** — new primitive. One holder per key, no
   capacity sharing across keys. The mutual-exclusion-per-logical-resource
   pattern existing `Effect` doesn't ship.

The runtime-host dispatcher (`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`)
is the **first customer**: it provides design pressure for all three (one
per-context lock for ownership; one shared semaphore for per-environment
process budget; one partitioned semaphore for fairness across workflows or
capability classes). Existing claim sites in the codebase migrate to
`DurableKeyedMutex` as soon as the primitive exists.

## Why the interface compatibility matters

The interface contract is what makes the proposal land. Callers should be
able to write:

```ts
const sem: Semaphore.Semaphore = yield* DurableSemaphore.make({
  permits: 100,
  streamUrl: `${baseUrl}/v1/stream/firegrid.processBudget`,
})

yield* sem.withPermits(1)(launchRuntimeProcess(contextId))
```

…without learning new vocabulary, and without `withPermits` behavior
diverging from what a reader expects from
[`Effect.Semaphore`](https://effect.website/docs/concurrency/semaphore/).
The only thing different from the in-memory version is the backing store
and the cost profile (a write per acquire instead of an atomic counter
decrement).

When the existing Effect contract doesn't model the pattern (per-key
mutual exclusion), we name the new primitive honestly rather than warping
`PartitionedSemaphore` semantics. Picking a misleading name —
`DurablePartitionedSemaphore` for what's actually a keyed mutex — is the
exact mistake that landed `DurableConsumer` and friends.

## The primitives

### `DurableSemaphore` (Effect's `Semaphore` interface, durable backing)

```ts
import * as Semaphore from "effect/Semaphore"

export const DurableSemaphore: {
  readonly make: (options: {
    readonly permits: number
    readonly streamUrl: string
    readonly contentType?: string
  }) => Effect.Effect<Semaphore.Semaphore, DurableTableError, Scope.Scope>
}
```

- Stores a single durable permits-table (rows: `{ permitId, holderId,
  takenAt, releasedAt? }`).
- `take(n)` writes `n` claim rows (or one row with `permits: n` —
  implementation detail) and suspends durably if the materialized
  outstanding count exceeds `permits - n`.
- `release(n)` writes release rows; durably-suspended takers resume in
  stream order.
- `withPermits(n)(effect)` = scope-bound take + release-on-exit, matching
  the in-memory contract: permits release on success, failure, *and*
  interruption (the work didn't keep its slot).

**Use cases:**

- *Cross-host process budget.* "This Firegrid environment runs at most
  100 concurrent runtime processes across all hosts." Today there is no
  such bound — see "Cross-references" #3 below.

### `DurablePartitionedSemaphore<K>` (Effect's interface, durable backing)

```ts
import * as PartitionedSemaphore from "effect/PartitionedSemaphore"

export const DurablePartitionedSemaphore: {
  readonly make: <K>(options: {
    readonly permits: number
    readonly streamUrl: string
    readonly contentType?: string
    readonly keySchema: Schema.Schema<K, string>
  }) => Effect.Effect<
    PartitionedSemaphore.PartitionedSemaphore<K>,
    DurableTableError,
    Scope.Scope
  >
}
```

- **Same semantics as the in-memory `PartitionedSemaphore`**: `permits` is
  a **global** budget shared across all partition keys; partition key
  determines round-robin fairness when permits are scarce. We don't
  re-define the contract.
- `keySchema` is required because the durable rows need a stable string
  encoding of `K` (mirrors `DurableTable.primaryKey`'s
  `Schema.transformOrFail` convention; see
  `firegrid-durable-tools.BOUNDARIES.6`).

**Use cases:**

- *Fair cross-host process budget across workflows.* "At most 100
  concurrent processes globally, distributed fairly across workflow names
  so a single noisy workflow can't monopolize the pool."
- *Fair process budget across capability classes.* Same shape with
  `keySchema = capabilityClass` ("GPU contexts" vs "CPU contexts").

### `DurableKeyedMutex<K>` (new primitive)

```ts
export interface DurableKeyedMutex<K> {
  /**
   * Scope-bound durable lock acquisition for a logical resource.
   * - On entry: writes a claim row keyed by `K`. If a non-released holder
   *   row exists for the same key, this caller suspends durably.
   * - On Effect success, failure, OR interruption: writes a release row
   *   keyed by `K`; other waiters in stream order resume.
   *
   * Backed by `DurableTable.insertIfAbsent` (or first-by-stream-offset
   * materialization until that primitive lands).
   */
  readonly withLock: <A, E, R>(
    key: K,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DurableLockError, R>

  /**
   * Non-suspending variant: try to acquire; if a holder exists, returns
   * `Option.none`. Useful for "skip if owned by another caller" code
   * paths like the dispatcher's claim-eligibility check.
   */
  readonly tryWithLock: <A, E, R>(
    key: K,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | DurableLockError, R>
}

export const DurableKeyedMutex: {
  readonly make: <K>(options: {
    readonly streamUrl: string
    readonly contentType?: string
    readonly keySchema: Schema.Schema<K, string>
    /**
     * Optional stale-holder policy. If a holder row exists but its
     * holder is no longer live (per `HostPresenceView` or equivalent),
     * the lock may be transferred. v0 default: refuse takeover; require
     * explicit operator action.
     */
    readonly stalePolicy?: StaleHolderPolicy<K>
  }) => Effect.Effect<DurableKeyedMutex<K>, DurableTableError, Scope.Scope>
}
```

Why not a `Semaphore`-shaped interface for this?

- `Semaphore` and `PartitionedSemaphore` both express "shared budget";
  this primitive expresses "one holder per key." Capacity is not a knob.
- The existing in-memory community pattern for this is `Map<K,
  Semaphore.Semaphore>` with each entry constructed at capacity 1 — a
  composition, not a primitive. The durable equivalent earns being its
  own type because the durability concerns (stale-holder takeover,
  release-on-failure semantics, the fenced acquire underneath) are
  load-bearing in the type's contract.

**Use cases:**

- *Per-context ownership in the runtime-host dispatcher.* "One host runs
  each contextId." Today this is the gap that
  `SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md` is filling.
- *Activity claim fencing in the workflow engine.* Today this is a raw
  `DurableStream.producer.append` path —
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:42-105`.
- *Ingress stdin delivery claim.* Today this is an inline upsert in
  `packages/runtime/src/providers/sandboxes/local-process-stdin-delivery.ts`.
- *(Future)* `execute(sandbox, input)` and `spawn(agent, prompt)` durable
  tools in `firegrid-durable-tools` — both need per-invocation mutual
  exclusion.

## Cross-references: what these primitives replace in the codebase

### 1. Workflow activity claims (highest-value migration)

**Where:** `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:42-105`.

**What's there today:** Three functions — `appendActivityClaimInsert`,
`waitForActivityClaim`, `claimActivity` — that hand-roll fenced claim
acquisition by:

- Producing a raw `DurableStream.producer` per call with a deterministic
  `producerId` (the fence).
- Appending a State Protocol-compatible insert event by hand (`type`,
  `key`, `value`, `headers`).
- Polling `table.activityClaims.get(claimKey)` in a 10ms-interval loop up
  to 200 iterations (~2s) to wait for the materialized claim to land.

This is the **only** raw-Durable-Streams append in production runtime
code and is explicitly called out by
`firegrid-durable-tools.BOUNDARIES.4` as a path other tool authors
should NOT copy.

**What it becomes with `DurableKeyedMutex<ActivityClaimKey>`:**

```ts
const activityKey = { executionId, activityName, attempt }
const result = yield* mutex.tryWithLock(activityKey,
  Effect.gen(function*() {
    // The body that was claimActivity → activity.executeEncoded → upsert.
    const activityInstance = WorkflowEngine.WorkflowInstance.initial(...)
    return yield* activity.executeEncoded.pipe(
      Workflow.intoResult,
      Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
    )
  })
)
// result: Option<Workflow.Result>. None means another worker won the claim.
```

The 10ms-poll-loop disappears (durable suspend replaces it). The raw
`DurableStream.producer` import in `engine-runtime.ts` disappears. The
"fence-via-deterministic-producerId" trick disappears — replaced by
`DurableTable.insertIfAbsent` once landed.

### 2. Runtime ingress stdin delivery claim

**Where:** `packages/runtime/src/providers/sandboxes/local-process-stdin-delivery.ts`,
specifically the `mapEffect` block beginning at line ~194 (the "claim a
delivery before emitting bytes" path).

**What's there today:** A `.get` + `if claimed skip` + `.upsert` triple
on `RuntimeIngressTable.deliveries`, keyed by `(subscriberId, inputId)`.
Single-host AtMostOnce; multi-host raced delivery is not currently a
concern but the row shape is already prepared for it.

**What it becomes with `DurableKeyedMutex<RuntimeInputDeliveryKey>`:**

```ts
yield* mutex.withLock({ subscriberId, inputId },
  emitBytesToStdin(row),
)
```

Cleaner, and the `.get`-then-`.upsert` race window (currently safe under
single-host by design, but easy to misread) is replaced by a documented
mutex.

### 3. Flamecast toy host duplicate-suppression

**Where:** `apps/flamecast/src/runtime/host.ts:35-54`.

**What's there today:** A local `Set<string>` of running context ids, an
async `shouldStart(contextId)` snapshot check, and a `Effect.ensuring`
cleanup to remove from the set on exit.

This is structurally correct *for a single host process* but cannot
prevent two hosts pointed at the same namespace from both calling
`startRuntime` on the same context — exactly the failure mode the
dispatcher SDD describes.

**What it becomes with `DurableKeyedMutex<contextId>`:**

```ts
yield* mutex.tryWithLock(context.contextId,
  startRuntime({ contextId: context.contextId }),
).pipe(
  Effect.tap(Option.match({
    onNone: () => Effect.void,    // Another host won the lock; skip.
    onSome: () => Effect.void,    // We owned the lock and ran the work.
  })),
  Effect.forkScoped,
)
```

The `Set<contextId>` becomes optional (in-process belt-and-braces; the
durable lock is the load-bearing fence). The `shouldStart` snapshot
check stays as eligibility filtering for terminal contexts (`status ===
"exited"`); it is no longer doing concurrency control.

### 4. Wait/completion rows in `wait_for` (not a claim — for clarity)

**Where:** `packages/runtime/src/durable-tools/internal/`.

These rows are a durable rendezvous (workflow suspends on a
`DurableDeferred`, router resolves it), **not** a claim-before-side-effect
gate. They do not migrate to `DurableKeyedMutex`. Documenting this here
so future readers don't conflate the patterns.

## Integration with the dispatcher SDD

`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md` is the canonical
first customer. Rather than each part of the dispatcher inventing claim
mechanics, the SDD should consume these primitives:

### The dispatcher's "Claim Lifecycle" section maps to:

| SDD step | Primitive | Notes |
|---|---|---|
| 1. Observe context + run state | `RuntimeControlPlaneTable` materialization | Unchanged. |
| 2. Skip terminal/incompatible contexts | Eligibility filter (no claim primitive) | Unchanged. |
| 3. Append a claim with this host id | `DurableKeyedMutex<contextId>.tryWithLock` | Replaces the "append-only claim facts + first-by-stream materialized winner" implementation detail with a typed primitive. The materialization rules are now the primitive's implementation, not the dispatcher's. |
| 4. Observe claim rows through the materializer | (internal to the primitive) | The dispatcher does not see claim rows directly; it just sees `Option.some` (we won) or `Option.none` (another host won). |
| 5. If this host is the winner, schedule execution once | The `Option.some` branch | The `withLock` scope ensures release-on-exit regardless of success/failure/interruption. |
| 6. If another live host owns the winner claim, skip | The `Option.none` branch | No-op; come back when the claim releases. |
| 7. Dead-owner takeover | `stalePolicy` option on the mutex | v0: refuse takeover (default). v1: pluggable stale-holder policy that consumes `HostPresenceView`. |
| 8. Start runtime attempt after ownership established | Inside the `tryWithLock` body | `startRuntime({ contextId, claimId, hostId, fenceToken, epoch })` — fence metadata is what the primitive emits. |
| 9. Write run + output rows | Existing tables | Unchanged. |

### What this changes in the SDD

The dispatcher SDD currently describes claim mechanics in some detail
(separate `claims`, `claimOutcomes` collections; first-claim-by-stream
projection; release/expired/transferred evidence rows). The proposed
primitives absorb most of that:

- `claims` and `claimOutcomes` rows become the implementation detail of
  `DurableKeyedMutex` — the dispatcher no longer reasons about them
  directly.
- `HostPresenceView` stays as-is and feeds `stalePolicy`.
- The dispatcher's job shrinks to: "subscribe to eligible contexts,
  `tryWithLock` each one, run if we won, skip if we didn't."

That's a significant simplification. It also means the dispatcher SDD
gains a clean separation between **substrate** (the mutex; durable
mechanics) and **policy** (eligibility, stale-holder rules, dispatch
ordering) — the same separation Fireline's prior art recommends.

### Where the dispatcher uses each primitive

Cross-referencing the dispatcher SDD's concerns to the three primitives:

| Concern | Primitive | Partition key (if applicable) | Notes |
|---|---|---|---|
| Cross-host mutual exclusion ("one host runs each contextId") | `DurableKeyedMutex<contextId>` | n/a (keyed mutex isolates per key) | The load-bearing dispatcher fence. |
| Per-host process budget ("this host runs at most 4 concurrent contexts") | `Semaphore` (in-memory) | n/a | In-process throttling. Doesn't need to be durable; only this host process sees it. |
| Cluster-wide process budget ("this Firegrid environment runs at most 100 concurrent contexts") | `DurableSemaphore` | n/a | Optional. Useful if there's an external resource constraint (sandbox quotas, license limits). Not in the dispatcher SDD today. |
| Cluster-wide fair share across workflows ("no single workflow monopolizes the pool") | `DurablePartitionedSemaphore<workflowName>` | `workflowName` | Optional. Fairness layer on top of the cluster budget. |
| In-process duplicate suppression ("don't launch this contextId twice in this process") | Optional `Set<contextId>` or per-key in-process latch | n/a | Belt-and-braces; the durable mutex is the load-bearing fence. |

The dispatcher's *required* dependency is `DurableKeyedMutex<contextId>`.
`DurableSemaphore` and `DurablePartitionedSemaphore` are optional layers
that the SDD can name as future-work without blocking on.

## Implementation precondition: `DurableTable.insertIfAbsent`

All three primitives need a correct cross-host fence to be sound under
raced acquirers. Today, `firegrid-durable-tools.BOUNDARIES.8` reads:

> DurableTable does not grow a fenced-claim, compare-and-set, or
> insert-if-absent action to support wait_for; wait dispatch idempotency
> is provided by deterministic wait keys and the per-dispatch lifecycle
> re-check.

That bar was right for `wait_for` (which has the looser "exactly one of
match/timeout resolves via `engine.deferredDone` idempotency" guarantee).
It is **wrong for the dispatcher**, which needs hard mutual exclusion
without an external idempotency oracle.

This proposal recommends **amending `BOUNDARIES.8`** to permit a
`DurableTable.insertIfAbsent(row)` action that returns
`Effect<{ inserted: boolean }, DurableTableError>`. The amendment
justification: the dispatcher is the load-bearing customer that
demonstrates the primitive is necessary, not speculative.

### Two implementation paths

**Path A (no spec change, single-host correct, multi-host probabilistic):**

- Implement all three primitives with `DurableTable.upsert`-style writes
  plus first-by-stream-offset materialization for tie-breaking.
- Requires `DurableTable` to expose stable stream-offset metadata on
  rows (not currently exposed in the public surface).
- Single-host correctness is trivial; multi-host correctness depends on
  the materializer seeing the same offset ordering across all hosts.
- Useful for shipping v0 of the dispatcher with single-host semantics.

**Path B (requires `BOUNDARIES.8` amendment, multi-host correct):**

- Add `DurableTable.insertIfAbsent` as a generated action alongside
  `insert` / `upsert` / `delete`.
- Implement all three primitives over `insertIfAbsent` — server
  rejects duplicate claim rows; the rejection is the fence.
- This is the canonical implementation.

**Recommended path:** Land Path A as `v0` of the primitives, then upgrade
to Path B when `BOUNDARIES.8` is amended. Path B does not change the
public interface — only the implementation details under the hood.
Callers don't have to migrate.

## Sequencing recommendation for the coordinator

1. **Amend `firegrid-durable-tools.BOUNDARIES.8`** as a docs-only spec
   PR. Justification: this proposal + the dispatcher SDD as concrete
   load-bearing customers.
2. **Add `DurableTable.insertIfAbsent`** to `effect-durable-operators`.
   New spec ACID under `effect-durable-operators.TABLE.*` documenting
   the semantic (server-rejected duplicate keys, typed conflict result).
   Spec PR + impl PR (the impl PR may follow immediately because the
   spec change is small and reviewable independently).
3. **Implement `DurableKeyedMutex<K>`** under `@firegrid/runtime` (start
   runtime-private; promote to `effect-durable-operators` once a
   second consumer materializes — currently three sites would consume
   it, so promotion bar is met from day one).
4. **Implement `DurableSemaphore` and `DurablePartitionedSemaphore<K>`**
   alongside, since the implementation cost is incremental once the
   underlying `insertIfAbsent` exists.
5. **Migrate the three existing claim sites** (activity claims, ingress
   delivery, Flamecast toy host) to `DurableKeyedMutex` as the first
   wave. This validates the primitive against real call sites *before*
   the dispatcher consumes it.
6. **Rewrite the dispatcher SDD** to consume the primitives by name. The
   SDD shrinks substantially — most of its "Claim Lifecycle" section
   becomes "the mutex handles it."
7. **Implement the dispatcher.** First customer of the optional
   `DurableSemaphore` and `DurablePartitionedSemaphore` layers if/when
   product pressure justifies them.

Steps 3 and 5 can be combined into one PR; the bar for promotion to
`effect-durable-operators` is met by the three concrete consumers in the
codebase today, and migrating them in the same PR proves the API shape.

## Non-goals

- This proposal does **not** suggest a generic durable-state framework.
  Each tool keeps its typed `DurableTable` row schemas; the primitives
  are utilities, not service planes.
- This proposal does **not** unify `wait_for`'s wait/completion rows
  with claim semantics. Waits and completions are a durable rendezvous,
  not a claim-before-side-effect gate (see Cross-references #4).
- This proposal does **not** add concurrency primitives outside the
  three named. If a future product surface needs durable-fair queueing,
  durable rate limiting, or durable circuit-breaking, those are
  separate proposals against the Effect upstream equivalents
  (`RateLimiter`, etc.).
- This proposal does **not** propose moving in-memory `Semaphore` /
  `PartitionedSemaphore` usage out of any existing call sites.
  Plain Effect primitives stay where they're correct (e.g., per-host
  process budget).

## Open questions for coordinator

1. **Amendment scope for `BOUNDARIES.8`.** Does the amendment permit
   only `insertIfAbsent`, or should it also allow `compareAndSet` /
   `casUpdate` (typed compare-and-set for row updates)? Recommendation:
   start with `insertIfAbsent` only; compare-and-set arrives if a real
   product call site needs it.
2. **Home for `DurableKeyedMutex`.** Inside `effect-durable-operators`
   (visible to all consumers, including non-Firegrid), or inside
   `@firegrid/runtime` (runtime-private, easier to evolve)? Preference:
   `effect-durable-operators` from day one since three Firegrid
   consumers already meet the promotion bar and we don't want to migrate
   later.
3. **Path A first or Path B first?** Implementing Path B (canonical)
   requires landing the `BOUNDARIES.8` amendment and the new
   `DurableTable.insertIfAbsent` action before the primitive can ship.
   Path A unblocks the dispatcher single-host case sooner. Suggested
   order: Path A in one PR for v0, Path B as an upgrade in a follow-up.
4. **Should `DurableKeyedMutex` be type-compatible with any Effect
   primitive?** There's no exact match in the upstream library today.
   Recommendation: don't force compatibility; `withLock(key, effect)` /
   `tryWithLock(key, effect)` is a small, self-explanatory contract.
   Revisit if Effect adds a similar primitive upstream.
5. **Stale-holder policy plumbing.** The `stalePolicy` callback needs
   access to the dispatcher's `HostPresenceView`. Does the policy live
   in `effect-durable-operators` (generic shape) or in
   `@firegrid/runtime` (Firegrid-specific HostPresenceView consumer)?
   Recommendation: generic shape in operators package
   (`StaleHolderPolicy<K> = (key: K, holderEvidence: unknown) =>
   Effect<HolderState>`), Firegrid-specific implementation lives where
   `HostPresenceView` lives.
