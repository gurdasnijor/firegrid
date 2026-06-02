# Kernel-Owned Write+Arm

Doc-Class: dispatchable
Status: active — PRINCIPLE binding; SUBSTRATE CONTEXT superseded by #765 (see banner)
Date: 2026-05-22 (substrate-context refreshed 2026-06-01)
Owner: Firegrid Architecture

> **★ SUBSTRATE-CONTEXT SUPERSEDED by the #765 unified collapse (2026-06-01).**
> The *principle* below (kernel/controller-owned write+arm; no generic engine
> sweep; engine stays a mechanism; the arm idempotently **creates-or-resumes**;
> replay recovers) is **still binding**. But this note was written 2026-05-22,
> before the unified kernel, so its **mechanism references are stale** — do NOT
> anchor a new implementation on them:
> - The "DurableDeferred mailbox (`appendRuntimeInputDeferred` + dispatcher
>   re-subscription)" described as "today's path" **no longer exists** (deleted
>   by #765).
> - The cited `SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md`
>   **does not exist** — ignore that reference.
> - **The resume-half of write+arm is ALREADY the unified signal primitive**
>   `packages/runtime/src/unified/signal.ts`: `sendSignal` (record-row →
>   companion write → `engine.resume`, the record-before-resume order),
>   `recoverPendingSignals` (restart re-arm), `insertOrGet` keyed by
>   `(executionId, name)` (idempotent). `prompt` already uses it.
> - **Today's actual gap** = the *create* half: `sendSignal` **resumes only**
>   (`signal.ts:160`), so a fresh session's first signal has no run to resume.
>   The fix is a **create-or-resume arm on `signal.ts`** (first start
>   idempotently *creates* the run via a fenced `engine.execute` keyed by
>   `executionId(contextId, attempt:1)`; later arms resume) **+ wiring
>   `recoverPendingSignals` into `FiregridHost`** (R14). That work is
>   **`tf-ll90.3`** — compose the existing primitive, do **not** build a parallel
>   `kernelWriteArm`/`KernelCommandTable` from this note's pre-unified mechanism.
> - The Acceptance-Gate's "S1 Probe A/B/C" maps to the unified execution-span
>   gate **`tf-ll90.19.2`** (assert `execution.execute` / `adapter.start_or_attach`
>   / `local_process.open_byte_pipe` fired on the real-path sim).

## Purpose

This note records the current canonical architecture for waking a workflow after
a durable row write. It supersedes the "generic restart recovery sweep" option
from the S1 planning discussion and clarifies a naming trap:

> There is no concrete `HostKernelWorkflow` implementation in the codebase
> today.

`HostKernelWorkflow` names a target ownership role: a host-side serialized
controller for lifecycle and workflow-owned resource commands. Engineers should
not spend time searching for a class, workflow, or module with that name. Until
the implementation exists, use the concrete phrase **host kernel/controller** in
plans and name the actual file or module being changed.

## Evidence

The current conclusion is empirical, not aesthetic.

1. **S1 proved the durability gap.** A workflow body parked on a
   workflow-owned table row can miss durable work. If the row write survives but
   the following `engine.resume` is lost, reconstruction alone does not re-arm
   the table wait. Durable clock waits do recover on reconstruction, via the
   clock wakeup recovery path.

2. **The engine-level recovery sweep was falsified.** A prototype blanket sweep
   made the S1 happy path green, but regressed interrupt terminality and
   `deferredDone` idempotency. The reason is structural: the engine persisted
   row records only an undifferentiated suspended execution. It does not know
   whether that execution is parked on a table row, a durable deferred, an
   interrupt, or another suspension reason.

3. **Therefore the engine cannot safely infer the wake.** A generic
   "resume every suspended workflow on restart" operation is unsound while
   suspension kinds are not explicit engine state. It can start a second body
   fiber racing a real deferred completion or interrupt and corrupt the terminal
   result.

## Decision

