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

## Run it

```sh
pnpm --filter @firegrid/tiny-firegrid simulate:run unified-kernel-validation
```

Goes through the standard tiny-firegrid driver/host harness — same as
every other simulation in this folder (`kernel-owned-write-arm`,
`inv5-cross-agent-event-choreography`, etc.). Produces a `.simulate/
runs/<runId>/` directory with `trace.jsonl` (OTel spans), and prints a
GREEN verdict block to stdout with the result of every probe + every
structural invariant.

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
├── index.ts                 # defineSimulation
├── host.ts                  # exposes runtime probes to the driver
├── driver.ts                # runs probes + invariants + prints verdict
├── invariants.ts            # structural source-text checks
├── signal.ts                # SignalTable, awaitSignal, readSignalsFor,
│                            # sendSignal, recordSignal, recoverPendingSignals.
├── tables.ts                # UnifiedTable: ONLY families that hold
│                            # data the engine doesn't track —
│                            # permissions, schedules, webhookFacts,
│                            # peerEvents.
├── substrate.ts             # runGeneration: engine + tables + signal
│                            # recovery sweep. The "rebuild base."
├── probes/                  # runtime probes used by the driver
│   ├── _helpers.ts
│   ├── p1-signal.ts
│   ├── p2-session.ts
│   ├── p3-permission-tool.ts
│   ├── p4-scheduled-webhook-peer.ts
│   └── p5-end-to-end.ts
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
asserted by the structural-invariant checks in `invariants.ts`
(driven by the simulation, not by vitest tests):

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

The simulation drives 13 runtime probes through the real
`DurableStreamsWorkflowEngine` (via the tiny-firegrid host harness)
and 12 structural source-text invariants.

### Runtime probes

| probe | scenario |
| --- | --- |
| **P1A** | `sendSignal` wakes a parked body that returns the signal payload |
| **P1B** | crash between record and resume → recovery re-arms, body completes |
| **P1C** | bounded ownership — `DurableDeferred.await` body untouched by recovery |
| **P2A** | concurrent `Workflow.execute` for `(contextId, attempt)` collapse to ONE body; spawn Activity fires once |
| **P2B** | session input arrival via `sendSignal` after the body parks; recorder sees N sends |
| **P2C** | session crash recovery; gen-2 spawn Activity memoized from gen-1 |
| **P3A** | permission body parks via `awaitSignal`, returns signal-delivered decision |
| **P3B** | tool dispatch: same `toolUseId` across concurrent executes invokes executor ONCE |
| **P4A** | scheduled prompt fires after `DurableClock.sleep` delay |
| **P4B** | webhook ingest (valid HMAC) + observer wake via signal |
| **P4C** | webhook ingest (invalid HMAC) rejected; no fact written |
| **P4D** | peer event emit + observer wake via signal |
| **P5** | end-to-end product surface in one driver: spawn → prompt → tool → permission → permission-response → scheduled → webhook → peer → terminal |

### Structural collapse invariants

| id | invariant |
| --- | --- |
| I1 | no Shape C `eventAlreadyProcessed` / `lastProcessedInputSequence` |
| I2 | no `DurableDeferred` mailbox in subscriber bodies |
| I3 | no `appendRuntimeInputDeferred` / `RuntimeContextWorkflowRuntime` bridge |
| I4 | no parallel `connectors/` / `ConnectorAdapter` |
| I5 | every subscriber body parks via `awaitSignal` / `Workflow.suspend` / `DurableClock.sleep` |
| I6 | tool dispatch via `Workflow.idempotencyKey`, no result table |
| I7 | subscribers never call `engine.resume` / `Workflow.resume` directly |
| I8 | no `makePerKeyMutex` / `per-key-mutex` |
| I9 | no generic `WaitForFactWorkflow` / `SourceCollections` / `RuntimeObservationSourceNames` |
| I10 | no parallel `runs` / `outputs` / `toolResults` row families |
| I11 | no `appendInputIntent` / `ensureContext` / `nextInputSequence` |
| I12 | no row-level `status` flag on `permissions` / `schedules` |

## Prior art

The signal primitive matches the same shape that's standard in every
other durable-execution runtime:

- **Temporal** — `@SignalMethod` handlers, `WorkflowStub.signal(...)`
- **Restate** — `ctx.awakeable<T>()` + `ctx.promise<T>(name)`
- **Cadence** — signal channels
- **AWS Step Functions** — `waitForTaskToken` + `SendTaskSuccess`
- **Conductor** — `WAIT` tasks + `WorkflowClient.completeSignal`

`sendSignal` / `awaitSignal` / `recoverPendingSignals` are structurally
identical — a durable record of "fact arrived for execution X" plus a
recovery sweep that re-issues wake calls on reconstruction.

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
