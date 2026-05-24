# wave-d-a-shape-b-input-identity-dedup — Wave D-A Shape (b) loop-body proof

**Verdict: GREEN.** All 6 hypothesis tests pass (`pnpm --filter @firegrid/tiny-firegrid exec vitest run test/wave-d-a-shape-b-input-identity-dedup/probe.test.ts`):

- **Test 1** (falsification baseline) — sequence-keyed gate invokes the
  handler but SKIPS the action: `invocations=1, dispatches=0, skips=1`.
  Confirms the current production bug at
  `subscribers/runtime-context/handler.ts:103-120` silently drops the first
  input on every fresh subscriber.
- **Test 2** (GREEN target) — identity-keyed dedup dispatches the first
  input: `invocations=1, dispatches=1, skips=0`;
  `state.processedInputIds === ["i-1"]`;
  `dispatchedActionIds === ["dispatched-input-i-1"]`.
- **Test 3** (restart idempotency) — subscriber restart redelivers the same
  input row; handler invokes twice but dispatches once
  (`invocations=2, dispatches=1, skips=1`); ledger stays at one action.
- **Test 4** (output sequence-cursor) — three sequential outputs all
  dispatched (`dispatches=3`); `lastProcessedOutputSequence` advances
  monotonically to `2`. Outputs DO carry a kernel-allocated sequence; this
  half of the dedup logic stays sequence-keyed and is correct.
- **Test 5** (interleaving) — inputs + output on one contextId all
  dispatched (`dispatches=3`); per-key mutex serializes; ledger set is
  `{ dispatched-input-i-1, dispatched-input-i-2, dispatched-output-ctx-1-0 }`.
- **Test 6** (cross-key concurrency) — two distinct contextIds dispatched
  in parallel; each context's `processedInputIds` holds its own input only;
  no per-key starvation.

Shape (b) is sound. CC1 can dispatch the prod cutover bundle in the CC2
deletion inventory under Shape (b).

## Why this sim exists

Wave D-A retires the body driver. The deletion-bearing dispatch inventory
(CC2, 2026-05-23) framed two shapes for input delivery during the cutover:

- **Shape (a)**: body kept; input mailbox dies; body switches input source
  to `tables/runtime-context-input-facts` before deletion. PARK entries on
  `host/internal/runtime-context-host-start.ts` do not shrink in D-A.
- **Shape (b)**: body retires in D-A; `handleRuntimeContextEvent` driven by
  `runKeyedDispatch` over `tables/runtime-context-input-facts`. Body lines
  `workflow-engine/workflows/runtime-context.ts:686-706` + the entire
  `host/internal/runtime-context-host-start.ts` + `RuntimeContextWorkflowRuntime`
  use sites delete with it. Satisfies the original W-D-A PARK note (10
  entries on `internal/runtime-context-host-start.ts` gone).

This sim validates **Shape (b)**.

## Falsification target — the bug Shape (b) must NOT inherit

The current Shape C handler (`packages/runtime/src/subscribers/runtime-context/handler.ts:103-120`)
uses a sequence-keyed dedup gate for inputs:

```ts
case "Input":
  return (event.event.sequence ?? -1) <= state.lastProcessedInputSequence
```

But `tables/runtime-context-input-facts.ts:53-57` deliberately drops the
sequence allocator — Shape C identity is `inputId === intent.intentId`, NOT
an allocated ordinal. The `RuntimeIngressInputRow.sequence` field is
`Schema.optional` and stays `undefined` on intent-derived rows.

Initial state: `lastProcessedInputSequence: -1`. First input arrives:

```
(event.event.sequence ?? -1) <= state.lastProcessedInputSequence
   ↓
(undefined ?? -1) <= -1
   ↓
-1 <= -1
   ↓
TRUE  →  eventAlreadyProcessed  →  INPUT IS DROPPED
```

The first input is silently dropped on every fresh subscriber. On restart,
because `lastProcessedInputSequence` stays at `-1` (no successful transition
ever advances it past `-1` if every input is dropped), **every input is
dropped forever**.

CC2's directive: **identity-keyed input dedup** — `processedInputIds: Set<string>`
in `RuntimeContextEventState`. The dedup check becomes membership test, not
ordinal comparison. Restart idempotency: durable `processedInputIds` reloaded
from the state table means re-delivered inputs are skipped, but first
delivery is never dropped.

## Shape (b) — what this sim proves

```
                            ┌──────────────────────────────────────────┐
inputs:  RuntimeContextInputFacts.forContext(contextId)
                            ↓
                            Stream<RuntimeIngressInputRow>
                            ↓ map: { _tag: "Input", event }
outputs: agentOutputs.forContext(contextId)
                            ↓
                            Stream<RuntimeAgentOutputObservation>
                            ↓ map: { _tag: "Output", event }
                                                       │
                            Stream.merge ◄─────────────┘
                            ↓ map: { key: contextId, event: RuntimeContextTargetEvent }
                            ↓
                  runKeyedDispatch({
                    source: merged,
                    handle: handleRuntimeContextEvent,  ← pure: load state, dedup,
                                                          transition, save state,
                                                          dispatch actions
                  })
                            ↓
                  per-key (contextId) FIFO serialization (per-key mutex);
                  cross-key concurrency.
                            └──────────────────────────────────────────┘
```

No `WorkflowEngine`, no `Workflow.make` body. The dispatcher's `R` adds no
workflow-engine requirement — Shape C purity per `keyed-dispatch.ts:18-25`.

## State shape (the load-bearing change)

