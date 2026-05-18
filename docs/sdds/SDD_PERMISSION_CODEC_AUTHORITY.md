# SDD: Permission Codec Authority

Status: signed off — Build B implementation in PR #350. No toy `permission-flow-pipeline` work is in scope for this PR.

## §0 — The load-bearing question, read this first

**Does any codec complete workflow deferreds / do authority work, or is permission-class event routing strictly observation + workflow-side resumption?**

This is the Gurdas-signoff question for TFIND-015. The answer gates the queued `permission-flow-pipeline` configuration; do not build that configuration until this implementation lands.

### A/B framing

**A. Codec-side authority.** Bless the current ACP shape as intentional: the ACP codec may create workflow deferred identities, poll `WorkflowEngine.deferredResult`, complete those deferreds when `PermissionResponse` input arrives, and translate the resulting decision into the protocol-level ACP `RequestPermissionResponse`. In this model the codec is not just observing/encoding protocol traffic; it owns the permission continuation authority for the live session.

**B. Strict observation + workflow-side resumption.** Treat codecs as protocol/session translators only. A codec may keep live protocol promises and correlation state required by the wire protocol, but it must not own durable permission state or complete workflow deferreds. Permission requests are normalized as observable output, permission responses enter as client/workflow input intents, and workflow-side runtime code owns any durable deferred creation/completion/resumption needed to bridge those two facts back to the live codec continuation.

### Decision

Gurdas signed off **B: strict observation + workflow-side resumption**, with one important clarification: ACP still needs a live protocol continuation because `requestPermission` is an active ACP SDK promise. The boundary is not "make ACP stateless"; it is "codec owns only the live ACP promise/correlation, while workflow/runtime owns durable authority and deferred completion."

This matches the existing codec README boundary rule that durable permission state belongs outside codecs, makes permission-class behavior analogous to the TFIND-041 by-decision precedent, and keeps the planned `permission-flow-pipeline` from encoding hidden codec-side durable authority as the production contract.

The implementation is the proof point for the chosen boundary: ACP no longer depends on `WorkflowEngine` or `DurableDeferred`, and the runtime workflow owns the durable input deferred that resumes the live ACP continuation.

## §1 — Grounding from canonical FINDINGS

`packages/tiny-firegrid/FINDINGS.md:740-752` records TFIND-015 as open. The relevant production kernel is not merely that the toy lacks permission coverage; it is whether codec layers only translate protocol events, or whether any codec currently completes workflow deferreds / performs authority-like work for permission-class events. The recorded next action is a permission-flow configuration that observes permission requests through the per-context output channel and routes permission responses back as client input intents, "unless production chooses a different authority boundary."

`packages/tiny-firegrid/FINDINGS.md:1375-1436` records TFIND-041 as resolved by decision B on 2026-05-18. For `ToolUse`, Gurdas chose session/codec mode as the explicit authority axis rather than promoting execution authority onto the event itself: ACP is observation-only, stdio-jsonl is client-result roundtrip, and the shared `ToolUse` event deliberately remains under-discriminated by execution authority.

The TFIND-041 precedent is directly relevant but not automatically dispositive. Permission-class events have the same family shape because a normalized event can either carry authority semantics itself, defer interpretation to session mode, or route through workflow authority. The difference is that ACP permission handling currently reaches into `WorkflowEngine`/`DurableDeferred`, while TFIND-041's decided branch lives in workflow code that interprets a normalized `ToolUse` event by session mode.

## §2 — Pre-implementation codec evidence

At framing time, ACP advertised permission support and contained durable workflow machinery:

- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:155-158` constructs a `DurableDeferred` for each permission request id.
- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:261-283` requires `WorkflowEngine` and `WorkflowInstance` from inside the codec.
- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:285-308` polls `engine.deferredResult(...)` until a permission decision appears.
- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:310-328` completes the durable deferred via `DurableDeferred.done(...)`.
- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:340-351` emits a normalized `PermissionRequest`, waits for the durable decision, then returns an ACP `RequestPermissionResponse`.
- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:416-421` handles `PermissionResponse` input by completing the same durable deferred.

