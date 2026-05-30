# unified-kernel-validation

Status: **comprehensive simulation** validating the conceptual collapse
documented in `docs/architecture/unified-subscriber-kernel.md`. The
simulation IS the empirical proof that the entire product surface can be
delivered from three primitives — `Channel` + `DurableTable` +
`Workflow` (with the kernel-owned write+arm controller).

Also serves as a **minimal rebuild base**: every product capability
(spawn / input / tool / permission / scheduled / webhook / peer event /
terminal) is implemented end-to-end against the substrate in this
folder, with no production runtime imports beyond `effect`,
`effect-durable-operators`, `@effect/workflow`, and the runtime engine
adapter.

## Layout

```
unified-kernel-validation/
├── README.md
├── kernel.ts                # KernelCommandTable, kernelWriteArm,
│                            # kernelRecordAndWrite, replayPendingWriteArm.
│                            # The "missing engine capability."
├── tables.ts                # UnifiedTable namespace: one DurableTable
│                            # with all row families (contexts, inputs,
│                            # inputIds, outputs, runs, toolResults,
│                            # permissions, schedules, webhookFacts,
│                            # peerEvents). Key helpers per family.
├── input-append.ts          # appendInputIntent: atomic (contexts,
│                            # inputs, inputIds) write with idempotency
│                            # index + sequence allocation.
├── substrate.ts             # runGeneration: per-generation engine +
│                            # tables + replay sweep. The "rebuild base."
└── subscribers/
    ├── runtime-context.ts                  # The canonical session lifecycle
    │                                       # workflow body: spawn (Activity-
    │                                       # memoized) + cursor loop + terminal.
    ├── permission-and-tool.ts              # PermissionRoundtripWorkflow,
    │                                       # ToolDispatchWorkflow.
    └── scheduled-webhook-peer.ts           # ScheduledPromptWorkflow (DurableClock),
                                            # verifyAndIngestWebhook (host helper),
                                            # WebhookFactObserverWorkflow,
                                            # emitPeerEvent (host helper),
                                            # PeerEventObserverWorkflow.
```

There is deliberately NO `per-key-mutex.ts` and NO generic
`WaitForFactWorkflow`. Both are Shape C / SourceCollections-era
concepts that the unified kernel retires:

- **Per-key serialization** is given by `Workflow.idempotencyKey` (one
  execution per logical key) + the engine's single-fiber execution
  model. No subscriber-runtime mutex needed.
