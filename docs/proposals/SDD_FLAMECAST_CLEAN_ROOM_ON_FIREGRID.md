# SDD: Flamecast Clean-Room Runtime on Firegrid

Date: 2026-05-07

Status: Proposal, docs-only

Scope: A clean-room subset of Flamecast implemented on Firegrid's Durable
Streams substrate, `@effect/workflow`, and product-owned provider adapters.

Non-scope: Porting the existing Flamecast implementation, adding Firegrid HTTP
endpoints, inventing Firegrid product schemas, or introducing generic queue
concepts that are not present in the Flamecast provider data model.

## Purpose

This document resets `apps/flamecast` around Flamecast's actual product
contract:

- `AgentSpec` and provider metadata are Flamecast-owned;
- provider session APIs are Flamecast-owned;
- provider webhook deliveries are Flamecast-owned;
- the normalized session event union is Flamecast-owned;
- callback URL, callback events, signing, and token policy are Flamecast-owned;
- Firegrid provides the durable stream, workflow, replay, projection, and
  recovery mechanics underneath those product facts.

The central invariant from the RFC still applies:

```txt
The durable log is the source of truth.
```

The practical rule for this app is narrower:

```txt
Every provider-visible or user-visible Flamecast fact is durable as a
Flamecast row. Runtime handles, SDK clients, HTTP request handlers, process ids,
fibers, sockets, and provider streams are live resources only.
```

## Authority

Design authority comes from:

- `flamecast-product-contract.AGENTSPEC.*`
- `flamecast-product-contract.SESSIONS_API.*`
- `flamecast-product-contract.PROVIDER_API.*`
- `flamecast-product-contract.EVENTS.*`
- `flamecast-product-contract.CALLBACKS.*`
- `flamecast-product-contract.LOWERING.*`
- `workflow-engine-durable-state.*`
- `stream-first-substrate-simplification.STREAMDB_STATE.*`
- `firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.*`

The RFC's session and adapter sections remain useful, but this proposal should
not expose RFC infrastructure vocabulary as the Flamecast app model unless the
provider contract already has that concept.

## Design Decisions

### Firegrid ingress is `DURABLE_STREAMS_URL`

Firegrid does not host Flamecast HTTP routes. The only Firegrid-facing ingress
is a Durable Streams URL selected by the product.

Examples:

```txt
DURABLE_STREAMS_URL=...
flamecast/providers/<providerId>/sessions/<sessionId>
flamecast/provider-webhooks/<subscriberId>
flamecast/customer-callbacks/<orgId>
```

If an external provider needs to POST a webhook, product edge code owns that
HTTP route, authentication, token verification, provider payload validation,
and the append of a Flamecast-owned delivery row to the stream URL. Firegrid
begins after the durable append.

### Provider rows are the product model

Do not introduce generic intent/claim/terminal row families in the first
Flamecast slice. Those are useful substrate/RFC concepts, but they are not the
provider data model we need to prove.

The first durable model should stay close to Flamecast's provider/session/event
surface:

```txt
agent session create requested
provider session created
provider session failed
provider event delivery accepted
provider event normalized
normalized session event appended
session summary updated by projection
provider cancel requested
provider cancel completed or failed
customer callback delivery requested
customer callback delivery completed or failed
```

### Workflows process provider facts

Workflows are still the right execution mechanism, but their payloads should be
Flamecast provider facts, not invented infrastructure jobs.

Good workflow declarations:

```txt
ProviderSessionCreateWorkflow(payload = SessionCreateRequested)
ProviderEventDeliveryWorkflow(payload = ProviderEventDelivery)
CustomerCallbackWorkflow(payload = CallbackDeliveryRequested)
ProviderCancelWorkflow(payload = SessionCancelRequested)
```

Avoid:

```txt
Workflow(payload = generic intent)
Workflow(payload = generic delivery)
TurnProcessorWorkflow(payload = mutable turn row)
```

Activities are the live side-effect boundaries: call a provider SDK, normalize
provider payloads, append normalized Flamecast events, or deliver a customer
callback.

