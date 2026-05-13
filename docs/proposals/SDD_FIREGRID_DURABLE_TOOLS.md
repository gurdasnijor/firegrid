# SDD: Firegrid Durable Tools

**Status:** draft for design review. No implementation is authorized by this
document alone.
**Current runtime baseline:** post-PR #168. Runtime control plane, ingress,
output, and workflow state are DurableTable-backed. The remaining raw Durable
Streams path is workflow activity-claim fencing.

## Required Reading

1. `AGENTS.md`
2. `repos/effect/AGENTS.md`
3. `docs/architecture/managed-agent-runtime-target-durable-facts.md`
4. `docs/reviews/REVIEW_EFFECT_FULL_AUDIT_2026-05-05.md`
5. `docs/reviews/REVIEW_EFFECT_CODE_STYLE_2026-05-05.md`
6. `docs/reviews/REVIEW_EFFECT_TESTING_2026-05-05.md`
7. `packages/effect-durable-operators/src/DurableTable.ts`
8. `packages/protocol/src/launch/table.ts`
9. `packages/protocol/src/runtime-ingress/schema.ts`
10. `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`

## Thesis

Durable tools are not one magic operator. They are small workflow-facing APIs
backed by durable row families and a few runtime workers:

- DurableTable rows are the source of truth for state.
- `DurableTable.subscribe` drives reactive workers.
- `@effect/workflow` provides replay and durable suspension.
- Claim-before-side-effect rows are enough for the v0 single-host path.
- Multi-worker exactness needs an explicit fenced-claim primitive before we
  generalize it beyond the existing workflow activity-claim path.

The previous "Subscription is the one substrate primitive" framing was too
broad. A subscription router is useful for `wait_for`-style triggers, but
timers, child sessions, tool executions, and claims are distinct row families.

## MVP Assumption

The MVP path is single player / single active host per namespace or context.
Under that assumption, DurableTable claim rows can safely express:

```text
read claim row
if claimed/completed, skip
write claim row through DurableTable generated action
run side effect
write completion row if needed
```

The load-bearing guarantee is that the generated DurableTable write durably
appends before the side effect runs. `awaitTxId` also waits for local
materialization, which is stronger than strictly necessary and should remain.
Keep it because subsequent reads in the same workflow often rely on the local
view being current; removing it would force every later read to handle
"durably written but not yet materialized" as a separate case.

This does not give a multi-worker compare-and-set fence. That is acceptable
for the MVP. Multi-worker `spawn` / `execute` / external side-effect claims are
deferred until DurableTable or a sibling primitive exposes fenced append /
insert-if-absent semantics.

## Existing Claim Semantics

There are two existing patterns. Keep them distinct.

### Runtime Ingress Delivery

`RuntimeIngressTable.deliveries` models local-process stdin delivery:

```text
input row exists
delivery row claimed before bytes are emitted
restart sees claimed row and skips
```

This is the right MVP shape for claim-before-side-effect with DurableTable.
It is single-host safe and product-shaped.

### Workflow Activity Claims

`packages/runtime/src/workflow-engine/internal/engine-runtime.ts` has a raw
Durable Streams activity-claim path. That path exists because activity claims
need raced multi-worker fencing. Do not replace it with `DurableTable.upsert`
until DurableTable has an explicit fenced-claim operation.

The activity-claim path is the reference for the future multi-worker design,
not the default pattern for ordinary tool rows.

## Tool Matrix

| Tool | MVP backing | MVP status | Multi-worker note |
| --- | --- | --- | --- |
| `sleep(durationMs)` | `DurableClock.sleep` + `fireDueWorkflowClocks` over the existing `clockWakeups` DurableTable | Covered by existing workflow-clock path; no Firegrid-owned `sleep(durationMs)` facade in v0 | No side effect except clock resolution. |
| `wait_for(trigger, timeoutMs?)` | Waits table + subscription router + workflow clock for timeout | In scope first; resolves a workflow-engine deferred on an already-running workflow execution | Trigger dispatch is idempotent by deterministic wait key. |
| `schedule_me(when, prompt)` | Schedules table + workflow clock + runtime ingress table | In scope after `wait_for` | Appending the eventual prompt is a side effect; v0 assumes one scheduler. |
| `spawn(agent, prompt)` | Child launch/context rows + parent wait row | Defer for MVP unless product needs it immediately | Needs claim-before-launch for multi-worker. |
| `spawn_all(tasks)` | N child rows + aggregate wait row | Defer | Same as spawn, plus aggregate completion. |
| `execute(sandbox, input)` | Tool execution rows + claim/completion rows | Defer | Externally visible side effect; needs explicit claim design. |

## Table Ownership

The package name `@firegrid/protocol` is historical; today it is the shared
schema/contract package. That does not mean every durable table belongs under
`protocol/src/launch`.

Use these ownership rules:

