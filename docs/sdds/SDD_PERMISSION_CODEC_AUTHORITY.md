# SDD: Permission Codec Authority

## §0 — The load-bearing question, read this first

**Does any codec complete workflow deferreds / do authority work, or is permission-class event routing strictly observation + workflow-side resumption?**

This is the Gurdas-signoff question for TFIND-015. The answer gates the queued `permission-flow-pipeline` configuration; do not build that configuration until this SDD lands and the decision is batched through coordinator review.

### A/B framing

**A. Codec-side authority.** Bless the current ACP shape as intentional: the ACP codec may create workflow deferred identities, poll `WorkflowEngine.deferredResult`, complete those deferreds when `PermissionResponse` input arrives, and translate the resulting decision into the protocol-level ACP `RequestPermissionResponse`. In this model the codec is not just observing/encoding protocol traffic; it owns the permission continuation authority for the live session.

**B. Strict observation + workflow-side resumption.** Treat codecs as protocol/session translators only. A codec may keep live protocol promises and correlation state required by the wire protocol, but it must not own durable permission state or complete workflow deferreds. Permission requests are normalized as observable output, permission responses enter as client/workflow input intents, and workflow-side runtime code owns any durable deferred creation/completion/resumption needed to bridge those two facts back to the live codec continuation.

### Coordinator recommendation (Gurdas decides)

Recommend **B: strict observation + workflow-side resumption**, with one important clarification: ACP still needs a live protocol continuation because `requestPermission` is an active ACP SDK promise. The recommended boundary is not "make ACP stateless"; it is "codec owns only the live ACP promise/correlation, while workflow/runtime owns durable authority and deferred completion."

This matches the existing codec README boundary rule that durable permission state belongs outside codecs, makes permission-class behavior analogous to the TFIND-041 by-decision precedent, and keeps the planned `permission-flow-pipeline` from encoding hidden codec-side durable authority as the production contract. If Gurdas chooses A instead, the follow-on work should explicitly update the codec boundary documentation and tests to say ACP permission authority is intentionally codec-side.

No code experiment appears necessary to answer §0 at the framing level: the current authority split is statically visible in the ACP codec and the stdio-jsonl codec. Implementation will still need a focused verification plan once Gurdas chooses A or B.

## §1 — Grounding from canonical FINDINGS

`packages/tiny-firegrid/FINDINGS.md:740-752` records TFIND-015 as open. The relevant production kernel is not merely that the toy lacks permission coverage; it is whether codec layers only translate protocol events, or whether any codec currently completes workflow deferreds / performs authority-like work for permission-class events. The recorded next action is a permission-flow configuration that observes permission requests through the per-context output channel and routes permission responses back as client input intents, "unless production chooses a different authority boundary."

`packages/tiny-firegrid/FINDINGS.md:1375-1436` records TFIND-041 as resolved by decision B on 2026-05-18. For `ToolUse`, Gurdas chose session/codec mode as the explicit authority axis rather than promoting execution authority onto the event itself: ACP is observation-only, stdio-jsonl is client-result roundtrip, and the shared `ToolUse` event deliberately remains under-discriminated by execution authority.

The TFIND-041 precedent is directly relevant but not automatically dispositive. Permission-class events have the same family shape because a normalized event can either carry authority semantics itself, defer interpretation to session mode, or route through workflow authority. The difference is that ACP permission handling currently reaches into `WorkflowEngine`/`DurableDeferred`, while TFIND-041's decided branch lives in workflow code that interprets a normalized `ToolUse` event by session mode.

## §2 — Current codec evidence

ACP currently advertises permission support and contains durable workflow machinery:

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

That creates the TFIND-015 conflict in concrete form: ACP implementation currently does durable-deferred work from inside the codec, while the documented codec contract says durable permission state is outside codecs.

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

This document is the deliverable for this PR. No production code is in scope. After coordinator review and Gurdas batched signoff:

- If A is chosen, update codec boundary documentation and implement the permission-flow pipeline against explicit codec-side authority.
- If B is chosen, move durable permission authority out of codec scope before or as part of the permission-flow pipeline, then test the public observe/respond/resume path.

Until then, `permission-flow-pipeline` remains gated by TFIND-015.