### Projections are derived from provider facts

The browser wants sessions, timelines, and status. Those are projections over
durable Flamecast rows:

```txt
session list = session rows + normalized events + terminal events
session timeline = normalized events ordered by provider sequence / stream order
provider delivery state = accepted delivery + normalized/failed result rows
callback state = requested callback + delivery terminal rows
```

Projection rows may exist for speed, but they are not authority. If the retained
durable rows are replayed through the same fold version, the same session state
and timeline must be derivable.

### StreamDB actions are the write boundary

Product writes should use `createStreamDB` actions with transaction ids and
`awaitTxId` confirmation. Avoid Firegrid-specific append wrappers in the
application examples.

This app should look like Durable Streams State plus product workflows, not a
new Firegrid product framework.

## First Durable State Shape

The first app state should be boring and provider-shaped.

| Collection | Key | Source | Purpose |
| --- | --- | --- | --- |
| `sessionRequests` | `sessionId` | Flamecast client/API | Durable record of a requested agent session. |
| `providerSessions` | `sessionId` | provider session workflow | Provider identity, provider session id, status, adapter metadata. |
| `providerEventDeliveries` | `deliveryId` | product webhook edge or stream producer | Raw accepted provider callback delivery with auth/sequence evidence. |
| `sessionEvents` | `eventId` | provider event workflow or SDK adapter | Normalized Flamecast session events ordered by `sessionId` and `sequence`. |
| `sessionTerminals` | `sessionId` | provider workflow/adapter | First valid terminal session result. |
| `callbackDeliveries` | `callbackDeliveryId` | terminal/session projection subscriber | Customer callback delivery intents and outcomes. |

This preserves the Flamecast product boundary:

- provider payloads remain product-owned;
- normalized event union remains product-owned;
- Firegrid does not gain a provider or event taxonomy;
- workflow engine rows remain private runtime coordination.

## Schema Example

This is illustrative, not a final API.

```ts
import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

const AgentProviderRef = Schema.Literal(
  "think",
  "anthropic-managed",
  "cursor",
  "devin",
  "factory-droid",
  "openhands",
  "jules",
  "flamecast-agents",
)

const SessionStatus = Schema.Literal(
  "creating",
  "running",
  "complete",
  "failed",
  "cancelled",
)

const SessionCreateRequested = Schema.Struct({
  sessionId: Schema.String,
  provider: AgentProviderRef,
  model: Schema.optional(Schema.String),
  input: Schema.Unknown,
  permissions: Schema.Unknown,
  metadata: Schema.optional(Schema.Unknown),
  callbackUrl: Schema.optional(Schema.String),
  callbackEvents: Schema.optional(Schema.Array(Schema.String)),
  requestedAt: Schema.String,
})

const ProviderSession = Schema.Struct({
  sessionId: Schema.String,
  provider: AgentProviderRef,
  providerSessionId: Schema.optional(Schema.String),
  status: SessionStatus,
  providerState: Schema.optional(Schema.Unknown),
  updatedAt: Schema.String,
})

const NormalizedSessionEvent = Schema.Struct({
  eventId: Schema.String,
  sessionId: Schema.String,
  sequence: Schema.Number,
  type: Schema.Literal(
    "user_message",
    "assistant_message",
    "thinking",
    "tool_call",
    "tool_result",
    "step_finish",
    "turn_started",
    "turn_complete",
    "warning",
    "error",
  ),
  event: Schema.Unknown,
  provider: AgentProviderRef,
  providerEventId: Schema.optional(Schema.String),
  emittedAt: Schema.String,
})

const ProviderEventDelivery = Schema.Struct({
  deliveryId: Schema.String,
  sessionId: Schema.String,
  provider: AgentProviderRef,
  providerSequence: Schema.Number,
  providerEventId: Schema.optional(Schema.String),
  rawEvent: Schema.Unknown,
  authContext: Schema.Unknown,
  receivedAt: Schema.String,
})

const SessionTerminal = Schema.Struct({
  sessionId: Schema.String,
  status: Schema.Literal("complete", "failed", "cancelled"),
  reason: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Unknown),
  completedAt: Schema.String,
  causationId: Schema.String,
})

export const flamecastState = createStateSchema({
  sessionRequests: {
    type: "flamecast.session_requested",
    primaryKey: "sessionId",
    schema: Schema.standardSchemaV1(SessionCreateRequested),
  },
  providerSessions: {
    type: "flamecast.provider_session",
    primaryKey: "sessionId",
    schema: Schema.standardSchemaV1(ProviderSession),
  },
  providerEventDeliveries: {
    type: "flamecast.provider_event_delivery",
    primaryKey: "deliveryId",
    schema: Schema.standardSchemaV1(ProviderEventDelivery),
  },
  sessionEvents: {
    type: "flamecast.session_event",
    primaryKey: "eventId",
    schema: Schema.standardSchemaV1(NormalizedSessionEvent),
  },
  sessionTerminals: {
    type: "flamecast.session_terminal",
    primaryKey: "sessionId",
    schema: Schema.standardSchemaV1(SessionTerminal),
  },
})
```