- **Fact observation** is per-family specialized workflows
  (`WebhookFactObserverWorkflow`, `PeerEventObserverWorkflow`,
  `PermissionRoundtripWorkflow`'s embedded observer). A generic
  "wait_for any fact" workflow with a string `factTable` discriminator
  recreates the retired `SourceCollections` /
  `RuntimeObservationSourceNames` registry pattern.

The P5 collapse invariants assert structural absence of both patterns.

## What's proven

Each phase is a self-contained vitest file under
`packages/tiny-firegrid/test/unified-kernel-validation/`. **22 tests
total, all green.**

### P1 — kernel + substrate (3 tests)

1. Happy path: `kernelWriteArm` wakes a parked `Workflow.suspend` body.
2. Crash between write and arm: `replayPendingWriteArm` re-arms on
   reconstruction. Body completes without test re-drive.
3. Bounded ownership: a `DurableDeferred.await`-only workflow with NO
   kernel fact for it stays parked across replay. Proves the
   `tf-12q9` generic-sweep failure mode does NOT recur (kernel only
   recovers what it owns).

### P2 — RuntimeContext session as workflow body (3 tests)

The most load-bearing production subscriber, generalized as a single
workflow body.

1. Single execution + memoized spawn: concurrent
   `Workflow.execute` for the same `(contextId, attempt)` admit ONE
   body. Spawns = 1, sends = N. Kills the production TOCTOU that
   spawned double `claude-agent-acp` PIDs.
2. Input arrival via `kernelWriteArm`: body parks before inputs
   exist; subsequent `appendAndArm` calls wake it; outputs land in
   order; terminal completes.
3. Crash recovery: gen-1 appends terminal input + records kernel fact
   WITHOUT arming, drops generation. Gen-2 replay re-arms, body
   completes, `runs.exited` lands. No test re-drive.

### P3 — permission + tool (2 tests)

1. `PermissionRoundtripWorkflow` parks until host upserts row to
   `responded`; returns decision.
2. `ToolDispatchWorkflow` idempotency: same toolUseId across two
   concurrent executes invokes the executor count = 1; both return
   identical resultJson. At-most-once via
   `Workflow.idempotencyKey` over `WorkflowEngineTable` — no separate
   `runtime-tool-result` table needed.

### P4 — scheduled + external adapters (4 tests)

1. `ScheduledPromptWorkflow` fires after wall-clock delay;
   `schedules` row settles `fired`. (The one Shape D admission that
   survives in the unified model — and the only place
   `DurableClock.sleep` is used in the simulation.)
2. `verifyAndIngestWebhook`: signed payload → row written → waiting
   `WebhookFactObserverWorkflow` wakes via kernel arm and returns the
   matched row.
3. `verifyAndIngestWebhook` rejects invalid HMAC; no fact written.
4. `emitPeerEvent` + waiting `PeerEventObserverWorkflow` wakes via
   kernel arm. Same shape as webhook — the producer side differs, the
   observer is specialized to its fact family.

### P5 — end-to-end + collapse invariants (10 tests)

1. **End-to-end driver** walks the complete product surface in one
   test: spawn → prompt input → tool dispatch (Shape D MCP-entry) →
   permission roundtrip → permission-response input → scheduled
   prompt → webhook ingest → peer event emit → terminal input →
   session completes. Asserts every fact landed durably; the
   recording adapter snapshot proves spawn = 1.

2-10. **Collapse-invariant assertions** read the simulation source
   (with comments stripped) and assert structural absence of:
   - Shape C `eventAlreadyProcessed` / `lastProcessedInputSequence`
     gates.
   - `DurableDeferred` mailbox in subscriber bodies.
   - `appendRuntimeInputDeferred` / `RuntimeContextWorkflowRuntime`
     bridge symbols.
   - Parallel `connectors/` / `ConnectorAdapter` primitive.
   - Subscriber bodies that don't park via `Workflow.suspend` or
     `DurableClock.sleep`.
   - Tool dispatch without `Workflow.idempotencyKey: (p) => p.toolUseId`.
   - Subscribers calling `engine.resume` / `Workflow.resume` directly
     (the kernel is the only wake authority).
   - **`makePerKeyMutex` / `per-key-mutex`** — Shape C subscriber-
     runtime artifact; the workflow context already serializes per
     idempotency key.
   - **`WaitForFactWorkflow` / `SourceCollections` /
     `RuntimeObservationSourceNames`** — string-dispatch over a fact
     table reconstructs the retired registry pattern. Specialized
     per-family observers are the unified shape.

## Run it

```sh
pnpm --filter @firegrid/tiny-firegrid test test/unified-kernel-validation/
```

Or individual phases:

```sh
pnpm --filter @firegrid/tiny-firegrid test test/unified-kernel-validation/p1-kernel.test.ts
pnpm --filter @firegrid/tiny-firegrid test test/unified-kernel-validation/p2-runtime-context-session.test.ts
pnpm --filter @firegrid/tiny-firegrid test test/unified-kernel-validation/p3-permission-tool.test.ts
pnpm --filter @firegrid/tiny-firegrid test test/unified-kernel-validation/p4-scheduled-webhook-peer.test.ts
pnpm --filter @firegrid/tiny-firegrid test test/unified-kernel-validation/p5-end-to-end.test.ts
```

## What this is NOT

- **Not a production cutover.** Production runtime still uses the
  retiring DurableDeferred mailbox + Shape C handlers. The migration
  beads (`tf-c9r9`, `tf-vrz6`, `tf-jpcg`, `tf-vfq9`) own the actual
  production cutover.
- **Not a runtime drop-in.** The simulation deliberately recapitulates
  the substrate so the rebuild base is self-contained. Production
  would compose against the existing `@firegrid/runtime` channels +
  tables surfaces.
- **Not a complete substrate.** The kernel covers durable suspend
  recovery and per-key serialization. Output observation, channel
  routing, telemetry, transport adapters — all unchanged from the
  production architecture.

## Related

- `docs/architecture/unified-subscriber-kernel.md` — the conceptual
  collapse story this simulation validates.
- `docs/architecture/shape-c-vs-shape-d.md` — the transitional
  distinction this simulation makes irrelevant.
- `docs/cannon/architecture/kernel-owned-write-arm.md` — the cannon
  decision the kernel primitive implements.
- Source sims this generalizes from:
  - `kernel-owned-write-arm/` (kernel primitive)
  - `runtime-context-session-workflow/` (session subscriber)
  - `tiny-input-append-wakeup/` (atomic input append)
  - `inv2-waitforworkflow-layered/` (wait pattern)
  - `linear-webhook-cookbook-composition/` (webhook channel)
  - `inv5-cross-agent-event-choreography/` (peer event pattern)
