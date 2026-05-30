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
│                            # kernelRecordAndWrite, readCommandsFor,
│                            # replayPendingWriteArm.
│                            # The "missing engine capability."
├── tables.ts                # UnifiedTable namespace: ONLY the row
│                            # families that hold data the engine
│                            # doesn't already track — permissions
│                            # (UI-renderable open request),
│                            # schedules (UI-renderable commitment),
│                            # webhookFacts, peerEvents.
├── substrate.ts             # runGeneration: per-generation engine +
│                            # tables + replay sweep. The "rebuild base."
└── subscribers/
    ├── runtime-context.ts                  # Session lifecycle: spawn
    │                                       # (Activity-memoized) + body
    │                                       # iterates its own kernel
    │                                       # commands + terminal return.
    ├── permission-and-tool.ts              # PermissionRoundtripWorkflow
    │                                       # (decision flows via kernel
    │                                       # command payload),
    │                                       # ToolDispatchWorkflow
    │                                       # (Activity memoization +
    │                                       # idempotencyKey is the
    │                                       # durable record).
    └── scheduled-webhook-peer.ts           # ScheduledPromptWorkflow
                                            # (DurableClock), webhook +
                                            # peer host helpers,
                                            # specialized observers.
```

### What's NOT in this tree

The unified kernel retires these Shape C-era concepts; their absence is
asserted by the collapse-invariant suite in `p5-end-to-end.test.ts`:

- **`runs` / `outputs` / `toolResults` row families** — the engine's
  `executions.finalResult` + Activity memoization carries each one's
  load. Adding them reconstructs the "subscriber tracks its own
  lifecycle" pattern.
- **`inputs` / `inputIds` / `contexts` row families** — session input
  intents ARE kernel commands targeting the session execution. The
  command's `inputValueJson` carries the input payload. The session
  body iterates its own commands by `recordedAt` order.
- **`input-append.ts` host helper** — no producer-side allocator that
  mutates a `contexts.nextInputSequence` row. Producers just call
  `kernelWriteArm` directly.
- **`status` columns on permissions / schedules** — both duplicated
  engine execution lifecycle. The kernel command payload IS the
  permission decision; engine clock recovery + `executions.finalResult`
  IS the schedule firing evidence.
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

### P1 — kernel + substrate (3 tests)

1. Happy path: `kernelWriteArm` records the command (with payload),
   wakes the parked body. The body reads its own kernel command and
   returns the payload — no separate input row table needed.
2. Crash between record and arm: `replayPendingWriteArm` re-arms on
   reconstruction. Body completes without test re-drive.
3. Bounded ownership: a `DurableDeferred.await`-only workflow with NO
   kernel command for it stays parked across replay. Proves the
   `tf-12q9` generic-sweep failure mode does NOT recur (kernel only
   recovers what it owns).

### P2 — RuntimeContext session as workflow body (3 tests)

The most load-bearing production subscriber, generalized as a single
workflow body. The body iterates its own kernel commands as the input
log — no parallel `inputs` table.

1. Single execution + memoized spawn: concurrent `Workflow.execute` for
   the same `(contextId, attempt)` admit ONE body. Spawns = 1, sends =
   N. Kills the production TOCTOU that spawned double `claude-agent-acp`
   PIDs.
2. Input arrival via `kernelWriteArm`: body parks before commands
   exist; subsequent kernel writes wake it; recorder sees each send
   exactly once (Activity-memoized).
3. Crash recovery: gen-1 records terminal kernel command WITHOUT
   arming, drops generation. Gen-2 replay re-arms, body completes,
   engine `executions.finalResult` lands. Spawn Activity is memoized
   from gen-1, so the fresh gen-2 recorder sees no spawn side effect.

### P3 — permission + tool (2 tests)

1. `PermissionRoundtripWorkflow` writes an open request row (no
   `status` flag), parks, returns the decision delivered in the kernel
   command payload by the responder.
2. `ToolDispatchWorkflow` idempotency: same toolUseId across two
   concurrent executes invokes the executor count = 1; both return
   identical resultJson. At-most-once via `Workflow.idempotencyKey` +
   Activity memoization — no `toolResults` table.

### P4 — scheduled + external adapters (4 tests)

1. `ScheduledPromptWorkflow` fires after wall-clock delay; the
   commitment row is present, the body returns `firedAt`. No `status`
   column — engine clock recovery + `executions.finalResult` IS the
   firing evidence.
2. `verifyAndIngestWebhook`: signed payload → row written → waiting
   `WebhookFactObserverWorkflow` wakes via kernel arm and returns the
   matched row.
3. `verifyAndIngestWebhook` rejects invalid HMAC; no fact written.
4. `emitPeerEvent` + waiting `PeerEventObserverWorkflow` wakes via
   kernel arm. Same shape as webhook — the producer side differs, the
   observer is specialized to its fact family.

### P5 — end-to-end + collapse invariants (13 tests)

1. **End-to-end driver** walks the complete product surface in one
   test: spawn → prompt input → tool dispatch → permission roundtrip →
   permission-response input → scheduled prompt → webhook ingest →
   peer event emit → terminal input → session completes. Asserts every
   fact landed durably; the recording adapter snapshot proves spawn = 1.

2-13. **Collapse-invariant assertions** read the simulation source
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
     runtime artifact.
   - **`WaitForFactWorkflow` / `SourceCollections` /
     `RuntimeObservationSourceNames`** — string-dispatch registry
     reconstruction.
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
