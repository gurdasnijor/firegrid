# RuntimeContext Fact Matrix

Audience: anyone touching the per-event RuntimeContext subscriber,
adding a new fact kind, or debugging why a fact didn't advance state.

Status: architectural reference. Invariants enforced by the
`runtime-context-fact-matrix` firelab simulation (clean-room
proof). Production code: `packages/runtime/src/subscribers/runtime-context/`.

## The matrix

Every fact kind in the RuntimeContext model routes by a stable identity
to the same keyed durable subscriber state. State advances from these
facts only — never from the dense raw-output stream.

| Fact kind            | Routing key                                | Drives state? |
| -------------------- | ------------------------------------------ | ------------- |
| `input`              | `contextId`                                | yes (sparse) |
| `output_transition`  | `contextId` (+ opens tool/permission wait) | yes (sparse) |
| `permission_response`| `permission:<permissionRequestId>`         | yes (sparse) |
| `tool_result`        | `tool:<contextId>:<toolUseId>`             | yes (sparse) |
| `terminal`           | `contextId`                                | yes (sparse) |
| **raw `TextChunk` output** | separate `rawOutput` table           | **NO — UI/telemetry only** |

The dense raw-output stream is observable through the channel router
(`session.agent_output`) for UI / telemetry / parent→child observation,
but the per-key subscriber **never scans it**. Decoded "transition"
facts are the sparse subset that drives state.

## Load-bearing invariants

The matrix is correct when, and only when, all of these hold. They are
asserted by the simulation's verdict span on every clean-room run.

1. **State advances from sparse facts only.** The subscriber's fact-handler
   invocation count equals the distinct sparse fact count, independent of
   raw output volume. `denseOutputReads === 0` on the subscriber's code
   path.
2. **Output noise does not invoke the handler.** Appending raw output (any
   volume) produces zero additional `handler.apply_fact` invocations.
3. **Permission/tool correlation is by id, not arrival order.** If waits
   open `P1, T1, P2, T2` and resolutions arrive `T2, P1, T1, P2`, each
   resolution routes to its own id. A FIFO/positional matcher would
   resolve T1 on T2's arrival — that's a violation.
4. **Out-of-arrival-order rendezvous survives replay.** A response/result
   that arrives *before* its opening transition is stashed durably and
   matched by id when the transition arrives, across replay boundaries
   that reload state from the durable row (no in-memory waiter survives).
5. **No `DurableDeferred` in the correlation path.** Correlation is keyed
   durable state + point-addressed cursor reads. `DurableDeferred` is the
   forbidden cross-event mailbox pattern — its presence in this path
   means the state machine drifted into the workflow-engine substrate
   it's supposed to sit above.
6. **First-valid-terminal-wins.** A duplicate terminal fact (same
   `factKey`) converges via `insertOrGet` to one terminal row, status
   `complete`.
7. **Keyed routing isolation.** Facts for `contextId = B` never advance
   `contextId = A` state, and vice versa.

## Constraints derivation

The matrix is a consequence of the runtime design constraints:

| Constraint | Where | What it says |
|---|---|---|
| **C1** | `docs/cannon/architecture/runtime-design-constraints.md` | Keyed durable state container keyed by `contextId`. |
| **C2** | same | Handler is a `(state, fact) -> newState` reducer. No long-lived body — state reloads from the durable row on every processing entry. |
| **C4** | same | Async waits are durable completions keyed by domain id, reconstructed from durable records, *not* a cross-event mailbox, *not* arrival-order matched. |
| **C6** | same | Dense raw output is a separate typed source the subscriber never scans; the cursor is a point-addressed source coordinate, not a business id. |
| **C7** | same | Fact / state / identity / result schemas are first-class and versioned. |

When a new fact kind needs to land in this matrix, it must satisfy each
applicable constraint. New fact kinds that need cross-event correlation
(`DurableDeferred`, per-sequence mailbox, in-memory waiter) are not
acceptable — they're the failure mode the constraints exist to prevent.

## Shape C / Shape D seam

The matrix is **Shape C** (per-event keyed subscriber). It models the
*routing and correlation* of facts. It is silent on **how** a result was
produced.

| Layer | Owns | Where |
|---|---|---|
| Shape C | `tool_result` / `permission_response` arrival → correlation to the matching pending wait by domain id. Routing is **agnostic** to the producer. | `subscribers/runtime-context/` |
| Shape D | The execution machinery that *produces* and durably *records* a tool result row — claimed-work operator discipline, idempotency key, durable result identity. Writes the row Shape C delivers. | `subscribers/tool-dispatch/`, `subscribers/scheduled-prompt/`, `subscribers/runtime-control/` |

