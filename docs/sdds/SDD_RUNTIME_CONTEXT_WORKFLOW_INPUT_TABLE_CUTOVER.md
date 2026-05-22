# SDD: RuntimeContextWorkflow-Owned Input Table Cutover

Doc-Class: dispatchable
Status: draft cutover spec
Bead: `tf-kk63`
Created: 2026-05-21
Owner: Firegrid Runtime Architecture
Extends:
- `SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md`
- `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`

## Scope

This is the Phase 0C Stage A production cutover spec for replacing the
runtime input mailbox:

```text
channel binding
  -> RuntimeControlPlaneTable.inputIntents
  -> RuntimeInputIntentDispatcherLive / reconcile
  -> appendRuntimeInputDeferred
  -> WorkflowEngineTable.deferreds as runtime-context/<id>/input/N
  -> RuntimeContextWorkflowNative awaits input/N
```

with a workflow-owned runtime input table:

```text
channel binding
  -> RuntimeContextWorkflow-owned atomic input append
  -> RuntimeContextWorkflowNative reads input by durable cursor
  -> workflow updates cursor in table state after transition
```

This document is source-grounded from tf-b1jm Finding F1, the Phase 0C
migration map in PR #613, and the current runtime sources. It is not a
production patch.

## ACIDs

This cutover exists to satisfy these existing requirements:

- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.1`: packages/tiny-firegrid contains an API-compatible clean-room reference implementation that drives the production protocol, client, edge, and channel contracts needed by the individual workflow slice while replacing only the behind-contract runtime implementation.
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.2`: The target reference composes a host-plane channel router, channel route implementations, workflow-owned DurableTable state, and one workflow body without importing production host-sdk or runtime implementation modules as behavioral dependencies.
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.3`: Host-plane route bodies in the target reference lower channel verbs to workflow-owned DurableTable writes or reads without exposing workflow handles, engine handles, DurableTable handles, output tables, request rows, claim rows, deferred rows, or completion rows to callers.
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.4`: Workflow-owned state in the target reference is modeled as an individual workflow state machine over a small number of DurableTable collections, not as separate request, claim, deferred, and completion table families per CRUD operation.
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.5`: The target reference proves session create or load, start, prompt, cancel, close or resume, duplicate input identity, and workflow-owned table progress through native tiny-firegrid OTel trace evidence and durable table/workflow artifacts.
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.6`: The target reference does not reference appendRuntimeInputDeferred, WorkflowEngineTable.deferreds, RuntimeInputIntentDispatcherLive, or RuntimeControlPlaneTable.inputIntents.
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.7`: The target reference treats implementation sprawl as a stop-and-re-evaluate condition.
- `firegrid-workflow-driven-runtime.PHASE_0B_OUTPUT_RESULT_RETURN.2`: Output observation in the target reference advances a durable observer cursor by output sequence and exposes wait semantics that resume after the last observed sequence.
- `firegrid-workflow-driven-runtime.PHASE_0B_OUTPUT_RESULT_RETURN.3`: Workflow replay or resume in the target reference reconstructs progress from workflow-owned table state.
- `firegrid-workflow-driven-runtime.BOUNDARIES.7`: Client-written RuntimeInputIntent rows are consumed by a host-wide local dispatcher that demuxes to active RuntimeContext workflow executions; per-context engines do not each subscribe to the entire namespace intent stream.
- `firegrid-workflow-driven-runtime.BOUNDARIES.7-1`: Until an engine.signal primitive exists, the host-scoped RuntimeContext engine may deliver input intents by completing context-scoped workflow deferreds in the shared engine table.
- `firegrid-workflow-driven-runtime.WORKFLOW_ADMISSION.1`: A production Workflow.make definition is only allowed for an owned durable resource or long-running process state machine.
- `firegrid-workflow-driven-runtime.WORKFLOW_ADMISSION.2`: New production Workflow.make sites require an SDD-backed owner/resource justification and must be added deliberately to the static workflow inventory.
- `firegrid-workflow-driven-runtime.WORKFLOW_ADMISSION.3`: Operation-shaped workflows currently present in production are migration debt, not precedent for new surfaces.

## Current Production Shape

Runtime input is already behind channel contracts, but the channel bindings
still write the legacy intent mailbox:

- `makeHostPromptChannel` and `makeSessionPromptChannelForSession` lower prompt
  input into `RuntimeControlPlaneTable.inputIntents.insertOrGet` through
  `appendInputIntent` in `packages/protocol/src/launch/host-control-request.ts`.
- `submitSessionPermissionResponse` writes permission responses to the same
  input intent collection in `packages/runtime/src/channels/session-permission.ts`.
- `RuntimeInputIntentDispatcherLive` streams `control.inputIntents.rows()` and
  calls `RuntimeContextInput.dispatchIntent` in
  `packages/runtime/src/kernel/runtime-context-workflow-runtime.ts`.
- Startup `reconcile` queries all input intents for a context and re-appends
  them into the active execution.
- `appendRuntimeInputDeferred` scans `WorkflowEngineTable.deferreds` for prior
  `runtime-context/<contextId>/input/` rows, computes the next sequence, and
  completes `runtimeInputDeferredFor(contextId, sequence)`.
- `RuntimeContextWorkflowNative` reads input through
  `completedRuntimeInput` / `awaitRuntimeInput`, both backed by numbered
  `DurableDeferred` names.

That shape is compatible with `firegrid-workflow-driven-runtime.BOUNDARIES.7-1`
as a temporary wakeup bridge. It is not the target architecture.

## Target Owner

`RuntimeContextWorkflowNative` remains the owned durable resource. Stage A must
not add a new `Workflow.make`, operation workflow, workflow registry, or
workflow command API. The input table is owned by the runtime-context workflow
and provided by the same host-scoped workflow engine wiring that already
provides `WorkflowEngine.WorkflowEngine` and `WorkflowEngineTable`.

The router remains ignorant of workflow names, execution ids, deferred names,
table names, and stream URLs. Channel bindings may depend on the table service;
callers and edge adapters must not.

## Table Shape

Stage A introduces a workflow-owned DurableTable for runtime-context state. The
exact class/package name is an implementation detail, but the owner and schema
families are fixed:

```ts
class RuntimeContextWorkflowTable extends DurableTable(
  "firegrid.runtimeContext.workflow",
  {
    contexts: RuntimeContextWorkflowStateRowSchema,
    inputs: RuntimeContextWorkflowInputRowSchema,
    inputIds: RuntimeContextWorkflowInputIdRowSchema,
  },
) {}
```

### `contexts`

One row per `contextId`, keyed by `contextId`.

Required fields:

- `contextId`: primary key.
- `nextInputSequence`: the durable input cursor. The workflow reads input rows
  with exactly this sequence.
- `nextInputSequenceToAssign`: the durable producer allocation cursor. Channel
  writes reserve from this cursor; workflow reads do not.
- `lastProcessedInputSequence`: optional mirror for diagnostics and migration
  comparison. If present, it must be derived from the same cursor update.
- `lastProcessedOutputSequence`: remains aligned with Phase 0B output cursor
  work; Stage A must not invent a second output cursor.
- `activityAttempt`: current runtime attempt when known.
- `status`: at least `created`, `running`, `exited`, `failed`, `closed`.
- `revision`: monotonically increasing row revision for transition evidence.
- `updatedAt`: ISO timestamp or monotonic milliseconds. Pick one and keep it
  stable in tests and traces.

`nextInputSequence` is the source of truth. It replaces the replay-local
`Ref` seed for input progress, not merely a diagnostic mirror.

### `inputs`

Append-only input rows, keyed by a point-addressable `inputKey`.

Required fields:

- `inputKey`: primary key, derived from `contextId` and `sequence`, for example
  `${contextId}/${sequence}`. This is the only workflow read address for "next
  input"; Stage A must not put `inputs.query(contextId && sequence == cursor)`
  on the workflow replay path.
- `inputId`: producer idempotency id. It is derived exactly as current
  `inputIdForRuntimeIngressRequest` derives identity, preserving idempotency.
- `contextId`: owner context id.
- `sequence`: durable input sequence. It is assigned once and never rewritten.
- `status`: `accepted`, `sequenced`, `cancelled`, or `rejected`.
- `kind`: current `RuntimeIngressKind` values: `message`, `control`,
  `tool_result`, `required_action_result`.
- `authoredBy`: current `RuntimeIngressAuthor` values: `client`, `workflow`,
  `tool`, `system`.
- `payload`: schema-compatible with the existing runtime ingress payload.
- `idempotencyKey`: optional, preserved from the public request.
- `metadata`: optional string map, preserved.
- `createdAt`: row creation timestamp.
- `sequencedAt`: timestamp set when the sequence is assigned.
- `_otel`: optional row trace context, preserved from current intent rows.

`RuntimeIngressInputRowSchema` is the closest current payload shape. The
production schema may reuse or rename it, but it must move into the
workflow-owned table family and stop being addressed through
`WorkflowEngineTable.deferreds`. If DurableTable cannot point-read this row by
`inputKey`, Stage A is blocked on an indexed point-read primitive for
`(contextId, sequence)`; a replay-path `query` is not an acceptable substitute.

### `inputIds`

Idempotency index rows, keyed by `inputId`.

Required fields:

- `inputId`: primary key.
- `contextId`: owner context id.
- `inputKey`: point address of the accepted input row.
- `sequence`: copied for diagnostics; the workflow does not read by this row.
- `createdAt`: timestamp copied from the input row.

This collection exists because the workflow read path and the producer
idempotency path need different point addresses. A duplicate producer reads
`inputIds.get(inputId)`, then `inputs.get(inputKey)`. The workflow reads only
`inputs.get(inputKeyFor(contextId, nextInputSequence))`.

### Optional `inputReceipts`

If the implementation needs producer receipts that differ from stored input
rows, use a small receipt schema returned by the channel binding. Do not add a
request/claim/completion table family. A producer receipt can be derived from
the `inputs` row returned by `appendRuntimeContextWorkflowInput`.

## Sequencing and Idempotency

Stage A must preserve the public prompt and permission idempotency behavior:

1. Decode the public/channel input through the existing protocol schema.
2. Resolve/validate the context using the same bounded materialization rules
   that prompt paths use today.
3. Derive `inputId` from explicit `inputId` or `idempotencyKey`, using the
   existing content-derived identity rule.
4. Atomically append through the workflow-owned input append primitive.
5. If `inputIds.get(inputId)` already exists, return the existing input row or
   receipt and do not assign a second sequence.
6. If the input is new, reserve exactly one sequence for that context, insert
   `inputs[inputKey]`, insert `inputIds[inputId]`, and advance
   `contexts.nextInputSequenceToAssign`.

The required append primitive is:

```text
appendRuntimeContextWorkflowInput(contextId, request):
  atomically:
    if inputIds[inputId] exists:
      return inputs[inputIds[inputId].inputKey]
    sequence = contexts[contextId].nextInputSequenceToAssign
    inputKey = contextId + "/" + sequence
    insert inputs[inputKey]
    insert inputIds[inputId]
    update contexts[contextId].nextInputSequenceToAssign = sequence + 1
  return inputs[inputKey]