stdio-jsonl currently takes the opposite shape for permission-class input:

- `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:15-23` advertises `permissions: false`.
- `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:201-214` rejects `PermissionResponse` as unsupported input.

The codec boundary documentation already leans toward B:

- `packages/runtime/src/agent-event-pipeline/codecs/README.md:25-35` says codecs produce/consume runtime event contracts but do not own durable tables, subscriber dispatch, host topology, or durable permission state.
- `packages/runtime/src/agent-event-pipeline/codecs/README.md:72-83` says ACP permission request/response is a live control-channel continuation, while durable permission state must stay outside codecs.

That created the TFIND-015 conflict in concrete form: ACP implementation did durable-deferred work from inside the codec, while the documented codec contract said durable permission state is outside codecs. Build B resolves this by removing the durable-deferred work from the codec.

## §3 — Option A: codec-side authority

Under A, the ACP codec's current durable permission behavior becomes the contract. The codec may depend on workflow services, allocate durable deferred ids, complete those deferreds from `PermissionResponse`, and treat the ACP protocol callback as the owner of permission continuation. The workflow observes the `PermissionRequest`, but the codec remains the component that closes the loop.

Benefits:

- Minimal short-term implementation churn because ACP already follows this shape.
- The ACP SDK callback maps naturally to a promise-like codec continuation.
- The planned permission pipeline can be implemented by exercising existing ACP behavior rather than first moving authority.

Costs:

- Contradicts the current codec README boundary rule unless the documentation is changed.
- Makes codecs part of durable workflow authority, which broadens the meaning of an `AgentSession` beyond protocol/session translation.
- Creates asymmetric semantics across codecs: ACP can complete permission deferreds, while stdio-jsonl rejects `PermissionResponse`.
- Makes replay/restart semantics harder to reason about because a live codec promise and durable workflow completion are coupled in one layer.

Choose A only if the desired production contract is that ACP permission prompts are special enough to own durable continuation authority inside the codec.

## §4 — Option B: strict observation + workflow-side resumption

Under B, codecs emit and accept normalized permission events but do not complete workflow deferreds. ACP still owns the live ACP SDK `requestPermission` promise while the process is alive; that is protocol correlation, not durable authority. Workflow/runtime code owns durable ids, persistence, permission-response routing, cancellation semantics, and the point where a persisted client decision resumes the live ACP continuation.

Benefits:

- Aligns with the codec README boundary rules already present in the repo.
- Preserves a clean separation between protocol translation and workflow authority.
- Gives the planned `permission-flow-pipeline` a clear public-surface contract: observe `PermissionRequest`, send `PermissionResponse`, verify workflow-side resumption.
- Keeps durable permission replay semantics out of codec-local state.
- Mirrors the TFIND-041 pattern at the architectural level: authority is explicit by decision, not hidden in an under-documented event/codec default.

Costs:

- Requires moving the durable permission deferred machinery out of ACP codec scope or wrapping it behind a workflow-owned bridge.
- Needs a precise live-continuation handoff so ACP's SDK callback can be resumed without letting the codec own durable state.
- Needs tests that distinguish "codec live promise/correlation" from "workflow durable authority"; otherwise the old shape can reappear under a different name.

Choose B if permission-class events should behave like durable runtime workflow facts first, with codecs remaining protocol/session adapters.

## §5 — Is permission-class analogous to TFIND-041?

Yes, in the limited but important sense that both findings are about where authority lives when the normalized event shape alone is insufficient.

TFIND-041 decided not to promote `ToolUse` execution authority onto the event. Instead, workflow code consults session/codec mode by decision; `packages/host-sdk/src/host/runtime-context-workflow-core.ts:231-244` records that ACP `ToolUse` is observation-only while stdio-jsonl is client-result roundtrip.