- `protocol/src/launch`: runtime contexts, runs, and runtime output.
- `protocol/src/runtime-ingress`: runtime input rows and delivery claims.
- New durable tools contracts: add a new shared module such as
  `protocol/src/durable-tools` only when a row family is used across client
  and host boundaries.
- Runtime-private workflow internals stay under `packages/runtime`.
- App-private tables stay with the app.

Do not duplicate the same DurableTable declaration in client and runtime. If a
table crosses the boundary, it has one shared declaration.

## Primary-Key Encoding

All composite primary keys use Effect Schema encoding, not runtime string
helpers.

For new durable-tools tables, prefer the strict launch-table pattern:
`Schema.transformOrFail` to a string-encoded JSON tuple with parse failures
reported through `ParseResult.fail`, matching the composite keys in
`packages/protocol/src/launch/table.ts`. The table facade should receive typed
keys; `DurableTable` handles encoding at the boundary.

Do not use runtime separator concatenation, ad-hoc hashes, or `JSON.stringify`
fallbacks for primary keys. If a separator is needed, it belongs inside the
schema transform and nowhere else. The `RuntimeInputDeliveryKey` separator
schema is existing compatibility, not the convention to extend for new tool
tables.

## Core Row Families

These are conceptual names, not final module names.

### `ToolWaitsTable`

Rows:

- `waits`: durable wait intent and status
- `waitCompletions`: durable match / timeout / cancellation result

Used by:

- `wait_for`
- `spawn` parent waits
- `spawn_all` aggregate waits

### `ToolTimersTable`

Rows:

- `timers`: requested wakeup time and status

This may be unnecessary if `@effect/workflow` clock wakeups already cover the
tool use case cleanly. Prefer reusing workflow clock semantics before adding a
separate timer table.

### `SubscriptionsTable`

Rows:

- `subscriptions`: source table + trigger + target action/workflow + status

This is useful for `wait_for` and projection-style triggers. It is not the
whole durable tools substrate.

### `ToolExecutionsTable`

Rows:

- `executions`: requested sandbox/tool execution and final result
- `claims`: claim-before-side-effect row for dispatch

Defer this until `execute` is an MVP requirement or until the fenced-claim
primitive is designed.

## Subscription Router Design

The router is a scoped runtime worker, not a public service facade.

Inputs:

- `SubscriptionsTable`
- a registry from durable table source name to collection facade
- workflow engine or target dispatcher

Behavior:

1. Subscribe to active subscription rows.
2. For each subscription, attach to the source using `subscribeChanges` with
   `{ includeInitialState: true }`, matching the existing
   `localProcessStdinDelivery` pattern.
3. Treat the initial state and later changes through one code path.
4. For each match, write or resolve the corresponding wait/completion row.
5. If dispatching a workflow, use a deterministic execution id.

Do not implement a separate snapshot query followed by a live subscribe. That
two-step pattern creates a race window between the snapshot and the
subscription. The current codebase already has the better shape:
`subscribeChanges(..., { includeInitialState: true })`.

Trigger expressivity should start narrow:

```ts
fieldEquals: ReadonlyArray<{
  path: ReadonlyArray<string>
  equals: string | number | boolean
}>
```

OR is multiple subscriptions. NOT and arbitrary lambdas are out of scope.

Before implementing the `wait_for` PR, sketch the first three product
`wait_for` call sites and confirm each compiles to this DSL. If a real call
site needs array membership, range checks, defaulted path traversal, or another
predicate, extend the DSL only enough to cover that call site.

### Pause / Retire Lifecycle

The MVP router should not try to solve perfect dynamic fiber lifecycle unless
the first product use case needs it.

For v0, use a per-dispatch status re-check: before writing a completion row or
initiating a workflow, read the subscription row and confirm it is still
`active`. This is simpler than owning a dynamic fiber registry and is good
enough for single-host MVP semantics. A paused or retired subscription may
keep an attached source fiber until host restart, but it must not dispatch new
matches after the status re-check observes the non-active row.

A later router can replace this with explicit stop signals and scoped fiber
ownership if dynamic attach/detach becomes operationally important.

## Workflow Dispatch

Do not add a broad public workflow registry just for this design.

If the subscription router needs to start a workflow by name, add the smallest
runtime-owned bridge necessary. The workflow engine already owns registered
workflow names. A narrow `executeByName` may be acceptable, but this should be
reviewed when implementing the router, not speculatively added now.

The semantic required by the router is fire-and-forget initiation, not
"execute and wait for completion." If a bridge is added, it must start a
workflow durably and return after initiation/dedup, without serializing the
router behind the workflow's eventual completion.

## Claim-Before-Side-Effect

MVP implementation:

```text
const existing = yield* table.claims.get(key)
if completed/claimed, skip
yield* table.claims.upsert({ key, claimedAt })
yield* runSideEffect()
yield* table.claims.upsert({ key, claimedAt, completedAt })
```

This is acceptable only under the MVP single-host assumption.

