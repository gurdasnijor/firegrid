# Review: Post-DurableTable Cleanup Follow-ups

Date: 2026-05-13

Status: follow-up tracker. This document captures code-review findings from
the post-cleanup codebase after `DurableTable`, `wait_for`, and the Flamecast
toy landed. It is intentionally split from the durable-concurrency primitive
proposal so that unrelated fixes do not get bundled into the same PR.

## Summary

The cleanup succeeded at the architectural level:

- `DurableTable` is the single durable table primitive.
- Runtime control-plane, ingress, output, workflow state, and durable-tools
  state all use DurableTable declarations.
- Deleted surfaces did not reappear: `DurableConsumer`, `ConsumerSource`,
  `ConsumerCheckpointStore`, and `DurableProjection` are gone.
- Composite primary keys are schema-owned through `Schema.transformOrFail`
  JSON tuple encodings.
- `wait_for` is bounded: source registration is explicit, router
  subscriptions use `includeInitialState: true`, and completion rows are
  authoritative for recovery.

The remaining debt is concentrated in a small number of fix lanes.

## Addressed By Durable Concurrency Primitive Proposal

Tracked by:

- `docs/proposals/PROPOSAL_DURABLE_CLAIM_PRIMITIVE_2026-05-13.md`
- `docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`

### Activity claim raw append path

Current shape:

- `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`
- raw `DurableStream.producer` path
- deterministic producer id used as the fence
- polling wait for claim materialization

Target:

- `DurableClaim<ActivityClaimKey>`
- implemented over `DurableTable.insertIfAbsent`
- `insertIfAbsent` must be backed by a real server-side conditional append,
  not by client-side `.get` followed by `.upsert`

This removes the raw stream producer path, materialization polling, and
hand-built producer-id convention from workflow activity claims.

### Runtime stdin delivery claim race

Current shape:

- `packages/runtime/src/providers/sandboxes/local-process-stdin-delivery.ts`
- `.get` then `.upsert` claim-before-side-effect path
- correct for single-host v0, racy for multiple hosts with the same
  subscriber id

Target:

- `DurableClaim<RuntimeInputDeliveryKey>`
- write-once, no release
- restart skips even when the side-effect body crashed after claim

Do not replace this with `DurableKeyedMutex`. A release-on-exit mutex is the
wrong lifecycle for AtMostOnce delivery checkpoints.

### Workflow activity-claim namespace coupling

Current shape:

- workflow-engine hand-constructs a producer id prefix for activity claims
- the prefix must remain aligned with the workflow table stream

Target:

- producer-id convention becomes internal to `DurableClaim` /
  `insertIfAbsent`
- call sites stop constructing raw producer ids

## Adjacent Runtime Follow-ups

These are not solved by the concurrency proposal, but they are naturally
nearby runtime-host work.

### Wire durable tools into workflow host composition

`DurableToolsWaitForLive` exists, but production host composition must wire it
alongside the workflow engine and clock driver before `wait_for` is a complete
product path.

Target:

- `FiregridRuntimeHostWithWorkflowLive` provides:
  - workflow engine layer
  - `DurableToolsWaitForLive`
  - source collection registration path
  - workflow clock driver

### Stdin cold-start ordering

`localProcessStdinDelivery` currently subscribes to ingress inputs with
`includeInitialState: true` and sorts within each change batch. If retained
rows arrive across multiple batches, per-batch sorting does not guarantee
global sequence order.

Target options:

- query initial state once, sort globally, then transition to live changes; or
- maintain a high-water mark / ordered pending buffer per context; or
- after `DurableClaim` lands, process via a query-and-claim loop where global
  ordering is explicit.

Do not solve this inside the durable-concurrency primitive PR unless the
migration naturally makes the fix trivial.

## Separate `effect-durable-operators` Fixes

These belong in focused operators-package PRs.

### Composite-key `.get` miss

Tracked in:

- `packages/effect-durable-operators/KNOWN_ISSUES.md`

The `wait_for` implementation works around this with `findWaitByKey` using a
query scan. Root-cause this before promoting `findRowBy` / `subscribeRows`
helpers.

### Synchronous boundary failures should throw directly

Current examples:

- `DurableTable.collection` mutation rejection
- `effect-durable-operators/react` hook failure path

Current code uses `Effect.runSync(Effect.fail(...))`, which throws a
`FiberFailure` instead of the typed error object. These are synchronous
integration boundaries; direct `throw` is clearer.

### Primary-key encode fallback should fail loudly

`DurableTable.primaryKey` currently coerces non-string encoded key values via
`String(...)`. That hides schema bugs. Prefer a typed construction or write
error when a primary-key field does not encode to a string.

### React provider option staleness should be documented

`DurableTableProvider` intentionally captures the initial `layer`, `tables`,
and `onError` for the provider lifetime. Dynamic config changes require a
React remount. Document that in the React subpath docs.

## Separate Workflow / Effect Follow-ups

### `DurableDeferred.raceAll` typing helper

`wait_for` contains a narrow eslint disable around `DurableDeferred.raceAll`
because upstream typings leak `any` into the requirements channel.

Target:

- add a local typed helper around `raceAll`, or
- delete the suppression when the upstream workflow typing is fixed

Do not bundle with claim primitives.

### `@effect/vitest` migration

Tests still use some async `it` + `Effect.runPromise` patterns because the
Effect version bump was intentionally deferred. Migrate when `effect` /
`@effect/workflow` / `@effect/vitest` are bumped together.

## Lower-Priority Audits

- Measure whether the `DurableTable.collection` Proxy is materially costly in
  hot read/query paths before replacing it with a non-Proxy decoded view.
- Audit `effect-durable-streams.tail`; if only tests use it, either mark it
  experimental or retire it.

## Priority Order

1. Root-cause composite-key `.get`.
2. Land `insertIfAbsent` with real server-side conditional append semantics.
3. Implement `DurableClaim` and migrate activity claims + stdin delivery.
4. Replace synchronous `Effect.runSync(Effect.fail(...))` boundary throws with
   direct throws.
5. Wire `DurableToolsWaitForLive` and the workflow clock driver into runtime
   host composition.
6. Fix stdin cold-start ordering before any multi-host rollout.

