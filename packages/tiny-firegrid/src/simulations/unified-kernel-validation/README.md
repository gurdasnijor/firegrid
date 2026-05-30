# unified-kernel-validation

Status: **clean-room rebuild base**. The entire firegrid product
surface (sessions, prompts, tools, permissions, scheduled prompts,
webhooks, peer events) is delivered from three primitives —
`@effect/workflow`, `effect-durable-operators`'s `DurableTable`, and
the durable **signal** primitive defined locally — and exposed
through the standard `@firegrid/protocol/channels` abstraction.

Take this folder and you can delete the production Shape C /
DurableDeferred-based subscriber surface and rebuild on top.

## Run it

```sh
pnpm --filter @firegrid/tiny-firegrid simulate:run unified-kernel-validation
```

Same harness as every other tiny-firegrid simulation. Produces a
`.simulate/runs/<runId>/` directory with `trace.jsonl` (OTel spans)
and prints a GREEN verdict block to stdout.

## What the driver does

The driver consumes the `UnifiedChannels` service and walks five
scenarios through the channel bindings:

| scenario | what it exercises |
| --- | --- |
| **end-to-end** | session start → prompt input → tool dispatch → permission roundtrip → permission-response input → scheduled prompt → webhook ingest + observer → peer event emit + observer → terminal input → session completes |
| **crash recovery** | gen-1 starts a session and records a terminal signal without resuming; gen-2 rebuilds and awaits the session terminal — the only path to success is signal recovery firing |
| **tool idempotency** | concurrent `toolDispatch` calls with the same `toolUseId` invoke the executor once; both return the same memoized result |
| **webhook bad HMAC** | `webhookIngest` with an invalid signature returns `_tag: "Rejected"` |
| **bounded ownership** | a `DurableDeferred.await`-only workflow stays parked across signal recovery — the recovery sweep only walks its own signal log |

Every observation in the driver comes through a channel response or
the channel's host-side helpers — the driver doesn't reach into the
substrate.

## The product surface

`channels.ts` defines a `UnifiedChannels` service holding fifteen
`CallableChannel`s, one per product operation:

```
sessionStart, sessionSendInput, sessionAwaitTerminal,
permissionOpen, permissionReadRequest, permissionRespond, permissionAwaitDecision,
toolDispatch,
schedulePrompt,
webhookIngest, webhookObserverStart, webhookObserverAwait,
peerEmit, peerObserverStart, peerObserverAwait,
```

Each binding routes into the signal-based subscriber workflow below
it. Driver code looks like:

```ts
const session = yield* channels.sessionStart.binding.call({ contextId, attempt })
yield* channels.sessionSendInput.binding.call({ session, inputId, kind, payloadJson })
const decision = yield* channels.permissionAwaitDecision.binding.call(permHandle)
```

No custom client interface. No reinvention. The channel abstraction
IS the public product surface.

## The signal primitive

`signal.ts` defines the standard durable-execution capability that
every other workflow runtime ships natively (Temporal Signals,
Restate Awakeables + Durable Promises, AWS Step Functions task
tokens, Cadence Signals, Conductor WAIT tasks). The Effect workflow
engine doesn't expose it directly, so we compose it here as a thin
durable layer over the engine.

```ts
// In a workflow body — park until a signal arrives by name
const value = yield* awaitSignal<T>({ name: "permission-decision" })

// In a workflow body that consumes a stream of signals
const rows = yield* readSignalsFor(signals, executionId)

// From a producer — atomic record + (optional) row write + resume
yield* sendSignal({ signals, workflow, executionId, name, value, ... })

// On engine reconstruction — re-arm executions whose signals are
// recorded but haven't been processed
yield* recoverPendingSignals({ signals, engineTable, catalog })
```

## Layout

```
unified-kernel-validation/
├── README.md
├── index.ts                 # defineSimulation
├── host.ts                  # exposes 5 scenarios to the driver via latch
├── driver.ts                # runs scenarios + invariants + prints verdict
├── scenarios.ts             # the five channel-driven scenarios
├── channels.ts              # UnifiedChannels service (15 channels)
├── invariants.ts            # 12 structural source-text checks
├── signal.ts                # SignalTable, awaitSignal, readSignalsFor,
│                            # sendSignal, recordSignal, recoverPendingSignals
├── tables.ts                # UnifiedTable: ONLY families the engine
│                            # doesn't track — permissions, schedules,
│                            # webhookFacts, peerEvents.
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

The unified shape retires these Shape C-era concepts; their absence
is asserted by the structural-invariant checks in `invariants.ts`:

- **`runs` / `outputs` / `toolResults` row families** — engine
  `executions.finalResult` + Activity memoization already track these.
- **`inputs` / `inputIds` / `contexts` row families** — session input
  intents ARE signals targeting the session execution.
- **`input-append.ts` host helper** — producers just call `sendSignal`
  directly (via the `sessionSendInput` channel).
- **`status` columns on permissions / schedules** — both duplicated
  engine execution lifecycle.
- **`per-key-mutex.ts`** — `Workflow.idempotencyKey` + the engine's
  single-fiber execution model already serializes per logical key.
- **Generic `WaitForFactWorkflow`** — string-dispatch over a fact-table
  name reconstructs the retired `SourceCollections` /
  `RuntimeObservationSourceNames` registry. Specialized per-family
  observers (the webhook + peer observers) are the unified shape.

## Prior art

The signal primitive matches the same shape that's standard in every
other durable-execution runtime:

- **Temporal** — `@SignalMethod` handlers, `WorkflowStub.signal(...)`
- **Restate** — `ctx.awakeable<T>()` + `ctx.promise<T>(name)`
- **Cadence** — signal channels
- **AWS Step Functions** — `waitForTaskToken` + `SendTaskSuccess`
- **Conductor** — `WAIT` tasks + `WorkflowClient.completeSignal`

## What this is NOT

- **Not a production cutover.** Production runtime still uses the
  retiring DurableDeferred mailbox + Shape C handlers.
- **Not a complete substrate.** The signal primitive covers durable
  suspend recovery and per-key serialization. Output observation,
  channel routing, telemetry, transport adapters — all unchanged.

## Related

- `docs/architecture/unified-subscriber-kernel.md` — conceptual
  collapse story this simulation validates.
- `docs/cannon/architecture/kernel-owned-write-arm.md` — cannon
  decision the signal primitive implements.