```ts
// BEFORE (current Shape C):
type RuntimeContextEventState = {
  lastProcessedInputSequence: number   // -1 initial; never advances on
                                       //  intent-derived rows
  lastProcessedOutputSequence: number  // sequence-keyed, correct for outputs
  ...
}

// AFTER (Shape (b)):
type RuntimeContextEventState = {
  processedInputIds: ReadonlyArray<string>   // identity-keyed; load-bearing
  lastProcessedOutputSequence: number         // unchanged — outputs DO carry
                                              //   a kernel-allocated sequence
  ...
}
```

Outputs keep their sequence cursor: `RuntimeAgentOutputObservation` carries
a kernel-assigned `sequence` (the output stream HAS an ordinal allocator —
unlike intent-derived inputs). The asymmetry is intentional and matches the
substrate's actual contract.

## Test matrix

| # | Test | Pre-state | Stimulus | Pass criterion |
|---|------|-----------|----------|----------------|
| 1 | Sequence-keyed dedup drops first input (falsification baseline) | `lastProcessedInputSequence: -1` | One input row, `sequence: undefined` | Handler call count == 0 (FAIL on candidate shape) |
| 2 | Identity-keyed dedup delivers first input | `processedInputIds: []` | One input row, `inputId: "i-1"` | Handler call count == 1; `processedInputIds` == `["i-1"]` |
| 3 | Restart idempotency: same input redelivered | `processedInputIds: ["i-1"]` (reloaded from durable state) | Same `i-1` row redelivered | Handler call count == 0 (already processed) |
| 4 | Output sequence-cursor still works | `lastProcessedOutputSequence: 3` | Output with `sequence: 3` | Skipped; output with `sequence: 4` dispatched |
| 5 | Interleaving under per-key serialization | Empty state | Input `i-1`, Output `o-1` interleaved on one `contextId` | Both dispatched FIFO; per-key mutex holds |
| 6 | Cross-key concurrency | Two `contextId` keys | One input each, dispatched in parallel | Both handlers run; no per-key starvation |

## Hard constraints — all observed (target)

| Constraint | Shape (b) compliance |
|---|---|
| Identity-keyed input dedup (CC2 directive) | `processedInputIds: ReadonlyArray<string>`; membership test, not ordinal |
| Restart idempotency | Durable state row reloaded on every handler materialization; replayed input dropped on second delivery |
| No `WorkflowEngine` in subscriber `R` | `runKeyedDispatch` is Shape-neutral; `handleRuntimeContextEvent` has `RuntimeContextWorkflowSession + RuntimeToolUseExecutor` env only |
| No sequence-cursor input shape | `lastProcessedInputSequence` deleted from state; output cursor preserved (kernel-allocated sequence still exists) |
| `runKeyedDispatch({source: merge(inputs, outputs), handle})` is THE loop body | Subscriber composition is literally this; no parked workflow body |
| Per-key FIFO; cross-key concurrency | Per-key mutex via `makePerKeyMutex` (existing primitive) |

## Production mapping (what D-A retires)

| Sim concept | Production symbol | Retirement target in D-A |
|---|---|---|
| Identity-keyed input dedup | `RuntimeContextEventState.processedInputIds` (new field) | Replaces `lastProcessedInputSequence`; current sequence-keyed gate at `subscribers/runtime-context/handler.ts:103-120` rewrites |
| Input source | `RuntimeContextInputFacts.forContext(contextId)` | Already exists (`tables/runtime-context-input-facts.ts`); no new file |
| Loop body | `runKeyedDispatch({source, handle})` | Already exists (`subscribers/keyed-dispatch/keyed-dispatch.ts`); composition site lands in `composition/host-live.ts` |
| Handler | `handleRuntimeContextEvent` | Already exists (`subscribers/runtime-context/handler.ts`); inputs branch rewrites |
| Body (deletes) | `workflow-engine/workflows/runtime-context.ts:686-706` | `Workflow.make` + `Layer.scopedDiscard` block |
| Body driver (deletes) | `host/internal/runtime-context-host-start.ts` | Whole file (10 PARK entries) |
| Workflow runtime (deletes) | `kernel/runtime-context-workflow-runtime.ts` | Whole file (`RuntimeContextWorkflowRuntime` + Live + Service) |
| Mailbox (deletes) | `workflow-engine/runtime-input-deferred.ts` | Whole file (`RuntimeInputIntentDispatcher` + `appendRuntimeInputDeferred` + `awaitRuntimeInput` + `completedRuntimeInput`) |

Import-baseline shrinkage expected post-D-A under Shape (b):
- `host-sdk-no-runtime-input-intent-dispatcher-symbol`: 2 → 0
- `host-sdk-no-execute-runtime-context-workflow-symbol`: 4 → 2 (the
  `internal/runtime-context-host-start.ts` pair dies with the body driver;
  `agent-tool-host-live.ts` pair remains for D-B).
- `host-sdk-no-runtime-context-workflow-native-symbol`: 9 → 6 (internal/ trio out).
- `host-sdk-no-runtime-context-workflow-runtime-symbol`: 15 → 12 (internal/ trio out).
- Net: 46 → ~38 after D-A.

(Full zeros after D-E when `RuntimeContextWorkflowRuntime` deletes.)

## Sources

- `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
- `packages/runtime/src/subscribers/runtime-context/handler.ts:103-120`
  (`eventAlreadyProcessed` — the bug)
- `packages/runtime/src/events/runtime-context-state.ts:39-53`
  (`RuntimeContextEventStateSchema` — the state row this sim updates)
- `packages/runtime/src/tables/runtime-context-input-facts.ts:18-37`
  (`RuntimeContextInputFactsLive` — the typed source; explicitly drops
  sequence allocator)
- `packages/runtime/src/subscribers/keyed-dispatch/keyed-dispatch.ts:15-25`
  (`runKeyedDispatch` invariants — Shape-neutral loop primitive)
- CC2 dispatch inventory (2026-05-23) — Wave D-A deletion bundle + Shape
  (a)/(b) decision matrix.
