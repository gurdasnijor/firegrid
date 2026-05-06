# Durable Webhook Subscribers Platform Affordances

Date: 2026-05-06

Source dispatch: `FC-DURABLE-WEBHOOK-SUBSCRIBERS`

## Purpose

This note assesses product-neutral Firegrid affordances for durable subscribers,
with webhook ingest as the concrete pressure test. The target is not a
Flamecast-specific webhook system. The target is a Firegrid substrate lane that
lets higher layers model inbound asynchronous delivery as durable records,
projection-backed waits, and replayable subscriber work without creating hidden
session input paths or product-specific row families in Firegrid core.

Inputs read:

- `docs/rfc/external/durable-stream-agent-plaform-rfc/outline.md`
- `internals/durable-log.md`
- `internals/projections-and-channels.md`
- `internals/runtime-and-operators.md`
- `internals/durable-state-awaitables-approvals-timers.md`
- `operating/restart-semantics.md`
- `operating/conformance.md`
- `coding/client-model.md`
- `reference/record-model.md`
- `reference/idempotency.md`
- `reference/abstract-interfaces.md`
- `docs/prds/PRD_FLAMECAST.md`
- prior packet under `docs/research/flamecast/2026-05-06-foundation-readiness/`

## Current Boundary

Firegrid already has the right broad public shapes for a minimal durable
async-ingest composition:

- `Operation` as the typed unit of durable work.
- `EventStream` as caller-owned typed event history.
- `EventPlane` as caller-owned typed state/event rows with producer and
  projection services.
- `RunWait`, `projectionMatch`, and projection-backed waits for handler
  suspension and wakeup.
- `Firegrid.composeRuntime`, `Firegrid.handler`, subscribers, and `run` for a
  Node runtime process.
- `client.observe(...)` exposing public `Pending`, `Completed`, `Failed`, and
  `Cancelled` operation states.

The gap is not "Firegrid should own webhooks." It is that durable subscriber
patterns need a small, product-neutral contract so webhook-like ingress,
queue-like ingress, callback-like ingress, and provider-push ingress all get the
same correctness guarantees around append acknowledgement, idempotency, replay,
ack/fail, dead-letter, and wait wakeup.

## Product-Neutral Primitives Firegrid Could Expose

### 1. Durable Inbound Delivery Channel

Firegrid could expose a helper pattern for an app-defined inbound delivery
channel over `EventPlane` or `EventStream`.

The helper should be generic over an application-owned schema. It should not
ship any built-in callback, provider, session, permission, or webhook event
types.

Minimum neutral shape:

```txt
delivery.received
delivery.accepted
delivery.rejected
delivery.claimed
delivery.completed
delivery.failed
delivery.dead_lettered
delivery.conflict
```

These names should be examples or local test fixtures, not Firegrid-native row
families. The actual row names remain product-owned. Firegrid can provide
helpers that operate over descriptors such as:

```txt
channel name
delivery key
producer identity
schema id
payload decoder
idempotency key extractor
sequence extractor, optional
ordering scope
completion key
terminal fold
dead-letter policy
```

For Flamecast, a provider callback could lower into this channel. For another
product, the same machinery could represent inbound GitHub events, customer
callbacks, queue messages, scheduled external work, or human approval replies.

### 2. Idempotent Ingest Append Helper

Firegrid can add a product-neutral append helper that wraps existing
`EventPlane` or `EventStream` emission with:

- producer identity,
- idempotency key,
- optional sequence,
- causation and correlation ids,
- schema id,
- conflict result,
- append cursor or equivalent acknowledgement.

This should be an ergonomic wrapper over durable record append. It should not be
a network endpoint, signature verifier, credential store, callback router, or
HTTP retry service.

The output should distinguish:

```txt
accepted
duplicate_same_payload
conflict_different_payload
invalid_payload
unauthorized_by_caller_policy
append_unavailable
```

`unauthorized_by_caller_policy` can be a generic result only if the caller
provides the policy decision. Firegrid should not know product auth rules.

### 3. Durable Subscriber Operator Profile

Firegrid can expose a small subscriber operator profile that formalizes the RFC
claimed-work lifecycle for asynchronous deliveries:

```txt
replay to live boundary
find eligible unclaimed delivery work
append claim
observe winning claim
execute caller-provided effect
append completion, failure, conflict, or dead-letter row
```

The shared helper owns mechanics only:

- replay/live barrier,
- claim append and observation,
- duplicate suppression,
- owner id and attempt number,
- optional lease or heartbeat fields,
- terminal append discipline,
- wakeup subscription,
- structured subscriber errors.

The product owns:

- eligibility,
- payload schema,
- auth and origin policy,
- semantic side effects,
- retry policy,
- dead-owner policy,
- terminal record schema,
- bridge decision from delivery to product operation.

This maps directly to the RFC split between generic claimed-work machinery and
domain operator semantics.

### 4. Durable Ack, Retry, and Dead-Letter Projection

Firegrid can provide a neutral projection recipe for delivery state:

```txt
received -> accepted | rejected
accepted -> claimed
claimed -> completed | failed | dead_lettered
accepted/failed -> retry_eligible, when policy says so
any terminal -> conflict side records may be recorded without changing winner
```

The projection should follow first-valid-terminal-wins. Later duplicate
terminals with the same semantic result are idempotent. Later conflicting
terminals are visible for audit but do not mutate the winning logical state.

This projection is useful even when the higher layer decides that a delivery is
intentionally complete without creating downstream work. Acking should mean "the
durable bridge decision is recorded", not "some live callback returned 200".

### 5. Replay and Live-Tail Subscriber Contract

Firegrid can document and test a replay/live-tail contract for generic durable
subscribers:

- start from a durable cursor or retained beginning,
- rebuild delivery projection,
- identify EOF/live boundary,
- avoid side effects during replay,
- subscribe after the live cursor,
- resume eligible work only after claim ownership is observed,
- fail with a retention-gap error when replay cannot prove correctness.

This complements current `RunWait` and projection-match semantics without
turning subscriber behavior into product workflow semantics.

### 6. Completion-Key Awaitable Helper

The RFC frames durable promises as wait record plus completion key plus
completion record. Firegrid can provide a neutral helper for delivery completion
keys:

```txt
completion key = channel:<channel-name>:delivery:<delivery-key>
```

The helper can compose with `RunWait` and `projectionMatch` so a handler can
wait for a delivery, a decision, or a downstream bridge result. The key format
should be configurable; Firegrid should not bake in session, prompt, provider,
or permission names.

## Delivery Semantics To Guarantee

### Append and Ack

The ingest path should acknowledge only after the durable append is accepted.
The acknowledgement should include a cursor, record id, or equivalent resume
token. If a batch is accepted partially, the result must identify the accepted
prefix and the error for the rest.

For webhook ingress specifically, the HTTP response belongs to the product
edge. The platform guarantee should be: the product can decide to return a
success response only after Firegrid accepted the durable delivery record.

### Idempotency

The channel contract should define:

- producer identity,
- idempotency key or sequence,
- dedupe scope,
- dedupe retention window,
- canonical payload comparison,
- duplicate result behavior,
- conflict result behavior.

Duplicate same payload should return the original append result or a stable
duplicate result. Duplicate different payload should surface a conflict and
must not silently append a second logical delivery under the same key.

Idempotency must exist at two levels:

- transport producer idempotency for append retries,
- domain idempotency for downstream product operations derived from the
  delivery.

Those keys are related but not interchangeable. A webhook delivery id is not
automatically a session, operation, approval, or prompt idempotency key.

### Sequence and Ordering

When producers provide sequence numbers, Firegrid can preserve them as metadata
and offer a fold helper that detects:

- next sequence,
- duplicate sequence with same payload,
- duplicate sequence with conflicting payload,
- out-of-order arrival,
- gap,
- producer reset or unknown sequence policy.

Append order remains authoritative inside the Firegrid log boundary. Producer
sequence is domain metadata that higher layers can use for gap detection or
provider ordering, not a replacement for cursor ordering.

### Claim Before Side Effect

Any subscriber that performs externally visible work must claim first, observe
its own winning claim, and only then execute. This includes bridges that convert
inbound deliveries into product operations.

The helper should make the correct flow easy:

```txt
delivery row exists
subscriber reaches live boundary
subscriber appends claim
subscriber observes winning claim
subscriber executes app bridge
subscriber appends terminal bridge result
```

During replay, the subscriber must not call product handlers, external services,
or downstream provider APIs.

### Ack, Fail, Retry

Ack/fail must be durable state, not a process-local return value. A subscriber
may mark a delivery complete only after the product side effect is durably
accepted or after the bridge intentionally decides no side effect should occur.

Retry policy should be product-supplied but platform-enforced mechanically:

- retryable failure remains eligible after backoff or timer completion,
- non-retryable failure is terminal,
- exhausted retry becomes dead-letter or terminal failure,
- takeover after dead owner requires a durable takeover/replacement claim.

### First Terminal Wins

Terminal-bearing delivery and bridge operations should use
first-valid-terminal-wins:

```txt
first valid terminal in log order wins
later identical terminal is duplicate evidence
later conflicting terminal is conflict evidence
invalid terminal does not resolve waits
```

This should apply to subscriber completion, downstream bridge completion, timer
firing/cancellation, and delivery dead-letter decisions.

### Replay and Live-Tail

Consumers need a no-gap path:

```txt
snapshot at cursor
evaluate terminal or pending state
subscribe after cursor
process changes in projection order
unsubscribe on completion, cancellation, timeout, or caller interruption
```

For a durable subscriber, this means replay-to-live before side effects. For a
client or handler waiting on inbound delivery, this means a completion that
arrived before subscription must resolve from snapshot.

### Dead-Letter and Conflict Visibility

Dead-letter and conflict rows must be queryable, replayable, and auditable.
They should not be logs only. A higher layer should be able to build operations
dashboards and repair flows from durable projections.

Suggested neutral result classes:

```txt
invalid_payload
producer_conflict
sequence_gap
auth_policy_rejected
handler_failed_retryable
handler_failed_terminal
retry_exhausted
dead_owner_blocked
```

These are platform-neutral classes. Product-specific errors can live in an
opaque or schema-owned payload field.

### Producer Identity

Every accepted delivery record should carry a producer identity. The identity
can be an app-defined principal, endpoint id, token id, integration id, or
runtime id. Firegrid should preserve the string/opaque identity and use it in
dedupe scope, conflict reporting, and audit. It should not define how the
identity was authenticated.

## What Stays Flamecast-Owned

The following must remain in Flamecast or its provider/runtime product layer:

- HTTP callback endpoints and route names.
- Standard Webhooks signing for outbound callbacks.
- Provider callback token minting, rotation, storage, and validation.
- Provider callback request schema, including `sequence` and normalized Event
  payloads.
- `callbackUrl`, `callbackEvents`, filtering, fanout, retries to customer
  destinations, and outbound webhook delivery policy.
- Provider manifest, provider check, provider auth, provider options, BYOK,
  WorkOS/API-key auth, and tenant authorization.
- Provider-specific ordering semantics and gap policy.
- Normalized agent event taxonomy such as user message, assistant message,
  tool call, tool result, permission required, status done/error/cancelled, and
  usage fields.
- Session steering, permission decision, cancel/delete semantics, and how those
  become provider API calls.
- Capability, contributor, sandbox, browser, MCP, skill, benchmark, SDK, UI,
  billing, and comparison-page semantics.
- Mapping from inbound delivery to product operation, including whether a
  provider event becomes event history, an approval wait, a session terminal, a
  warning, or a compatibility error.

Firegrid can carry these as opaque app-owned inputs, state rows, event stream
events, operation payloads, and wait predicates. Firegrid should not name them
as core concepts.

## Other Product-Neutral Platform Unlocks

### Typed EventPlane To EventStream Bridge

Many products need both state rows and chronological user-visible history.
Firegrid can provide a neutral bridge helper that materializes selected
EventPlane rows into an EventStream with:

- decoder boundary,
- source cursor,
- emitted event id,
- idempotency key,
- causation id,
- conflict behavior,
- replay-safe materialization.

The bridge must remain descriptor-driven. It should not know Flamecast event
types.

### Durable Wait Recipes For External Decisions

Firegrid can ship examples or helpers for:

- inbound delivery wakes a `RunWait` projection match,
- timer fires and terminalizes a pending delivery,
- external decision row resolves a handler suspension,
- cancel row races with success/failure using first-terminal-wins.

These are product-neutral durable wait recipes. They should avoid the word
"session" except inside examples.

### Reconnect and Replay Posture For Clients

Firegrid can clarify client behavior for long-lived operations:

- observe returns current durable state before live updates,
- event reads can replay history and then live-tail,
- `Pending` is an operation lifecycle state, not proof of a specific product
  blocked reason,
- products expose detailed blocked/waiting causes through their own
  EventPlane/EventStream projections.

This keeps `client.observe(...)->Pending` useful without pressuring Firegrid to
adopt product-specific blocked states.

### Runtime Locality and Subscriber Packaging

Firegrid can document that runtime subscribers are Node-tier runtime processes
composed with `Firegrid.composeRuntime` and `run`. Browser and edge code should
use client surfaces and product-owned ingress endpoints. This prevents durable
subscriber work from being mistaken for browser-safe logic.

### Conformance Tests For Durable Subscribers

A product-neutral test family would make this lane concrete:

