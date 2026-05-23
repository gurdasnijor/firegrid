# subscribers/wait-router/

SHAPE: D — durable wait/timeout

Workflow-shaped subscriber that resolves agent `wait_for(channel, trigger)`
calls. The workflow body owns one load-bearing capability:

- **Durable wait with timeout** — the subscriber parks across restarts on a
  durable wait condition (a `FieldEqualsTrigger` over a typed observation
  stream) with a configurable timeout. The durable wait survives host restart;
  a non-workflow subscriber cannot guarantee that.

No `Activity.make`-shaped side effects beyond the bounded match race;
matching itself is the pure `evaluateFieldEquals` transform.

## Files

- `workflow.ts` — `WaitForWorkflow` + `WaitForWorkflowLayer` (the
  `Workflow.make` body races the primary source plus `additionalSources` via
  `Effect.raceAll` inside one journaled `Activity` and bounds it with
  `Effect.race(Effect.sleep(timeoutMs))`).
- `index.ts` — public re-export barrel.

## Shape D justification (per runtime-design-constraints.md §"SDD Gate")

- Canonical role: keyed subscriber (one execution per `executionKey`).
- C1 keyed durable state: complies — `executionKey` is the durable identity.
- C2 handler, not long-lived body: complies — runs once per `wait_for`
  invocation and returns `Match | Timeout`; not RuntimeContext-lifetime.
- C3 durable result identity: complies — `Workflow.idempotencyKey: executionKey`
  is the at-most-once primitive over `WorkflowEngineTable`.
- C4 durable completion / externally resolved wait: complies — the race
  observes typed source streams; the matched row IS the externally-resolved
  completion. Restart re-runs the Activity which re-subscribes and re-finds
  the winner (replay-safe per tf-0xe4).
- C5 no parked entity body: complies — bound to one wait invocation.
- C6 typed source observation: complies — sources are
  `RuntimeObservationSource` variants resolved through
  `RuntimeObservationStreams`.
- C7 first-class schemas: complies — `WaitForWorkflowPayloadSchema`,
  `WaitForWorkflowOutcomeSchema` (`Match` / `Timeout`).

**Workflow machinery justification**: a non-`@effect/workflow` subscriber
cannot bound a multi-source race with a wall-clock timeout that survives host
restart. `DurableClock`-backed `Effect.sleep` inside an `Activity` is the only
restart-safe timeout primitive in this codebase; the race result is journaled
via `Activity.make` so a replay returns the same winner even if the live
sources no longer match (tf-0xe4 durability proof in
`test/subscribers/wait-router/wait-for-workflow.test.ts`).

## Public subpath

`@firegrid/runtime/subscribers/wait-router` (per
`packages/runtime/package.json`).