The exact field names can change. The important part is that the rows are
recognizable Flamecast provider/session/event facts.

## Provider Webhook Workflow

Provider webhook ingestion is the first place this model should land because it
matches the product data model directly.

```ts
import { Activity, Workflow } from "@effect/workflow"
import { Effect, Schema } from "effect"

class ProviderDeliveryRejected extends Schema.TaggedError<ProviderDeliveryRejected>()(
  "ProviderDeliveryRejected",
  {
    deliveryId: Schema.String,
    reason: Schema.String,
  },
) {}

export const ProviderWebhookWorkflow = Workflow.make({
  name: "flamecast.provider_webhook",
  payload: ProviderEventDelivery,
  success: Schema.Void,
  error: ProviderDeliveryRejected,
  idempotencyKey: (delivery) => delivery.deliveryId,
})

export const NormalizeAndPersistProviderEvent = Activity.make({
  name: "flamecast.provider_webhook.normalize_and_persist",
  success: Schema.Void,
  error: ProviderDeliveryRejected,
  execute: Effect.gen(function* () {
    const delivery = yield* CurrentProviderDelivery
    const normalized = yield* ProviderNormalizer.normalize(delivery)

    // One StreamDB transaction should persist the normalized event and any
    // terminal/session update derived from the same provider delivery.
    yield* FlamecastDb.appendProviderEvent({
      delivery,
      normalized,
    })
  }),
})

export const ProviderWebhookWorkflowLayer = ProviderWebhookWorkflow.toLayer(
  Effect.fn(function* (delivery) {
    yield* NormalizeAndPersistProviderEvent.pipe(
      Effect.provideService(CurrentProviderDelivery, delivery),
    )
  }),
)
```

This uses workflow idempotency for replay and activity result reuse, but the
product-visible outcome is still the normalized Flamecast event row. The
workflow is not the data model.

## Provider Session Workflow

Session creation should also stay provider-shaped.

```ts
export const ProviderSessionCreateWorkflow = Workflow.make({
  name: "flamecast.provider_session.create",
  payload: SessionCreateRequested,
  success: ProviderSession,
  error: ProviderSessionCreateFailed,
  idempotencyKey: (request) => request.sessionId,
})

export const CreateProviderSession = Activity.make({
  name: "flamecast.provider_session.create_activity",
  success: ProviderSession,
  error: ProviderSessionCreateFailed,
  execute: Effect.gen(function* () {
    const request = yield* CurrentSessionCreateRequest
    const adapter = yield* ProviderAdapterRegistry.adapterFor(request.provider)
    const providerSession = yield* adapter.createSession(request)
    yield* FlamecastDb.persistProviderSession(providerSession)
    return providerSession
  }),
})
```

For Claude or another SDK-backed provider, the SDK client and streaming handle
are live resources. The durable rows are `ProviderSession`,
`NormalizedSessionEvent`, and `SessionTerminal`.

