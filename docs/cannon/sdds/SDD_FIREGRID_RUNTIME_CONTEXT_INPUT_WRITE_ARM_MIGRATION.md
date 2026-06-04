# SDD: Runtime Context Input Write+Arm Migration

Doc-Class: dispatchable
Status: draft architecture
Date: 2026-05-22
Owner: Firegrid Architecture
Related:
- `../architecture/kernel-owned-write-arm.md`
- `../../architecture/2026-05-22-runtime-rearch-closeout.md`
- `../../sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md`

## Problem

The runtime-context input path is migrating from a legacy mailbox shape to the
target workflow-owned table shape.

Current production input delivery uses a DurableDeferred mailbox:

```text
channel / authority route
  -> RuntimeControlPlaneTable.inputIntents
  -> RuntimeContextWorkflowRuntimeLive dispatcher
  -> appendRuntimeInputDeferred
  -> engine.deferredDone(input/N, sequenced input row)
  -> RuntimeContextWorkflow awaits DurableDeferred input/N
```

That path is not the target architecture. It is a working transitional bridge
whose reliability depends on machinery the re-architecture is retiring:

- per-input deferred names;
- sequence allocation above the workflow-owned state model;
- `inputIntents` as a public-ish staging table;
- a host-scoped dispatcher/reconciler fiber;
- `appendRuntimeInputDeferred` as mailbox adapter.

The target shape is:

```text
channel / edge route
  -> host kernel/controller command
  -> write workflow-owned input row
  -> arm or resume the owning runtime-context workflow
  -> restart recovery for that owned command
  -> RuntimeContextWorkflow reads its workflow-owned table state
```

The migration question is not whether the DurableDeferred mailbox is accepted
architecture. It is not. The question is:

> What bridge state and cutover sequence retires the current mailbox while
> preserving idempotent input delivery, crash recovery, and body progress?

## Decision

Treat the current DurableDeferred mailbox as a bridge, not an invariant.

The canonical target is workflow-owned table input plus host-kernel/controller
owned write+arm. The host kernel/controller may evolve from today's
`RuntimeContextWorkflowRuntimeLive` authority position, but it must expose the
target primitive rather than preserving the dispatcher/mailbox contract.

`tf-c9r9` should validate the target primitive in the S1/firelab
reference path first. A production runtime-context cutover is a later,
separately scoped transactional replacement.

## Current Bridge Contract

The bridge may remain in production until the target cutover is ready, but only
as transitional compatibility. It must not be cited as precedent for new input,
tool, or lifecycle surfaces.

The bridge must preserve these properties while it remains:

- input delivery is idempotent by stable input identity;
- duplicate delivery converges without double-processing;
- existing contexts continue making progress;
- restart re-subscription through the dispatcher recovers unprocessed intents;
- no caller receives workflow handles, deferred names, stream URLs, table names,
  or engine services.

The bridge may not grow new architecture around:

- cross-author arrival ordering;
- per-source or global sequence authority beyond what existing compatibility
  needs;
- new public `DurableDeferred` input APIs;
- new dispatcher/reconciler responsibilities.

## Target Contract

The target host kernel/controller command owns both halves of input delivery:

1. persist the workflow-owned input row;
2. arm or resume the owning workflow execution;
3. persist enough command state for restart recovery;
4. serialize with lifecycle operations that can affect the same context.

The workflow body consumes from its own durable state. It does not await
`input/N` deferred names and does not rely on a separate input-intent dispatcher.

The command must be identity-driven, not order-driven. The runtime-context body
does not require cross-author arrival ordering. If an edge needs weak
same-source FIFO for agent ergonomics, that is an edge concern, not the runtime
body's wake primitive.

### Input Identity Model

The target input identity model is per input, not per `(contextId, sequence)`.
Each input is an independent controller write+arm fact keyed by stable input
identity. The kernel/controller:

- does not allocate input sequences;
- does not scan existing rows for `max(sequence) + 1`;
- does not preserve sequence ordering across crashes;
- does not become an ordering authority.

The body state machine consumes visible inputs by identity and applies its own
state transitions. `transitionInputEvent` / `transitionOutputEvent` do not
depend on cross-author arrival order, so the controller only proves durable
delivery and wake ownership for the input fact it owns.

If `sequence` remains during the production bridge, it is compatibility
bookkeeping for existing mailbox-backed contexts, not target architecture.

## Migration Sequence

### Phase 1 - Reference Controller

Build the host-kernel/controller-owned write+arm shape in the S1 or
firelab table-wait reference path.

Acceptance:

- S1 Probe A and Probe B auto-recover through the controller path without an
  explicit test redrive;
- S1 Probe C clock recovery stays green;
- no generic engine suspended-workflow sweep is introduced;
- interrupt terminality and `deferredDone` idempotency stay green by not
  changing production engine semantics;
- the trace clearly attributes row write and wake to the same controller
  command.

### Phase 2 - Production Cutover Design

Before editing production runtime-context input delivery, write the concrete
cutover plan against the current files. The plan must name the replacement
surface for:

- `RuntimeContextWorkflowRuntimeLive` dispatcher responsibilities;
- `RuntimeControlPlaneTable.inputIntents`;
- `appendRuntimeInputDeferred`;
- `awaitRuntimeInput`;
- compatibility for existing contexts that still have sequence-tagged mailbox
  inputs;
- restart recovery of pending controller commands.

The plan must also state whether there is a dual-read or drain period for
contexts that already have pending mailbox inputs.

### Phase 3 - Transactional Production Replacement

Production cutover must follow the transactional cutover rule. It either lands
the complete replacement with deletion/reconciliation of the old mailbox path,
or it lands an explicitly named temporary bridge with a blocking deletion bead.

Acceptance:

- existing mailbox-backed contexts do not lose or double-process pending input;
- new contexts use workflow-owned table input plus controller write+arm;
- the old dispatcher/mailbox path is deleted or marked as a bounded bridge with
  a deletion bead;
- trace-health shows the input-intent/deferred-mailbox nodes leaving the
  runtime graph after the cutover;
- the engine still does not perform a generic suspended-workflow recovery
  sweep.

## Non-Goals

This SDD does not:

- re-legitimize the DurableDeferred mailbox as target architecture;
- require immediate production runtime-context cutover in `tf-c9r9`;
- introduce an input ordering authority;
- require engine-level typed suspension kinds;
- change output observation cursor work (`tf-aseo`);
- delete `DurableDeferred` generally. Ordinary deferred completion remains an
  engine primitive.

## Stop Conditions

Stop and report instead of coding if:

- the implementation needs to preserve the DurableDeferred mailbox as the target
  wake primitive;
- the implementation needs a generic engine sweep over all suspended workflows;
- there is no durable identity tying a controller command to the context,
  workflow execution, and row/tool-use key it owns;
- production cutover cannot preserve pending mailbox inputs for existing
  contexts;
- the change crosses runtime-context input, tool-call results, output cursors,
  and lifecycle semantics in one PR.

## Work Mapping

- `tf-c9r9`: validate the controller-owned write+arm target in the reference
  path and produce the concrete production cutover finding if needed.
- `tf-vrz6`: production runtime-context input table cutover, after the target
  primitive is validated and the cutover plan is explicit.
- `tf-jpcg`: tool-use result/request seam should reuse the same ownership class,
  not preserve a separate per-call workflow mailbox.
- `tf-vfq9`: delete `ToolCallWorkflow` only after `tf-jpcg` lands.
- `tf-aseo`: independent output cursor work.