```

This is a prerequisite for source-of-truth multi-producer table writes. It can
be implemented as a DurableTable transaction, a conditional context-row
compare/update with insert rollback semantics, or a single-writer table method
owned by the runtime-context workflow table Layer. It must not be implemented
as `insertOrGet(inputId)` followed by `max(existing inputs for context) + 1`.

Duplicate producers racing on the same `inputId` converge through
`inputIds`. Distinct producers racing on different `inputId` values are safe
only if the append primitive reserves sequences atomically. If the current
DurableTable API cannot provide that atomic reservation, Stage A may add table
schemas and mirror writes for evidence, but it must not make direct
multi-producer table writes the source-of-truth path. File the missing atomic
input append primitive as the blocker instead of rebuilding request/claim rows.

## Stage A Prerequisites

Stage A has two hard prerequisites before workflow-owned input rows can become
the production source of truth:

1. **Point-addressable next input.** The workflow must read the next input with
   a point operation: `inputs.get(inputKeyFor(contextId, nextInputSequence))`.
   If the physical table cannot use a composite key, add an indexed lookup
   primitive for `(contextId, sequence)` before Stage A. Do not place
   `inputs.query(...)` on the workflow replay path.
2. **Atomic input append/addressing.** Producers must append through
   `appendRuntimeContextWorkflowInput` or an equivalent primitive that
   atomically checks idempotency, reserves the next sequence, writes the
   point-addressed input row, writes the idempotency row, and advances
   `nextInputSequenceToAssign`.

Without both prerequisites, Stage A is limited to schema wiring, tests, and
non-authoritative mirror writes. It cannot cut producer source of truth over to
the workflow-owned input table.

## Channel Binding Writes

The first production write surfaces are:

- host prompt: current `HostPromptChannel` binding.
- session prompt: current `SessionPromptChannel.forSession` binding.
- permission response: current session permission / host permission response
  bindings.
- host command append: `appendRuntimeIngress` and its internal
  `appendRuntimeInputIntent` helper in `packages/host-sdk/src/host/commands.ts`.
- client SDK receipts: public prompt/session prompt methods currently expose
  `RuntimeInputIntentRow` receipts and must move to workflow-owned input row
  receipts together with the write path.
- scheduled or tool-produced runtime input only if the owner workflow already
  emits it through the same channel/input seam; do not create a separate
  schedule input table.

The target binding body is:

```text
decode channel payload
  -> require context row
  -> stamp row otel
  -> appendRuntimeContextWorkflowInput(workflow-owned atomic append)
  -> return stored row or receipt