The two layers compose at a clean seam: the `tool_result` fact in the
matrix is exactly the point where Shape D's output plugs in. The seam is
load-bearing — adding a workflow-engine concern (`Activity.make`,
`Workflow.suspend`, `DurableDeferred`, `DurableClock`) to a Shape C path
is the drift to watch for. Dep-cruiser enforces the structural ban on
Shape C subscribers naming `WorkflowEngine`/`WorkflowInstance`/`Activity`
in their `R` channel.

## How a fact actually flows

```txt
codec emit (stdio-jsonl or ACP)
  → events/agent-output.ts: typed AgentOutputEvent
    → tables/runtime-output.ts: durable row, sequence-keyed
      → transforms/runtime-context-transition.ts: row → sparse transition fact
        → subscribers/runtime-context/handler.ts: (state, fact) → newState
          → tables/runtime-context-state.ts: state row, contextId-keyed
            → channels/session-agent-output: ingress stream for observers
```

The handler is invoked once per sparse transition fact, with state
reloaded from `tables/runtime-context-state.ts` on every entry. The
dense raw-output table is observable on the same `session.agent_output`
channel but does **not** invoke the handler.

## Adding a new fact kind

1. **Pick the routing key.** Use `contextId` for context-keyed facts; a
   compound `<scope>:<contextId>:<id>` key for per-binding correlation
   (`tool:<contextId>:<toolUseId>`, `permission:<permissionRequestId>`).
   The key must be reconstructible from the fact alone, without
   ambient state.
2. **Declare it as `sparse`.** If it is dense (UI/telemetry-shaped),
   route it to a separate observation table; do NOT add it to the
   handler's input.
3. **Schema-version the fact.** Add a tagged variant under
   `events/` and a `Schema.parse` in the transition transform.
4. **Update the matrix in this doc.** New row in the table above.
5. **Add a simulation invariant.** Extend the
   `runtime-context-fact-matrix` sim with a positive test for the new
   routing and a negative test for the cases that would falsify it
   (positional matching, dense scanning, cross-key advancement).

## Falsification surfaces

The matrix is broken when any of these happen. The simulation watches
for each.

| Symptom | Means |
|---|---|
| `factHandlerInvocations` tracks `rawOutputRows` | The subscriber is scanning dense output. Sparse-only is false. |
| Resolution's `correlationId` differs from both opening-transition id and resolving-fact id | Routing is positional, not by id. |
| `resolve_first` matches lost across replay | State depends on an in-memory waiter (C4 reconstruction violated). |
| CTX-B fact advancing CTX-A state | Routing is not keyed by `contextId`. |
| `DurableDeferred` / per-sequence mailbox needed for matching | The cross-event mailbox crept back. |

## Ground Truth

- Simulation:
  `packages/firelab/src/simulations/runtime-context-fact-matrix/`
- Run: `pnpm --filter @firegrid/firelab exec tsx src/index.ts run runtime-context-fact-matrix`
- Verdict span: `firegrid.tiny_fact_matrix.verdict` (attribute names match
  the invariants above)
- Constraints doc: `docs/cannon/architecture/runtime-design-constraints.md`
- Production handler:
  `packages/runtime/src/subscribers/runtime-context/handler.ts`
- State store: `packages/runtime/src/tables/runtime-context-state.ts`
- Transition transform:
  `packages/runtime/src/transforms/runtime-context-transition.ts`
- Output table: `packages/runtime/src/tables/runtime-output.ts`
- Sparse-vs-dense cursor walker (production):
  `packages/runtime/test/tables/runtime-context-state.sparse.test.ts`
- Finding: `packages/firelab/src/simulations/runtime-context-fact-matrix/FINDING.md`

## Do Not

- **Do not** add a dense fact to the matrix. If the data is high-volume
  per turn (TextChunk-shaped), route it to a separate observation source.
- **Do not** correlate by arrival order. A new wait kind that
  resolves "next pending" instead of "matching id" is a regression.
- **Do not** introduce `DurableDeferred` into a Shape C path. If you
  think you need to, that's the signal the responsibility is Shape D.
- **Do not** add `WorkflowEngine` / `WorkflowInstance` / `Activity` to
  a runtime-context subscriber's `R` channel. Dep-cruiser will reject
  it; the structural ban exists because the matrix model assumes the
  handler is a pure reducer, not a workflow body.
