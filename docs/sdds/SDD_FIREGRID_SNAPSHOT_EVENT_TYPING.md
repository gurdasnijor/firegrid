# SDD: Snapshot Agent-Output Event Typing

Status: draft — framing for coordinator/Gurdas signoff, NO production code
Created: 2026-05-17
Owner: Firegrid Client SDK (sidecar `sidecar/snapshot-event-typing`)

Resolves: Beads DB (`bv --robot-triage`, join key `tfind:030`) → "Snapshot
agent output events are typed as records, not protocol unions."

Governing spec (decisive): `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
("Client Read Binding" — already prescribes the target contract below).

Related code (verified):

- `packages/protocol/src/session-facade/schema.ts` —
  `RuntimeAgentOutputEventPayloadSchema` (`Schema.Record`),
  `RuntimeAgentOutputObservationSchema.event`,
  `decodeRuntimeAgentOutputEnvelope`, `runtimeAgentOutputObservationFromRow`
- `packages/runtime/src/agent-event-pipeline/events/contract.ts:122` —
  `AgentOutputEventSchema` (the canonical discriminated union, runtime-owned)
- `packages/runtime/src/agent-event-pipeline/events/output.ts` — a *parallel*
  envelope decoder that already decodes `event: AgentOutputEventSchema`
- `packages/client-sdk/src/firegrid.ts` — `RuntimeContextSnapshot.agentOutputs`

---

## 1. The gap is real (verified, not discoverability)

- `session.snapshot().agentOutputs[].event` is typed
  `RuntimeAgentOutputEventPayload = Schema.Record({ key: String, value: Unknown })`
  → `Record<string, unknown>`. Client code must cast/`isRecord`-check to
  branch on `_tag`.
- The canonical discriminated `AgentOutputEventSchema` / `AgentOutputEvent`
  union (`Ready | TextChunk | ToolUse | PermissionRequest | TurnComplete |
  Status | Error | Terminated`) lives in **`@firegrid/runtime`**
  (`agent-event-pipeline/events/contract.ts`).
- `@firegrid/client-sdk` imports **nothing** from `@firegrid/runtime` and must
  not (browser-safe / runtime-source-free — `SDD_..._SESSION_FACT_CLIENT_SURFACES`
  goal 5; `@firegrid/protocol` has no runtime dependency either, verified).
- The protocol decode path `runtimeAgentOutputObservationFromRow` →
  `decodeRuntimeAgentOutputEnvelope` parses `event` **only** as a `Record` and
  checks `typeof event["_tag"] === "string"`. It does **not** parse against the
  union. Only observation-level optional fields for `PermissionRequest`/`ToolUse`
  are narrowed; `.event` itself stays a `Record`.
- There are **two divergent envelope decoders**: runtime's
  (`events/output.ts`, `event: AgentOutputEventSchema` — typed) and protocol's
  (`session-facade/schema.ts`, `event: RuntimeAgentOutputEventPayloadSchema` —
  `Record`). The client uses the protocol (lossy) one.

## 2. This is architectural, not a client-side type tighten

The coordinator's stop-condition ("if it needs a protocol/schema change rather
than a client-side type tighten, that's architectural — SDD + framing-gate")
is met:

1. **Ownership.** Exposing the union from client-sdk requires a
   **protocol-owned** `AgentOutputEvent` union (protocol cannot import the
   runtime-owned one without inverting the package graph). That is a
   cross-package schema-ownership change, not a client annotation.
2. **Soundness (the explicit instruction: "verify the decode path actually
   yields that union, don't just assert the type").** Tightening only the
   TypeScript type while the decode still yields a `Record` would be a phantom
   type — the same unsound pattern rejected in TFIND-029. A sound fix must
   change the **protocol decode contract** so the envelope parses against the
   union. That changes runtime-observable behavior: events that do not conform
   to the union are currently accepted as opaque `Record`s (and
   `runtimeAgentOutputObservationFromRow` returns them); under a union parse
   they become `Option.none()` / decode errors. Blast radius includes
   `wait.forAgentOutput`/`forPermissionRequest` predicates and observation
   derivation.
3. **Governing spec already prescribes the target**, and the current code
   diverges from it. `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` → "Client
   Read Binding" states the protocol-owned contract is
   `RuntimeAgentOutputObservationSchema { … event: AgentOutputEventSchema }`
   and that no product app should run
   `Schema.decodeUnknownEither(AgentOutputEventSchema)(parsed.event)` itself.
   So this is not a fresh design — it is closing a divergence from an
   already-approved contract. The open *decisions* are ownership mechanism and
   the decode-behavior change, which that SDD does not pin.

## 3. Options (the narrow question — do NOT pre-commit to the biggest reshape)

- **(A) Relocate the union to protocol (canonical move).** Move
  `AgentOutputEventSchema` (and its part sub-schemas:
  `AgentTextDeltaPartSchema`, `AgentToolCallPartSchema`, `PermissionOptionSchema`,
  `StopReasonSchema`, `AgentCapabilitiesSchema`) into `@firegrid/protocol`;
  `@firegrid/runtime` re-exports for back-compat. Single source of truth,
  matches the projection-contract SDD. Largest blast radius (every runtime
  codec/import), but the *correct* end-state.
- **(B) Protocol-owned canonical union, runtime re-points to it.** Same as (A)
  but framed as "protocol is the SSOT; runtime becomes a consumer" —
  emphasizes the ownership decision for signoff.
- **(C) Smallest sound down-payment.** Define the protocol-owned union schema
  and switch **only** the protocol envelope/observation decode + the
  client-sdk snapshot type to it; leave runtime's own `events/output.ts`
  decoder untouched for now (it already yields the union). Defers full SSOT
  consolidation (the two decoders remain, tracked) but makes
  `session.snapshot().agentOutputs[].event` soundly the union with minimal
  blast radius. Risk: temporary duplicate union definitions until a follow-up
  consolidates — must be a *deliberate* tracked dependent, not a bridge.
- **(D) Reject / defer.** Keep `Record`; document client-side narrowing as
  intended. Contradicts the projection-contract SDD; least preferred.

Recommendation: **end-state (A)/(B)** is the SDD-sanctioned SSOT; **down-payment
(C)** is the smallest sound step that resolves TFIND-030's client-facing
symptom without committing the whole runtime-codec migration in one PR. I am
**not** pre-committing — the ownership mechanism and the decode-behavior change
(reject vs. pass-through for non-conforming events) are coordinator/Gurdas
calls.

## 4. Narrow questions for signoff

- **Q1 — ownership mechanism:** relocate `AgentOutputEvent` union to protocol
  with runtime re-export (A/B), or protocol-owned canonical with a tracked
  runtime consolidation follow-up (C down-payment)?
- **Q2 — decode-behavior change:** when a stored `firegrid.agent-output`
  envelope's `event` does **not** conform to the union, should the protocol
  decode now reject it (`Option.none()` — strict, surfaces producer bugs) or
  retain a permissive fallback? This changes `snapshot()`/`wait` observable
  behavior and needs an explicit decision before code.

## 5. Adjacent findings (coordinator → Beads DB, not this PR)

- Two divergent `RuntimeAgentOutputEnvelopeSchema`/`decodeRuntimeAgentOutputEnvelope`
  definitions (runtime typed vs. protocol `Record`) are a latent SSOT
  violation independent of TFIND-030; consolidation is the natural home for
  the deferred half of option (C).

## 6. Acceptance gate

This document is the deliverable. No production code until Q1+Q2 are answered.
On signoff the implementation lands on `sidecar/snapshot-event-typing` scoped
to the chosen option, verified: typecheck client-sdk + protocol + dependents,
full `pnpm run lint`, affected tests (incl. a decode-path test proving the
union is actually yielded, not just typed). Beads DB updates are
coordinator-owned.