- append returns stable acknowledgement,
- duplicate append returns duplicate or conflict,
- sequence gap is projected,
- subscriber reaches live boundary before side effect,
- claim-lost subscriber does not execute,
- side effects do not run during replay,
- terminal winner is stable under duplicate/conflicting terminals,
- completion before wait resolves from snapshot,
- dead-letter rows are projected,
- retention gap fails loudly.

## Recommended Spec Lanes

### Firegrid Lane 1: Durable Inbound Channel Helper

Scope:

- product-neutral descriptor for inbound delivery rows,
- typed append helper over EventPlane/EventStream,
- producer identity and idempotency metadata,
- append result taxonomy,
- conflict projection recipe,
- examples using generic names like `delivery` and `channel`.

Anti-scope:

- no HTTP endpoint,
- no Standard Webhooks,
- no callback URL minting,
- no provider event schema,
- no product route names,
- no Flamecast event union,
- no credential or tenant auth policy.

### Firegrid Lane 2: Durable Subscriber Operator Profile

Scope:

- reusable claimed-work subscriber mechanics,
- replay/live boundary,
- claim before side effect,
- owner id and attempt number,
- optional lease/heartbeat fields,
- terminal append discipline,
- dead-letter and conflict projection hooks,
- conformance tests.

Anti-scope:

- no domain retry policy baked into Firegrid,
- no provider lifecycle management,
- no sandbox or browser process lifecycle,
- no hidden mailbox-to-operation bridge,
- no direct product side-effect implementation.

### Firegrid Lane 3: External Completion and Wait Recipe

Scope:

- completion-key helper,
- `RunWait` plus projection-match recipe,
- snapshot-first external completion,
- first-terminal-wins race recipe,
- cancel-as-product-control-row example,
- EventPlane to EventStream materialization example.

Anti-scope:

- no new Firegrid-native approval, permission, session, tool, or provider row
  families,
- no public blocked-state taxonomy tied to agent products,
- no direct durable terminal-row authorship API for app code that bypasses
  typed handler return or product-owned rows.

### Flamecast Lane 1: Provider Callback Ingest Spec

Scope:

- callback route,
- provider callback token,
- request schema,
- sequence policy,
- idempotency key,
- provider identity,
- normalized event mapping,
- storage into Flamecast-owned event history,
- error and conflict behavior.

Firegrid dependency:

- can use Durable Inbound Channel Helper once available.

### Flamecast Lane 2: Webhook Fanout and CallbackEvents Spec

Scope:

- `callbackUrl`,
- `callbackEvents`,
- Standard Webhooks signing,
- outbound retry/backoff,
- customer dead-letter,
- event filtering,
- tenant authorization and audit.

Firegrid dependency:

- Firegrid can provide durable delivery mechanics and projection state, but
  signing, fanout, endpoint policy, and product event taxonomy stay Flamecast.

### Flamecast Lane 3: Bridge From Provider Delivery To Session Operation

Scope:

- explicit mapping from provider callback to Flamecast session/event/control
  state,
- downstream operation idempotency key distinct from delivery id,
- permission and steering decisions,
- cancel/terminal races,
- dead-owner and restart decisions for in-flight callbacks.

Firegrid dependency:

- can compose `Operation`, `EventStream`, `EventPlane`, `RunWait`, and runtime
  subscribers with product-owned schemas.

## Smallest Proof To De-Risk The Lane

A spec-only Firegrid proof can stay product-neutral:

1. Define a toy `delivery` EventPlane with `received`, `claimed`, `completed`,
   `failed`, `dead_lettered`, and `conflict` rows.
2. Append a delivery with producer identity and idempotency metadata.
3. Run a subscriber that replays to live, claims the delivery, writes a generic
   product-owned EventStream event, and appends completion.
4. Prove duplicate same payload does not produce a second logical delivery.
5. Prove duplicate conflicting payload projects a conflict.
6. Prove a `RunWait` projection match wakes when the completion row exists,
   including the case where completion is already present before the wait
   subscribes.
7. Prove restart replay does not execute the subscriber side effect twice.

This proof should not mention Flamecast in code, package names, descriptors, or
feature ACIDs. Flamecast can later consume the pattern with its own provider
callback schema.

## Bottom Line

Durable webhook ingest is best treated as one instance of a broader durable
inbound subscriber pattern. Firegrid should add product-neutral affordances for
typed delivery append, idempotency/conflict handling, replay-safe subscriber
claims, durable completion, dead-letter projection, and `RunWait` wakeup.

Flamecast should own webhook signing, callback schemas, provider semantics,
event normalization, session steering, callback filtering, credentials, and
fanout. This split makes Flamecast-on-Firegrid more ergonomic without leaking
Flamecast, Fireline, or Firepixel product semantics into Firegrid core.