Future multi-worker implementation must provide one of:

- DurableTable fenced insert/upsert with server-rejected duplicate claim keys
- a narrow raw Durable Streams fenced append helper isolated like activity
  claims
- a different upstream primitive that gives compare-and-set semantics

Do not hide that future primitive inside a recreated `DurableConsumer`,
`ConsumerCheckpointStore`, `ConsumerSource`, or `DurableProjection`.

## MVP Rollout

### Existing Coverage: Sleep

Durable suspension via the workflow clock path is already proven end-to-end by
`DurableClock.sleep` + `clockWakeups` DurableTable + `fireDueWorkflowClocks`.
The product call sites that motivate durable-tools (Flamecast turn submission,
Flamecast agent webhook acceptance, substrate use-case-1 result-by-requestId)
all want a durable-row condition wait, not a duration wait. Therefore v0 does
not add a Firegrid-owned `sleep(durationMs)` facade. If a thin workflow-facing
sleep facade is wanted later, it lowers to `DurableClock.sleep` without a new
runtime worker or new row family.

### PR 1: Wait For

Goal: wait for a durable table condition with optional timeout, resolving an
existing workflow-engine deferred on a workflow execution that is already
suspended.

Deliver:

- wait intent + completion + subscription rows as a runtime-private DurableTable
- subscription router MVP attached through one `subscribeChanges(..., { includeInitialState: true })` per source
- AND-of-`fieldEquals` trigger DSL only
- timeout path via the existing `clockWakeups` table and `fireDueWorkflowClocks`
- per-dispatch status re-check on wait + subscription rows; no dynamic fiber
  registry
- runtime-host Layer that registers source DurableTable facades by typed handle

`wait_for` does not start new workflow executions. It resolves a workflow-engine
deferred owned by a workflow that is already running and awaiting. The narrow
fire-and-forget `executeByName` bridge described in §Workflow Dispatch is
deferred until a future trigger needs to *start* a workflow rather than resume
one.

### PR 2: Schedule Me

Goal: durable future self-prompt.

Deliver:

- schedule rows
- workflow-clock-driven scheduler (no separate `ToolTimersTable`)
- append to `RuntimeIngressTable.inputs`
- v0 single-host claim row around the ingress append

### Later: Spawn / Spawn All / Execute

Defer unless product direction requires them earlier.

Before implementing, decide the multi-worker claim story. For single-player
MVP, they can be prototyped with DurableTable claim rows, but the PR must state
the single-host assumption explicitly and include a follow-up for fenced claims.

## Effect Idiom Gates

Every PR that follows this SDD must satisfy:

- specs updated first per acai
- `it.effect` for new tests
- `Clock.currentTimeMillis` for timestamps
- `Match.value` / `Match.tag` for tagged-union branching
- no new `as Effect.Effect<...>` casts
- no `as unknown as Effect.Effect<...>` casts
- no polling loops when `DurableTable.subscribe` applies
- no new top-level package for composition or routing helpers
- no direct `@durable-streams/*` imports in `@firegrid/protocol`
- no recreation of deleted operators under new names

## Open Design Questions

1. Should the shared package eventually be renamed from `protocol` to a more
   accurate durable-contracts name? This is out of scope for tool MVP but worth
   tracking.
2. Should DurableTable grow a fenced-claim action, or should fenced claims stay
   a separate runtime primitive?

### Resolved

3. Does `wait_for` dispatch workflows, or does it only complete wait rows that
   an already-running workflow awaits?
   **Resolved:** `wait_for` only resolves a workflow-engine deferred on a
   workflow that is already running and awaiting. A fire-and-forget
   workflow-initiation bridge is deferred until a later trigger needs to start
   a workflow from an external row.
4. Can workflow clock wakeups fully cover `sleep` and `schedule_me`, or do we
   need a separate timers table for observability and operator control?
   **Resolved for v0:** the existing `clockWakeups` DurableTable +
   `fireDueWorkflowClocks` cover both. No separate `ToolTimersTable` is added.
5. What is the first product tool we actually need for the MVP?
   **Resolved:** `wait_for`. Visible product pressure: the Flamecast runtime
   handler polls every 250 ms for `turns.status == "submitted"` and
   `agentWebhooks.status == "accepted"`; the substrate SDD's use-case 1 awaits
   an external result row by `requestId`. All three lower to AND-of-scalar
   `fieldEquals` triggers.

## Review Bar

This SDD is aligned when it keeps the surface area small:

- DurableTable for durable state.
- Workflow for replay/suspension.
- Subscribe for reactive row changes.
- Explicit claim rows before side effects.
- Fenced claims only where multi-worker correctness is required.
- No new top-level coordination primitives. Composition is via existing Effect
  Layer, Service, and Stream operators.

Anything that introduces a generic consumer framework, a broad source
abstraction, a new top-level composition package, or a manual state-schema layer
is a regression.
