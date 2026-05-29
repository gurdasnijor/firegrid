# Shape C vs Shape D — When To Wrap A Subscriber In A Workflow

Audience: anyone adding a new subscriber or deciding whether an existing
subscriber needs `@effect/workflow` machinery.

Status: architectural reference. Invariants enforced by
`shape-d-workflow-admission` + `shape-d-tool-dispatch-mcp-entry` +
`runtime-context-fact-matrix` + several other tiny-firegrid simulations.

## The boundary in one sentence

> **RuntimeContext state is Shape C in every case;** Shape D admission
> is confined to **bounded execution bindings** — never a
> context-lifetime parked workflow body.

## The two roles

| | Shape C | Shape D |
|---|---|---|
| Owns | Durable state of a keyed entity (`contextId`-keyed). | A bounded execution binding that needs restart-safe machinery (`Activity` memoization, `DurableDeferred` race, `DurableClock` timer). |
| Looks like | Fresh handler per fact: `(state, fact) → newState`. Read row, apply pure transition, write next row, return. | A bounded `@effect/workflow` invocation **inside** event handling — not the state owner. |
| At-most-once via | Durable row identity (`insertOrGet`, key derived from domain identity). | `Workflow.idempotencyKey` over `WorkflowEngineTable`. |
| Async wait via | Durable completion keyed by domain id, reconstructed from a row on every entry. | `DurableDeferred` race within the bounded body. |
| Parked body | **Never.** No context-lifetime loop, no `Workflow.suspend` at the entity level. | **Only** a `DurableClock.sleep` timer the engine auto-recovers. |
| `R` channel mentions | `DurableTable`, `Context.Tag`s for capabilities, channels. **Never** `WorkflowEngine` / `WorkflowInstance` / `Activity`. | `WorkflowEngine` / `WorkflowInstance` / `Activity` are allowed and expected. |

## Decision table for the three subscribers

This table is the authoritative answer for the three target subscribers
(per the `shape-d-workflow-admission` simulation's empirical proof on
real `DurableStreamsWorkflowEngine` + `DurableTable` across crash
boundaries).

| Subscriber | Verdict | Load-bearing capability | Shape D binding (if any) |
|---|---|---|---|
| **Tool execution** | Shape C | Durable result identity (constraint C3) — `insertOrGet` on `tool/<toolUseId>`-keyed row. **Activity memoization is NOT load-bearing for at-most-once.** | Optional only: claimed-work / retry via `Activity` if you have non-idempotent side effects under concurrent execution. The MCP-entry tool path uses this — see `subscribers/tool-dispatch/README.md`. |
| **Wait routing** | Shape C | Durable completion (constraint C4) — reconstructed from the row alone, no in-memory waiter. `DurableDeferred`-as-mailbox is NOT load-bearing; it's bridge debt the constraints retire. | Timeout bound only — `DurableClock.sleep` for the timeout arm. The match arm is row-read, not `Activity`. |
| **Scheduled prompt** | **Shape D** | `DurableClock` — engine-recovered wall-clock wakeup. Scheduled facts have **no producer to resolve a completion**, so the Shape C durable-completion pattern doesn't apply. | `DurableClock.sleep` for the body's wake. The RuntimeContext state around it stays Shape C: the clock wakeup writes a fact that the keyed handler then processes. |

## Decision procedure for new subscribers

Walk these in order:

1. **What is the load-bearing correctness property?**
   - Durable result identity (at-most-once via row key) → Shape C.
   - Durable completion (reconstructable from a row) → Shape C.
   - Wall-clock recovery with no external producer → Shape D
     (`DurableClock`).
   - Non-idempotent side effect under concurrent workers needing
     claim-before-execute → either a Shape C claim row or a Shape D
     `Activity` claim. Equivalent; pick by team familiarity.

2. **Can the property be reconstructed from a row read?**
   - Yes → Shape C. The handler is a pure `(state, fact) → newState`
     reducer; state reloads on every entry.
   - No → the property needs in-memory state (a parked waiter) or
     wall-clock progress with no producer. → Shape D for the bounded
     binding only, **never** for the state.

3. **Is the parked body bounded by a single event handling
   invocation?**
   - Yes → Shape D admission is fine for that binding.
   - No (it would live for the lifetime of the context, with state
     held in memory across many events) → reject. This is the
     forbidden context-lifetime parked body. Decompose into durable
     rows + a Shape C handler.

4. **Does the subscriber's `R` channel need to name `WorkflowEngine` /
   `WorkflowInstance` / `Activity`?**
   - Shape C: dep-cruiser will reject this. Find the seam where the
     workflow concern bleeds in and decompose.
   - Shape D: expected. Declare it in the folder README.

## Falsifiers — when Shape C *isn't* enough

Each of these would flip a Shape C verdict to Shape D. They are
explicitly checked by `shape-d-workflow-admission`:

- A Shape C side-effect counter > 1 across deliveries of the same
  identity (durable row failed to fence).