```

Before the wakeup primitive lands, this binding may dual-write the legacy
input-intent/deferred path strictly as a wakeup compatibility bridge. The
workflow-owned input row must be the replay/source-of-truth row for any code
that opts into Stage A only after the atomic append/addressing primitive exists.
The dual write must be labeled temporary and blocked by the Stage B wakeup bead.

## Workflow Reads

`RuntimeContextWorkflowNative` replaces input-side deferred mailbox reads with
table reads:

```text
state = contexts.get(contextId) or initialize context state
inputKey = state.contextId + "/" + state.nextInputSequence
next = inputs.get(inputKey)
if next exists:
  decode next into AgentInputEvent
  apply transition
  update contexts.nextInputSequence = next.sequence + 1
  update revision/updatedAt
else:
  suspend until an input write can wake this execution
```

Replay behavior must reconstruct input progress from `contexts.nextInputSequence`
and point reads of immutable `inputs` rows. A replay must not scan the input
collection, rescan deferred rows, rebuild sequence from all historical engine
deferreds, or rely on an in-memory `Ref` as the source of truth for input
progress.

The merged event loop remains conceptually valid, but the input side changes:

- `completedRuntimeInput` becomes "read the workflow-owned input table at the
  next cursor".
- `awaitRuntimeInput` becomes "suspend until the next input row exists".
- `transitionInputEvent`, permission response matching, and downstream
  `sendSessionActivity` behavior can survive because they operate on decoded
  `RuntimeIngressInputRow` semantics, not on the mailbox substrate.

## Replay and Output Coordination

Stage A is the input-side complement to Phase 0B. It must not add or alter the
DurableOutputCursor primitive. It must coordinate with it this way:

- input progress lives in the runtime-context workflow table cursor;
- output progress lives in the Phase 0B durable output cursor/log;
- the merged loop chooses the next already-available event from the durable
  input cursor or output cursor;
- if neither side has an available row, the workflow suspends on the next
  durable wake condition.

The workflow may continue to prefer already-completed input before output, as
the current `completedRuntimeContextEvent` does, but the preference must be
explicitly tested because it can affect permission-response and tool-result
ordering.

## F3 Wakeup Dependency

`firegrid-workflow-driven-runtime.BOUNDARIES.7-1` is load-bearing. Without
`engine.signal` or table-write-driven workflow resume, a table write alone does
not wake a suspended `RuntimeContextWorkflowNative`.

### Can Land Before F3

- Add the workflow-owned input table schema, `inputIds` idempotency index, and
  Layer wiring.
- Add the point-read and atomic append/addressing primitive if they do not
  already exist.
- Add idempotent channel binding writes to the workflow-owned `inputs`
  collection only through the atomic append/addressing primitive.
- Add dual-write compatibility that preserves the current input intent/deferred
  wakeup path.
- Make the workflow read already-present inputs from its owned table and
  advance `contexts.nextInputSequence` only by point read.
- Add startup/replay tests that prove cursor reconstruction from the table.
- Add static checks that no new production `Workflow.make` is introduced and no
  new request/claim/completion bridge is introduced.

### Cannot Land Before F3

- Delete `RuntimeControlPlaneTable.inputIntents`.
- Delete `RuntimeInputIntentDispatcherLive`.
- Delete startup `reconcile`.
- Delete `appendRuntimeInputDeferred`.
- Delete the `WorkflowEngineTable.deferreds` scan used as input mailbox.
- Make a workflow wait only on table rows if table writes cannot wake it.
- Remove `firegrid-workflow-driven-runtime.BOUNDARIES.7-1` compatibility.

F3 can be satisfied by either an `engine.signal(executionId, reason)` primitive
or a table-write wakeup primitive that can resume the waiting workflow when an
input row for `contextId` and `nextInputSequence` is inserted. Polling the
table is not an acceptable substitute.

## Transactional Deletion Beads

These beads must be filed before Stage A implementation starts, then closed
only when their replacement is already merged and verified.

1. **`runtime-input-atomic-append-and-addressing`**
   - Provides the point-addressed next-input read path or indexed lookup for
     `(contextId, sequence)`.
   - Provides the atomic `appendRuntimeContextWorkflowInput` operation or
     equivalent transaction/conditional update.
   - Proves distinct concurrent producers cannot allocate the same sequence.
   - Blocks source-of-truth channel writes to the workflow-owned input table.

2. **`runtime-input-owned-table-stage-a`**
   - Adds `RuntimeContextWorkflowTable` and workflow-owned `inputs` /
     `inputIds` / `contexts` state.
   - Adds idempotent channel binding writes through the atomic append primitive.
   - Adds workflow point reads from the input table and cursor advancement.
   - May retain dual-write wakeup compatibility.
   - Blocks every deletion bead below.

3. **`runtime-input-engine-signal-wakeup`**
   - Provides `engine.signal` or table-write-driven resume for
     `RuntimeContextWorkflowNative`.
   - Proves a suspended workflow resumes from the atomic workflow-owned input
     append without completing a workflow deferred.
   - Blocks all legacy mailbox deletions.

4. **`runtime-input-delete-input-intents`**
   - Deletes `RuntimeControlPlaneTable.inputIntents`,
     `RuntimeInputIntentRowSchema`, `makeRuntimeInputIntentRow`,
     `runtimeInputIntentToRuntimeIngressRequest`, and prompt/permission code
     paths that still return intent rows as the durable authority.
   - Deletes or rewires `appendRuntimeIngress` and its internal
     `appendRuntimeInputIntent` helper in `packages/host-sdk/src/host/commands.ts`.
   - Updates client-sdk prompt/session prompt return contracts and exports that
     currently expose `RuntimeInputIntentRow` receipts.
   - Replaces public receipts with workflow-owned input row receipts.
   - Blocked on beads 1, 2, and 3.

5. **`runtime-input-delete-intent-dispatcher`**
   - Deletes `RuntimeInputIntentDispatcherLive`,
     `RuntimeContextInput.dispatchIntent`, and dispatcher Layer composition in
     host runtime layers.
   - Blocked on beads 1, 2, and 3.

6. **`runtime-input-delete-append-deferred`**
   - Deletes `appendRuntimeInputDeferred`, `runtimeInputDeferredName`,
     `runtimeInputDeferredFor`, `completedRuntimeInput`, and
     `awaitRuntimeInput` as semantic input mailbox APIs.
   - Keeps engine-private durable deferreds for real workflow suspension.
   - Blocked on beads 1, 2, and 3.

7. **`runtime-input-delete-deferred-mailbox-scan`**
   - Deletes the `WorkflowEngineTable.deferreds` scan that reconstructs
     runtime input rows from `runtime-context/<contextId>/input/` deferred
     names.
   - Adds/keeps a static check that rejects deferred-name input mailbox use.
   - Blocked on beads 1, 2, and 3.

8. **`runtime-input-delete-reconcile`**
   - Deletes startup `reconcile` that queries intent rows and re-appends them
     into active workflow executions.
   - Replaces it with workflow replay from `RuntimeContextWorkflowTable`.
   - Blocked on beads 1, 2, and 3.

Do not close a deletion bead as superseded by a narrower PR. If a PR only moves
prompt writes but leaves permission responses or startup replay on the legacy
path, file the remainder as a new blocking bead.

## Validation

The implementation PRs that follow this SDD must prove:

- duplicate prompt `idempotencyKey` returns the existing workflow-owned input
  row/receipt and does not advance `nextInputSequenceToAssign` twice;
- distinct concurrent prompt inputs for one context reserve distinct sequences
  atomically and are consumed in sequence order;
- permission response input uses the same table family and does not recreate
  an intent row family;
- workflow replay reconstructs `nextInputSequence` from `contexts`, not from
  `WorkflowEngineTable.deferreds`;
- workflow replay reads the next input by point address or indexed point lookup,
  not by `inputs.query(...)`;
- host-sdk `appendRuntimeIngress` and client-sdk `RuntimeInputIntentRow` prompt
  receipts are either still explicitly on the compatibility path or cut over to
  workflow-owned input receipts;
- before F3, dual-write compatibility still wakes the workflow through
  `firegrid-workflow-driven-runtime.BOUNDARIES.7-1`;
- after F3, no trace spans or static references remain for
  `RuntimeInputIntentDispatcherLive`, `RuntimeControlPlaneTable.inputIntents`,
  `appendRuntimeInputDeferred`, or runtime-context input deferred names;
- no new production `Workflow.make` site is added.

## Stop And Re-Evaluate

Stop and update the SDD before coding if the cutover requires:

- a new public workflow command API;
- a request, claim, completion, input-intent, or deferred bridge replacing the
  old bridge;
- a broad registry or adapter subsystem above the channel/router seam;
- a second output cursor or edits to the DurableOutputCursor primitive;
- HostKernelWorkflow authority, placement, failover, or cross-host routing;
- operation-shaped workflows for prompts, permission responses, tool calls, or
  waits;
- polling as the normal wakeup mechanism for table-written input;
- replay-path input scans such as `inputs.query(contextId && sequence == cursor)`;
- non-atomic sequence allocation such as `insertOrGet(inputId)` followed by
  `max(existing inputs for context) + 1`.

## Source Notes

Primary sources read for this spec:

- `docs/sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md`
- `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`
- tf-b1jm Phase 0C migration map from PR #613
- `packages/runtime/src/workflow-engine/runtime-input-deferred.ts`
- `packages/runtime/src/kernel/runtime-context-workflow-runtime.ts`
- `packages/runtime/src/workflow-engine/workflows/runtime-context.ts`
- `packages/protocol/src/launch/host-control-request.ts`
- `packages/runtime/src/channels/session-permission.ts`
- `packages/client-sdk/src/firegrid.ts`
- `packages/host-sdk/src/host/commands.ts`