Permission-class events should get the same explicitness. The recommended answer is not "session mode owns all permission authority" because ACP currently needs durable workflow participation. The closer analogue is: the authority boundary must be documented by decision, and the event/codec default must not accidentally decide it. For permission-class events, the cleaner decision is workflow-side durable authority plus codec-side live protocol continuation.

## §6 — Secondary / mechanical questions after §0

1. If B is accepted, what is the smallest workflow-owned bridge that lets ACP `requestPermission` wait on a live continuation without the codec constructing or completing `DurableDeferred` directly?
2. Where should permission-response routing live: existing runtime workflow core, a dedicated permission authority module, or a subscriber adjacent to runtime input dispatch?
3. Should `AgentToolUseMode` grow a sibling permission-mode capability, or are existing `AgentCapabilities.permissions` plus explicit workflow routing enough?
4. How should cancellation behave for pending permissions when the ACP session is cancelled or terminated: workflow-owned cancellation event, codec live-promise cancellation only, or both with distinct responsibilities?
5. Should stdio-jsonl remain `permissions: false`, or should a future stdio-jsonl permission protocol be framed separately after ACP authority is settled?
6. Which tests prove the boundary: codec unit tests for protocol mapping only, workflow tests for deferred completion, and the queued `permission-flow-pipeline` as the production-consuming integration.

## §7 — Acceptance gate

This document is the signed-off record for PR #350. The production implementation is in scope for the same PR; the toy `permission-flow-pipeline` remains out of scope and is unblocked only after this lands.

- ACP codec owns only live `requestPermission` correlation and promise resolution.
- Runtime workflow owns durable runtime-input deferred waiting/completion and sends the matching `PermissionResponse` to the active codec.
- No forcing/widening cast is present on the ACP codec, runtime workflow permission bridge, or runtime-input deferred path.
- The deterministic integration test records prompt input, observes a durable `PermissionRequest`, proves the agent remains blocked before response ingress, appends `PermissionResponse`, observes the exact `runtime-context/<contextId>/input/1` deferred row, and verifies the live ACP continuation resumes.

## §8 — Structural proof for Build B

Build B splits authority by direction:

1. **Codec output observation:** `AcpSessionLive` converts ACP `requestPermission` into a normalized `PermissionRequest` output event and stores only an in-memory `Deferred<PermissionDecision>` keyed by `permissionRequestId`. It does not import or require `WorkflowEngine`, `WorkflowInstance`, or `DurableDeferred`.
2. **Durable response authority:** client/workflow `PermissionResponse` ingress is still recorded as a runtime input intent, then sequenced into the owner workflow's existing `runtimeInputDeferredFor(contextId, sequence)` durable deferred. This is the only durable deferred completion used by the permission response path.
3. **Workflow-side bridge:** `RuntimeContextWorkflowNative` waits for a `PermissionRequest` output observation, then awaits the next runtime-input durable deferred. Only a matching `PermissionResponse.permissionRequestId` is sent to `RuntimeContextWorkflowSession.send`; mismatches fail the runtime workflow with a named permission-response error.
4. **Live ACP continuation:** after workflow delivery, the ACP codec completes the live in-memory deferred and returns the ACP `RequestPermissionResponse` to the SDK callback. This is protocol correlation, not durable authority.

The deterministic failure-mode test is:

`packages/host-sdk/test/host/runtime-codec-event-plane.test.ts` —
`firegrid-runtime-agent-event-pipeline.INGREDIENTS.4 firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-2 firegrid-runtime-agent-event-pipeline.VALIDATION.3-2 journals ACP PermissionRequest, blocks, and resumes through the runtime-input deferred`.

It uses DurableTable live streams instead of sleep polling for the permission request and deferred-row observation, satisfying the emit-then-wait bar.