## Normalization Rules

The normalized event union is the primary product surface for history and UI.
Provider adapters lower raw provider updates into that union.

Rules:

- preserve provider sequence or provider event id when available;
- assign Flamecast sequence monotonically per session;
- order by durable append/projection cursor when provider timestamps disagree;
- do not fabricate tool-level events for opaque providers;
- append exactly one winning terminal per session under first-valid-terminal
  projection semantics;
- retain rejected/conflicting provider deliveries as durable evidence if they
  affect replay, audit, or debugging.

Example materializer:

```ts
export const materializeSessionTimeline = (
  events: ReadonlyArray<NormalizedSessionEvent>,
): ReadonlyArray<SessionEvent> =>
  events
    .sort((left, right) =>
      left.sequence === right.sequence
        ? left.eventId.localeCompare(right.eventId)
        : left.sequence - right.sequence
    )
    .map((row) => row.event as SessionEvent)
```

## Customer Callback Delivery

Customer callbacks are downstream side effects from durable Flamecast state.
They are not an internal signaling mechanism.

Input fact:

```txt
session terminal event or permission required event
  -> callbackEvents filter
  -> callback delivery requested row
  -> CustomerCallbackWorkflow
  -> callback delivery completed / failed / dead-letter row
```

Firegrid owns workflow replay and durable activity state. Flamecast owns:

- callback URL;
- callback token policy;
- Standard Webhooks signing;
- payload shape;
- `callbackEvents` filtering;
- customer-visible delivery success rules.

## What Must Change in `apps/flamecast`

Treat the current app as a demo, not the reference.

Replace:

- mutable `turns`, `messages`, `sessions`, and `agentWebhooks` as authority;
- deterministic assistant replies as a product proof;
- `processSubmittedTurns`;
- `pendingAgentsWebhooks`;
- `waitForFlamecastChange`;
- `runFlamecastProcessor`;
- any generic delivery, intent, or queue abstraction that hides provider facts.

With:

- provider-shaped durable rows;
- top-level provider workflows and activities;
- StreamDB actions as the only product write boundary;
- pure materializers for session list, session detail, provider delivery state,
  and callback delivery state;
- direct stream-url ingress for provider deliveries;
- SDK adapters that emit normalized Flamecast events.

## Build Plan

1. Replace the app state schema with provider-shaped rows.

   Start with `SessionCreateRequested`, `ProviderSession`,
   `ProviderEventDelivery`, `NormalizedSessionEvent`, `SessionTerminal`, and
   callback delivery rows if the slice needs customer callbacks.

2. Add pure materializers.

   Prove session list, session detail, ordered history, terminal status, and
   provider delivery status from durable rows only.

3. Implement provider webhook ingestion over `DURABLE_STREAMS_URL`.

   A test should append a `ProviderEventDelivery` row, execute
   `ProviderWebhookWorkflow`, and assert that normalized session events and
   session terminal state are durable and rebuildable.

4. Implement provider session creation with a test adapter.

   The test adapter should use the same `ProviderAdapter` interface intended
   for Claude. It should not introduce a different data model.

5. Swap the test adapter for the Anthropic TypeScript SDK.

   Keep the SDK behind the provider adapter. Every user-visible provider update
   becomes a durable normalized event.

6. Add customer callback workflow only after terminal events are durable.

   Callback delivery is a downstream workflow over Flamecast terminal or
   permission events, not internal status signaling.

## Acceptance Bar

The next implementation is acceptable only if:

- the main rows are Flamecast provider/session/event facts;
- Firegrid exposes no Flamecast HTTP surface;
- ingress is append to configured Durable Streams URLs;
- workflows consume provider facts and run provider activities;
- session timelines and summaries rebuild from normalized event rows;
- mutable projection rows are not the only proof of state;
- opaque provider output is not upgraded into fake tool events;
- the implementation does not introduce generic queue concepts unless a
  provider contract explicitly requires them.
