# kernel-owned-write-arm · FINDING

**Verdict: GREEN — the target rearch shape (host-kernel/controller-owned
write+arm over a workflow-owned table input) recovers parked table-wait bodies on
restart through the kernel path, with no driver re-drive and no generic
resume-all sweep.** This is the sound replacement for the engine-level sweep that
tf-12q9 rejected; it does not touch the production engine, so the engine
invariants (tf-gyxc, deferred-done-idempotency) stay green by construction.

## The shape

- **Body** (`WakeWorkflow`): tf-e5rf table-wait. Point-read a workflow-owned
  input row; absent ⇒ `Workflow.suspend` (NO `DurableDeferred` mailbox); present
  ⇒ idempotent processed-marker + complete. The marker is the
  engine-independent witness that the body ran its consume step.
- **Kernel-owned control table** (`KernelCommandTable`, kernel-private): one row
  per write+arm *fact* — `{commandKey, executionId, inputKey, inputValue,
  status}`. Written FIRST as the durable record of intent.
- **Controller** (`workflow.ts`): `kernelWriteArm` = record the owned fact →
  write the workflow-owned input row → arm (`resume`). All steps idempotent
  (`insertOrGet` / resume short-circuits on `finalResult`).
- **Restart recovery** (`replayPendingWriteArm`): on every generation startup
  (after workflow registration — the kernel deterministically sequences
  register → replay), query the kernel's OWN pending facts and, for each whose
  execution has no `finalResult`, re-write the input + re-arm. Bounded to owned
  facts; never scans `engine.executions` for arbitrary suspended workflows.

## Probes & results

| Probe | Sequence | After reconstruction (NO driver re-drive) |
|---|---|---|
| **A** — crash between write & arm | park → kernel records fact + writes input → crash before arm | kernel replay arms → `processed=true`, value=`delivered-by-A` |
| **B** — arm issued, body unfinished | park → kernel record+write+arm (resume) → crash before body completes | kernel replay re-arms (idempotent) → `processed=true`, value=`delivered-by-B` |
| **C** — soundness contrast | `DurableDeferred.await` body parked, NO kernel fact for it → crash | kernel replay leaves it **untouched** (`suspended`, no finalResult); its own `deferredDone` path then recovers it |

Probe C is the load-bearing one: it proves the kernel recovers *only* executions
it owns a write+arm fact for. The generic engine sweep (tf-12q9) could not make
this distinction — a `DurableDeferred.await` suspension is byte-identical to a
table-wait at the engine-row level (vendored `DurableDeferred.ts:116-119`:
`await` *is* `Workflow.suspend`), so a "resume all suspended" sweep also resumed
deferred-awaits and raced their `deferredDone`/`interrupt` paths. The kernel
replay sidesteps this entirely by keying recovery off its own command table, not
the engine's undifferentiated `suspended` flag.

## Why this is sound where the engine sweep was not

1. **Bounded ownership.** Recovery iterates the kernel's command table, never
   the engine's suspended executions. Workflows the kernel owns no fact for
   (deferred-awaits, other table-waits) are never touched.
2. **Deterministic register → replay ordering.** The kernel runs the replay as a
   startup step after it has registered its workflows, so `resume` always has
   the execute fn. tf-12q9's engine-construction sweep ran before registration
   (workflows map empty) — the timing hazard is gone.
3. **No concurrent driver injected into other lifecycles.** The kernel is the
   single serialized owner of write+arm for its executions; it does not fork a
   competing body fiber into executions the reconstructed generation is also
   driving via `interrupt`/`deferredDone`.

## Scope

Reference / target-shape validation only. The production runtime-context input
path still uses the retiring `DurableDeferred` mailbox; the concrete cutover
surface is in `docs/cannon/sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md`.
No production engine or runtime-context changes in this slice.

## Run

```
pnpm --filter @firegrid/tiny-firegrid simulate run kernel-owned-write-arm
```
