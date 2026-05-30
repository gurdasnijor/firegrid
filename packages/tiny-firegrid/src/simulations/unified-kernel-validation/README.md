# unified-kernel-validation

Status: **clean-room rebuild base**. Every product capability (spawn /
input / tool / permission / scheduled / webhook / peer event /
terminal) is implemented end-to-end against three primitives —
`@effect/workflow`, `effect-durable-operators`'s `DurableTable`, and
the durable **signal** primitive defined in this folder
(`signal.ts`). The only external dependency is the durable
workflow-engine adapter at
`@firegrid/runtime/engine/durable-streams-workflow-engine` (reusable
infrastructure, not what's being rebuilt).

Take this folder and you can delete the production Shape C /
DurableDeferred-based subscriber surface and rebuild on top of these
primitives.

## The signal primitive

`signal.ts` defines the standard durable-execution capability that
every other workflow runtime ships natively (Temporal Signals, Restate
Durable Promises, AWS Step Functions task tokens, Cadence Signals,
Conductor WAIT tasks). The Effect workflow engine doesn't expose it
directly, so we compose it here as a thin durable layer over the
engine.

### API

```ts
// In a workflow body — park until a signal arrives by name
const value = yield* awaitSignal<T>({ name: "permission-decision" })

// In a workflow body that consumes a stream of signals
const rows = yield* readSignalsFor(signals, executionId)
// ...iterate `rows` in recordedAt order; suspend when caught up

// From a producer — atomic record + (optional) row write + resume
yield* sendSignal({
  signals, workflow, executionId, name, value,
  write: () => Effect.void, serializeValue: JSON.stringify,
})

// On engine reconstruction — re-arm executions whose signals are
// recorded but haven't been processed (no finalResult yet)
yield* recoverPendingSignals({ signals, engineTable, catalog })
```

### Durability contract

`sendSignal` is atomic in the following sense: the signal row is
written FIRST, then the optional companion row write, then
`engine.resume(executionId)`. If any step crashes:

- Row not written → next `sendSignal` retry writes it (`insertOrGet`
  is idempotent).
- Row written, companion row not written → recovery re-runs the
  rewriter if provided (rare; only needed for delegated row writes).
- Row + companion written, resume not called → recovery sees the
  pending signal and re-issues `engine.resume` on the next generation.

`recoverPendingSignals` runs once on engine reconstruction. Bounded
ownership: it only resumes workflows that exist in the catalog AND
have a pending signal. Workflows parked on `DurableDeferred.await`
(no signal for them) are not touched.

## Layout

```
unified-kernel-validation/
├── README.md
├── signal.ts                # SignalTable, awaitSignal, readSignalsFor,
│                            # sendSignal, recordSignal, recoverPendingSignals.
│                            # The durable-signal primitive.
├── tables.ts                # UnifiedTable: ONLY families that hold
│                            # data the engine doesn't track —
│                            # permissions, schedules, webhookFacts,
│                            # peerEvents.
├── substrate.ts             # runGeneration: engine + tables + signal
│                            # recovery sweep. The "rebuild base."
└── subscribers/
    ├── runtime-context.ts                  # Session lifecycle.
    ├── permission-and-tool.ts              # PermissionRoundtripWorkflow,
    │                                       # ToolDispatchWorkflow.
    └── scheduled-webhook-peer.ts           # ScheduledPromptWorkflow,
                                            # webhook + peer helpers,
                                            # specialized observers.
```

### What's NOT in this tree

The unified shape retires these Shape C-era concepts; their absence is
asserted by the collapse-invariant suite in `p5-end-to-end.test.ts`:

- **`runs` / `outputs` / `toolResults` row families** — engine
  `executions.finalResult` + Activity memoization already track these.
- **`inputs` / `inputIds` / `contexts` row families** — session input
  intents ARE signals targeting the session execution. The signal's
  `payloadJson` carries the input envelope; the body iterates its own
  signals by `recordedAt` order.
- **`input-append.ts` host helper** — no producer-side allocator that
  mutates a `contexts.nextInputSequence` row. Producers just call
  `sendSignal` directly.
- **`status` columns on permissions / schedules** — both duplicated
  engine execution lifecycle. The signal payload IS the permission
  decision; engine clock recovery + `executions.finalResult` IS the
  schedule firing evidence.
- **`per-key-mutex.ts`** — `Workflow.idempotencyKey` + the engine's
  single-fiber execution model already serializes per logical key.
- **Generic `WaitForFactWorkflow`** — string-dispatch over a fact-table
  name reconstructs the retired `SourceCollections` /
  `RuntimeObservationSourceNames` registry. Specialized per-family
  observers are the unified shape.

## What's proven

Each phase is a self-contained vitest file under
`packages/tiny-firegrid/test/unified-kernel-validation/`. **25 tests
total, all green.**

### P1 — signal + substrate (3 tests)

1. Happy path: `sendSignal` records the signal (with payload), wakes
   the parked body. The body reads its own signal via `awaitSignal`
   and returns the payload.
2. Crash between record and resume: `recoverPendingSignals` re-arms
   on reconstruction. Body completes without test re-drive.
3. Bounded ownership: a `DurableDeferred.await`-only workflow with NO
   signal for it stays parked across recovery.

### P2 — RuntimeContext session as workflow body (3 tests)

The most load-bearing production subscriber, generalized as a single
workflow body. The body iterates its own signals as the input log —
no parallel `inputs` table.

1. Single execution + memoized spawn: concurrent `Workflow.execute`
   for the same `(contextId, attempt)` admit ONE body. Spawns = 1,
   sends = N.
2. Input arrival via `sendSignal`: body parks before signals exist;
   subsequent signal sends wake it; recorder sees each send exactly
   once (Activity-memoized).
3. Crash recovery: gen-1 records terminal signal WITHOUT resuming,
   drops generation. Gen-2 recovery re-arms, body completes,
   `executions.finalResult` lands. Spawn Activity is memoized from
   gen-1, so the fresh gen-2 recorder sees no spawn side effect.

### P3 — permission + tool (2 tests)

1. `PermissionRoundtripWorkflow` writes an open-request row (no
   `status` flag), parks via `awaitSignal`, returns the decision
   delivered in the signal payload.
2. `ToolDispatchWorkflow` idempotency: same toolUseId across two
   concurrent executes invokes the executor count = 1; both return
   identical resultJson. At-most-once via `Workflow.idempotencyKey` +
   Activity memoization — no `toolResults` table.

### P4 — scheduled + external adapters (4 tests)

1. `ScheduledPromptWorkflow` fires after wall-clock delay; the
   commitment row is present, the body returns `firedAt`. No `status`
   column.
2. `verifyAndIngestWebhook`: signed payload → row written → waiting
   observer wakes via signal send and returns the matched row.
3. `verifyAndIngestWebhook` rejects invalid HMAC; no fact written.
4. `emitPeerEvent` + waiting observer wakes via signal send.

### P5 — end-to-end + collapse invariants (13 tests)

1. **End-to-end driver** walks the complete product surface: spawn →
   prompt input → tool dispatch → permission roundtrip →
   permission-response input → scheduled prompt → webhook ingest →
   peer event emit → terminal input → session completes.

2-13. **Collapse-invariant assertions** read the simulation source
   (with comments stripped) and assert structural absence of:
   - Shape C `eventAlreadyProcessed` / `lastProcessedInputSequence`
     gates.
   - `DurableDeferred` mailbox in subscriber bodies.
   - `appendRuntimeInputDeferred` / `RuntimeContextWorkflowRuntime`
     bridge symbols.
   - Parallel `connectors/` / `ConnectorAdapter` primitive.
   - Subscriber bodies that don't park via `awaitSignal` /
     `Workflow.suspend` / `DurableClock.sleep`.
   - Tool dispatch without `Workflow.idempotencyKey: (p) => p.toolUseId`.
   - Subscribers calling `engine.resume` / `Workflow.resume` directly
     (the signal primitive is the only wake authority).
   - **`makePerKeyMutex` / `per-key-mutex`** — Shape C subscriber-
     runtime artifact.
   - **`WaitForFactWorkflow` / `SourceCollections` /
     `RuntimeObservationSourceNames`** — string-dispatch registry.
   - **Parallel runtime-state tables** — `runs` / `outputs` /
     `toolResults` row families duplicate engine state.
   - **Shape C atomic-allocator helpers** — `appendInputIntent` /
     `ensureContext` / `nextInputSequence` reconstruct the host-side
     producer allocator.
   - **Row-level lifecycle status flags** — `permissions.status` /
     `schedules.status` duplicate engine execution lifecycle.

## Run it

```sh
pnpm --filter @firegrid/tiny-firegrid test test/unified-kernel-validation/
```

## Prior art

The signal primitive matches the same shape that's standard in every
other durable-execution runtime:

- **Temporal** — `@SignalMethod` handlers, `WorkflowStub.signal(...)`
- **Restate** — `ctx.awakeable<T>()` + `ctx.promise<T>(name)`
- **Cadence** — signal channels
- **AWS Step Functions** — `waitForTaskToken` + `SendTaskSuccess`
- **Conductor** — `WAIT` tasks + `WorkflowClient.completeSignal`

What the simulation calls `sendSignal` / `awaitSignal` /
`recoverPendingSignals` is structurally identical to these — a
durable record of "fact arrived for execution X" plus a recovery
sweep that re-issues wake calls on reconstruction.

## What this is NOT

- **Not a production cutover.** Production runtime still uses the
  retiring DurableDeferred mailbox + Shape C handlers. The migration
  beads (`tf-c9r9`, `tf-vrz6`, `tf-jpcg`, `tf-vfq9`) own the actual
  cutover.
- **Not a complete substrate.** The signal primitive covers durable
  suspend recovery and per-key serialization. Output observation,
  channel routing, telemetry, transport adapters — all unchanged.

## Related

- `docs/architecture/unified-subscriber-kernel.md` — conceptual
  collapse story this simulation validates.
- `docs/cannon/architecture/kernel-owned-write-arm.md` — cannon
  decision the signal primitive implements.