- A wait that cannot be rebuilt from the row alone — requires a
  surviving in-memory waiter or engine re-arm.
- A scheduled fact that needs to fire at a future instant with no
  external producer to write a "due" trigger row.
- A Shape D Activity counter > 1 across reconstruction (Activity
  failed to memoize) — would mean even Shape D doesn't save you and
  the binding is structurally wrong.

## The bridge-debt patterns being retired

These are the patterns that look like Shape D but are actually bridge
debt — they should decompose into Shape C + a bounded Shape D binding,
not be preserved as long-lived workflow bodies:

| Pattern | Decomposition target |
|---|---|
| Per-sequence `DurableDeferred` input mailbox | Identity-keyed dedup in Shape C (`processedInputIds: Set<string>`); see `subscribers/keyed-dispatch/README.md` and the `wave-d-a-shape-b-input-identity-dedup` simulation. |
| Context-lifetime workflow body parked on `Workflow.suspend` (the "long-lived replaying body") | Keyed durable state container in `tables/`; fresh handler per fact reloads from the row. |
| Per-call `ToolCallWorkflow` for the in-handler stdio-jsonl tool path | Stays in `subscribers/runtime-context/handler.ts:runToolAndSend`; event-id-keyed idempotency. |
| `RuntimeContextWorkflowRuntime` bridge that wraps `WorkflowEngine.execute(...)` with extra plumbing | Direct `WorkflowEngine.execute(...)` from a runtime root composing `composition/host-live.ts`. See `shape-d-tool-dispatch-mcp-entry` for the deletion inventory. |

## Constraints alignment

The decision table above complies with the runtime design constraints
(`docs/cannon/architecture/runtime-design-constraints.md`):

| Constraint | Says | Shape C/D alignment |
|---|---|---|
| C1 keyed durable state | State container keyed by domain identity. | Shape C row in `tables/`. |
| C2 handler, not long-lived body | Handler is a `(state, fact) → newState` reducer. | Shape C handler reloads from the row. Shape D bindings are bounded invocations within event handling, not context-lifetime loops. |
| C3 durable result identity | At-most-once via row identity. | Tool execution Shape C — `insertOrGet` on `tool/<toolUseId>`. |
| C4 durable completion | Reconstructed from durable records, not a cross-event mailbox. | Wait routing Shape C — completion row read on every entry. |
| C5 no parked entity body | No context-lifetime parked body. | Shape D `DurableClock.sleep` is the only allowed parked body (engine-recovered). |
| C6 typed source observation | Sparse facts via point-addressed cursor. | Shape C reducer reads sparse transition facts only; never scans dense raw output. |
| C7 first-class schemas | Every row is an explicit `Schema.Struct`. | Both shapes — fact/state/identity/result schemas are first-class. |

## Ground Truth

- Simulation: `packages/tiny-firegrid/src/simulations/shape-d-workflow-admission/`
  — proves the three-subscriber decision table empirically on real
  `DurableStreamsWorkflowEngine` + `DurableTable` across crash boundaries.
- Simulation: `packages/tiny-firegrid/src/simulations/shape-d-tool-dispatch-mcp-entry/`
  — proves the MCP-entry tool path is at-most-once via
  `Workflow.idempotencyKey` alone (no separate result table needed).
- Simulation: `packages/tiny-firegrid/src/simulations/runtime-context-fact-matrix/`
  — the Shape C fact taxonomy this layers on.
- Simulation: `packages/tiny-firegrid/src/simulations/input-suspend-crash-recovery/`
  — proves a Shape D body parked on `Workflow.suspend` is **not**
  re-armed by reconstruction. The asymmetry that makes
  `DurableClock.sleep` the only safely-parked binding.
- Constraints: `docs/cannon/architecture/runtime-design-constraints.md`
  §C1–C7.
- Production Shape D subscribers:
  - `packages/runtime/src/subscribers/tool-dispatch/` — MCP-entry tool
    path (bounded `Activity` claim).
  - `packages/runtime/src/subscribers/scheduled-prompt/` — `DurableClock`
    timer for scheduled facts.
  - `packages/runtime/src/subscribers/wait-router/` — Shape C completion
    read + Shape D `DurableClock.sleep` timeout arm.
  - `packages/runtime/src/subscribers/runtime-control/` — host-control
    request workflows.
- Production Shape C subscribers:
  - `packages/runtime/src/subscribers/runtime-context/` — per-event
    RuntimeContext handler.
  - `packages/runtime/src/subscribers/runtime-context-session/` —
    codec-session command sink.

## Related Docs

- [RuntimeContext fact matrix](runtime-context-fact-matrix.md) — the
  Shape C subscriber's fact taxonomy.
- `packages/runtime/src/subscribers/tool-dispatch/README.md` — the
  Shape D tool dispatch path + locked-tool-surface gate.
- `packages/runtime/src/subscribers/keyed-dispatch/README.md` — the
  per-key subscriber dispatch primitive both shapes plug into.