The sound shape is a **host-kernel/controller-owned write+arm command**:

```text
edge / channel route
  -> host kernel/controller command
  -> write the workflow-owned row
  -> arm or resume the owning workflow execution
  -> persist enough command state for restart recovery
```

The owner is the component that knows why the write implies a wake. It created
the command, knows the target context/execution identity, knows the table row or
tool-use identity being satisfied, and can serialize the wake with lifecycle
operations such as close, cancel, interrupt, and reconstruction.

This is not an input ordering authority. Cross-author arrival order remains a
non-requirement for the runtime-context body. The controller owns durability and
wake coupling, not semantic ordering.

> **[Superseded 2026-06-01]** The original text here described the pre-#765
> "DurableDeferred mailbox (`appendRuntimeInputDeferred` + dispatcher
> re-subscription)" as today's bridge, and pointed to a migration SDD. Both are
> **gone**: #765 replaced that model with the unified **signal primitive**
> (`unified/signal.ts`), and `SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md`
> was never written / does not exist. The current production input path is
> `sendSignal` (record-before-resume); the remaining migration is purely the
> **create-or-resume arm + `recoverPendingSignals` host wiring** tracked by
> `tf-ll90.3` (see the banner at the top of this doc).

## Guardrails

- Do not implement a generic engine sweep that resumes arbitrary suspended
  executions on reconstruction.
- Do not add an input deferred mailbox, input intent dispatcher, or ordering
  serializer to close this gap.
- Do not write workflow-owned input/tool rows from an arbitrary channel binding
  and then hope the engine catches up.
- Do not cite `HostKernelWorkflow` as an existing implementation. It is a
  target role until a PR introduces the concrete module.
- Do not make the workflow engine learn semantic channel targets. The engine
  remains the mechanism for suspend, resume, deferred completion, clock wakeups,
  and replay.

The only engine-side escape hatch that would reopen the sweep option is an
explicit engine feature for typed suspension kinds. That is a separate engine
primitive, not the current architecture.

## Scope

The write+arm owner applies to commands that both mutate workflow-owned durable
state and imply that a parked owner workflow should run:

- runtime-context input rows (`tf-vrz6` direction);
- tool request/result rows keyed by `toolUseId` (`tf-jpcg` direction);
- future host lifecycle commands that write owner state and wake the owner.

It does not replace:

- durable clock recovery;
- ordinary `DurableDeferred.await` / `deferredDone` mechanics;
- generic workflow reconstruction;
- output observation cursors (`tf-aseo`), which are a separate replay-cost
  problem.

## Acceptance Gate

Any implementation of this direction must pass the positive and negative gates:

- S1 Probe A and Probe B auto-recover through the kernel/controller path without
  an explicit test redrive.
- S1 Probe C clock recovery remains green.
- Interrupt terminality remains green.
- `deferredDone` idempotency remains green.
- The full relevant test suite is green, not only the S1 simulation.
- Trace output shows the row write and wake owned by the same host
  kernel/controller command, not by a generic suspended-workflow sweep.

If an implementation cannot find enough authority or identity to own both the
write and the wake, it must stop and report the missing primitive. It should not
fall back to a generic engine sweep or rebuild the old deferred mailbox.

## Work Mapping

- `tf-c9r9` owns the next implementation slice: introduce the smallest concrete
  host-kernel/controller path for runtime-context table input write+arm in the
  reference path, then report the concrete production cutover surface.
- `tf-12q9` is the negative evidence: the engine restart sweep shape is unsafe
  under the current undifferentiated suspension model.
- `tf-vrz6` should consume the resulting write+arm primitive for table-backed
  input delivery.
- `tf-jpcg` should use the same primitive class for tool request/result wakeup;
  it should not invent a separate wake mechanism.
- `tf-vfq9` can delete `ToolCallWorkflow` only after the `tf-jpcg` seam exists.
- `tf-aseo` is independent and can proceed in parallel.
