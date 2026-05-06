# SDD: Durable Webhook Subscribers

Date: 2026-05-06

Status: Proposal, docs-only

Scope: Firegrid product-neutral substrate/runtime/client affordances for durable
subscribers and webhook-style channels.

Non-scope: Flamecast, Fireline, Firepixel, provider, session, permission,
capability, credential, sandbox, browser, SDK, billing, or webhook product
semantics in Firegrid core.

## Purpose

Firegrid already exposes the durable building blocks that higher-layer agent
runtimes need: typed `Operation` descriptors, caller-owned `EventStream`
history, caller-owned `EventPlane` rows, `RunWait`/projection-match waits, and
runtime composition through `Firegrid.composeRuntime` and `run`.

The missing affordance is a product-neutral durable subscriber shape. Agent
runtime products need to ingest asynchronous external facts, deliver selected
facts to external endpoints, and wake long-running work without relying on
process-local queues, hidden callbacks, or open provider streams. Webhook ingest
and delivery are the forcing functions, but the platform primitive should be
"durable inbound/outbound delivery channel" rather than "Flamecast webhook" or
"Fireline webhook".

This SDD proposes small additive Firegrid surfaces that let applications define
their own delivery schemas while Firegrid supplies reusable mechanics:

- validated durable append;
- producer and subscriber identity;
- idempotency and conflict reporting;
- cursor acknowledgement;
- replay/live-tail discipline;
- claim-before-side-effect subscriber execution;
- retry/backoff classification;
- durable completion rows;
- first-terminal-wins folds;
- dead-letter projection;
- runtime presence lookup for ingress endpoint selection;
- `RunWait` wakeup recipes.

The target delivery guarantee is durable at-least-once with idempotent,
claim-narrowed execution. Firegrid can make duplicate execution observable,
bounded, and recoverable, but it must not claim exactly-once external side
effects unless the app-owned side-effect target participates with idempotency or
fencing.

## Architecture Fit

The RFC principle is that durable ordered facts are truth; projections,
subscribers, live resources, and adapters are derived machinery. Durable
subscriber channels fit Firegrid as mechanics over existing public surfaces:

| Plane | Proposed role |
| --- | --- |
| `@firegrid/client` | App and edge code append app-owned delivery facts and observe product-owned operation/event state. |
| `@firegrid/substrate` | Product-neutral descriptors, completion keys, wait helpers, projection queries, claim mechanics, and conformance test helpers. |
| `@firegrid/substrate/event-plane` | App-owned delivery, completion, cursor, conflict, and dead-letter row families. |
| `@firegrid/runtime` | Node-tier subscriber layers and runtime presence records composed with handlers and providers through `Firegrid.composeRuntime`. |
| `EventStream` | Chronological product event history and delivery audit materialized from app-owned rows when desired. |
| `RunWait` | Handler suspension until a delivery/completion/control projection matches. |

No Firegrid package should gain product row families such as provider callback,
session event, permission required, tool result, callbackEvents, Standard
Webhooks, or webhook signing. Firegrid can ship generic examples using names
like `delivery`, `channel`, `completion`, `cursor`, and `deadLetter`.

## Lessons From Fireline `webhook_subscriber.rs`

The Fireline implementation is useful as design reference, not as a vocabulary
source for Firegrid. The following lessons should be retained in neutral form.

### Selectors

Fireline filters source envelopes using selectors. The generic lesson is that a
subscriber must declare an explicit predicate over durable facts before it
performs any side effect.

Firegrid implication:

- subscriber descriptors should accept an app-owned selector or projection query;
- selector misses are observable skip outcomes, not errors;
- selectors must be deterministic over retained durable rows.

### Completion Keys

Fireline refuses webhook delivery for events without a canonical completion key.
The generic lesson is that every subscriber side effect that can complete once
needs a stable semantic key.

Firegrid implication:

- delivery subscribers need a configurable completion key derivation;
- completion keys are product-owned branded values, not Firegrid
  session/prompt/tool concepts;
- completion records must resolve waits by key and follow first-terminal-wins.

Example neutral key shape:

```txt
channel:<channel-name>:delivery:<delivery-key>
```

The exact keyspace stays app-owned.

### Cursor Store

Fireline stores a cursor per target and skips events whose source offset has
already been acknowledged. The generic lesson is that subscriber progress is
durable state, not process memory.

Firegrid implication:

- subscribers need a durable cursor acknowledgement row or projection;
- cursor acknowledgement must include subscriber identity and source cursor;
- cursor catch-up and live-tail must fail loudly on retention gaps;
- cursor state is a projection/index over durable rows, not alternate truth.

Cursor acknowledgement should never be the only proof of product completion.
For side effects that can complete once, completion and conflict rows remain the
semantic truth.

### Retry and Backoff

Fireline retries transient outcomes with a bounded retry policy and records a
dead letter after budget exhaustion. The generic lesson is that retries are
subscriber policy, but retry state and exhaustion must be durable.

Firegrid implication:

- the runtime helper can supply retry/backoff mechanics;
- the app supplies outcome classification and an Effect `Schedule`;
- retry attempts should include subscriber id, delivery key, attempt number,
  source cursor, and causation id;
- retry exhaustion must append a durable terminal or dead-letter row.

### Transient Versus Terminal HTTP Outcomes

Fireline treats network errors, HTTP 408, HTTP 429, and 5xx as transient; other
non-2xx responses are terminal. The generic lesson is that transport outcome
classification belongs at the channel edge and must be explicit.

Firegrid implication:

- Firegrid may provide generic expected-error types for retryable and terminal
  failures;
- HTTP-specific classifiers can live in examples or optional helpers only if
  they do not own product auth, signing, routing, or payload schema;
- applications can replace the classifier for queues, provider callbacks,
  browser events, or any non-HTTP channel.

### Dead Letters

Fireline records dead letters and gates future replay on dead-letter presence.
The generic lesson is that poison messages and exhausted deliveries must be
queryable durable facts.

Firegrid implication:

- dead-letter rows should be typed, replayable, and projection-friendly;
- dead-letter presence should suppress duplicate side effects for the same
  semantic key until the app-owned fold makes the delivery eligible again;
- dead letters must include enough identity for audit: channel, delivery key,
  subscriber id, source cursor, attempts, error class, and timestamp.

### Trace Context

Fireline propagates trace headers and stores trace metadata in delivery,
completion, and dead-letter records. The generic lesson is that observability
metadata should travel with durable facts and live side effects.

Firegrid implication:

- durable rows should carry a product-neutral trace metadata envelope for
  correlation, causation, producer, subscriber, traceparent, tracestate, and
  baggage;
- trace propagation should be optional and generic;
- trace metadata must not become product auth or business identity.

### Delivered Completions

Fireline appends a delivered completion after successful dispatch. The generic
lesson is that subscriber success is a durable completion, not just an HTTP 2xx
or function return.

Firegrid implication:

- subscriber completion records should be append-only facts;
- duplicate completions should fold idempotently;
- conflicting completions should surface conflict rows without changing the
  winning terminal state.

## Proposed Public Affordances

These are proposed as spec lanes, not implementation commitments.

### Substrate: `DurableChannel` Descriptor

Add a product-neutral descriptor family that describes an app-owned delivery
channel without defining app row types.

Candidate shape:

```ts
DurableChannel.define({
  name: "delivery",
  delivery: DeliverySchema,
  completion: CompletionSchema,
  deadLetter: DeadLetterSchema,
  conflict: ConflictSchema,
  deriveDeliveryKey,
  deriveCompletionKey,
  deriveOrderingScope,
})
```

Responsibilities:

- define the type-level relationship between delivery, completion, conflict,
  and dead-letter records;
- expose canonical branded key derivation hooks;
- carry schema identifiers and versioning;
- remain independent from HTTP, providers, sessions, permissions, and tools.

Non-responsibilities:

- no route generation;
- no signature verification;
- no credential lookup;
- no product event taxonomy;
- no provider lifecycle.

### Substrate/EventPlane: Idempotent Delivery Producer

Add an ergonomic producer wrapper over app-owned EventPlane rows.

Candidate API:

```ts
DeliveryProducer.emit(channel, delivery, {
  producerId,
  idempotencyKey,
  sequence,
  correlationId,
  causationId,
  trace,
})
```

Effect result shape:

```ts
export class ConflictDifferentPayload extends Data.TaggedError(
  "ConflictDifferentPayload",
)<{
  readonly deliveryKey: DeliveryKey
}> {}

export class InvalidDeliveryPayload extends Data.TaggedError(
  "InvalidDeliveryPayload",
)<{
  readonly reason: string
}> {}

export class AppendUnavailable extends Data.TaggedError("AppendUnavailable")<{
  readonly cause: unknown
}> {}

export interface AcceptedDelivery {
  readonly deliveryKey: DeliveryKey
  readonly wasDuplicate: boolean
  readonly cursor: DeliveryCursor
}

type EmitDelivery = Effect.Effect<
  AcceptedDelivery,
  ConflictDifferentPayload | InvalidDeliveryPayload | AppendUnavailable,
  DeliveryProducer
>
```

This helper should rely on documented append/projection semantics. If underlying
append idempotency is unavailable, the spec must state whether the helper uses a
projection fold, a product-owned idempotency row, or returns a capability error.

### Substrate: Delivery Projection Fold

Add a fold recipe that products can instantiate for their own rows.

Neutral logical state:

```txt
received
accepted
claimed
completed
failed_retryable
failed_terminal
dead_lettered
conflict
cancelled
```

The fold must:

- be rebuildable from retained records;
- document ordering assumptions;
- use first-valid-terminal-wins for terminal rows;
- preserve later duplicate/conflicting terminals for audit;
- distinguish projection lag from log truth;
- expose source cursor and projection cursor where available.

### Substrate/Runtime: Durable Subscriber Profile

Add a runtime helper for claimed subscriber work.

Candidate API:

```ts
Firegrid.subscribers.delivery(channel, {
  select,
  classify,
  handle,
  retrySchedule,
  deadOwnerPolicy,
})
```

The helper owns mechanics:

- replay to live boundary;
- observe eligible work;
- append durable claim;
- observe winning claim;
- execute only after ownership is established;
- suppress duplicate execution during replay;
- append completion, retryable failure, terminal failure, conflict, or dead
  letter through caller-provided encoders.

The app owns semantics:

- selection;
- authorization result;
- payload interpretation;
- side effect;
- HTTP or non-HTTP transport behavior;
- retry policy values;
- dead-owner policy;
- completion/dead-letter schemas.

The subscriber helper should be implemented internally as a scoped stream
consumer or equivalent Layer-managed fiber. That lets the implementation use
Effect `Stream` for replay/live input, backpressure, concurrency limits, and
graceful interruption while preserving `Firegrid.composeRuntime` as the public
composition point.

### Runtime: Outbound Delivery Helper

Optionally provide a product-neutral HTTP delivery helper as an adapter, not a
core semantic primitive. It can take an already-authorized request descriptor
and classify transport outcomes.

Allowed:

- timeout;
- static headers supplied by app runtime;
- body encoding from app schema;
- trace header propagation;
- status classifier hook;
- retry transient versus failed result.

Forbidden:

- Standard Webhooks signing;
- callback URL minting;
- tenant authorization;
- provider tokens;
- product event filtering;
- webhook route ownership.

### Client: Delivery Observation Recipes

Client APIs should not grow webhook-specific methods. The client affordance
should be examples and typed recipes over existing public surfaces:

- `client.emit` or EventPlane producer for app-owned delivery rows;
- `client.observe(operation)->Pending` for operation lifecycle only;
- `client.events(EventStream)` for event history;
- app-owned EventPlane projection or EventStream events for detailed delivery
  state.

If a future helper is added, it should be a descriptor-driven delivery client
for app-owned schemas, not a generic webhook SDK.

### Runtime Presence For Ingress Selection

Webhook ingest differs from ordinary durable appends because an external system
often needs a concrete URL before it can deliver facts into the durable stream.
Firegrid can help without owning product routing semantics by letting runtime
hosts materialize product-neutral presence records.

The runtime presence record should be a durable fact, not a transport channel.
It can describe:

- runtime id;
- host id;
- node id;
- provider kind;
- stream or topology identity;
- advertised public ingress endpoints by capability;
- readiness status and evidence;
- created, updated, and heartbeat timestamps;
- optional app-owned tags and public metadata.

Durable subscriber and callback setup code can then query eligible presence rows
when it needs an ingress URL for an unavoidable external callback or provider
event source. Selection remains product-owned: the higher layer decides which
provider, tenant, or webhook registration targets which advertised capability.

Firegrid must not use presence records for host-to-host command transport,
private mesh routing, secret distribution, provider policy, or internal-only
addresses. Presence is a source of truth for durable discovery and ingress
coordination only.

## Illustrative Implementation Shapes

These sketches are not final APIs. They are concrete enough for engineers and
reviewers to validate the shape, package placement, authority boundary, and
failure modes before the Acai specs lock behavior.

### 1. Channel Descriptor

The descriptor should bind app-owned schemas to generic channel mechanics. It
should not know HTTP, providers, sessions, prompts, tools, or permissions.

```ts
import { Brand, Data, Effect, Schedule, Schema } from "effect"

type DeliveryKey = string & Brand.Brand<"DeliveryKey">
type CompletionKey = string & Brand.Brand<"CompletionKey">

export class RetryableDeliveryFailure extends Data.TaggedError(
  "RetryableDeliveryFailure",
)<{
  readonly reason: string
}> {}

export class TerminalDeliveryFailure extends Data.TaggedError(
  "TerminalDeliveryFailure",
)<{
  readonly reason: string
}> {}

const Delivery = Schema.Struct({
  deliveryId: Schema.String,
  target: Schema.String,
  body: Schema.Unknown,
})

const Completion = Schema.Struct({
  deliveryId: Schema.String,
  status: Schema.Literal("delivered"),
  deliveredAt: Schema.DateFromSelf,
})

const DeadLetter = Schema.Struct({
  deliveryId: Schema.String,
  reason: Schema.String,
  attempts: Schema.Number,
})

const AuditChannel = DurableChannel.define({
  name: "example.audit.delivery",
  delivery: Delivery,
  completion: Completion,
  deadLetter: DeadLetter,
  conflict: DurableChannel.conflict({
    deliveryKey: Schema.String,
    reason: Schema.String,
  }),
  deriveDeliveryKey: (delivery): DeliveryKey =>
    Brand.nominal<DeliveryKey>()(delivery.deliveryId),
  deriveCompletionKey: (delivery) =>
    Brand.nominal<CompletionKey>()(
      `example.audit.delivery:${delivery.deliveryId}`,
    ),
  deriveOrderingScope: (delivery) => delivery.target,
})
```

This gives Firegrid enough structure to validate rows, derive stable keys, fold
state, and wire waits. It does not define what a webhook means.

### 2. EventPlane Row Families

The first implementation can compile the channel descriptor into app-owned
EventPlane row families. The row names below are generic examples.

```ts
const AuditDeliveryPlane = EventPlane.define({
  name: "example.audit.delivery-plane",
  rows: {
    delivery: AuditChannel.rows.delivery,
    claim: AuditChannel.rows.claim,
    completion: AuditChannel.rows.completion,
    retry: AuditChannel.rows.retry,
    terminalFailure: AuditChannel.rows.terminalFailure,
    deadLetter: AuditChannel.rows.deadLetter,
    conflict: AuditChannel.rows.conflict,
    cursorAck: AuditChannel.rows.cursorAck,
  },
  projections: {
    byDeliveryKey: AuditChannel.projections.byDeliveryKey,
    ready: AuditChannel.projections.ready,
    deadLetters: AuditChannel.projections.deadLetters,
  },
})
```

If implementation pressure makes this row family generation too magical, start
with explicit examples over existing `EventPlane.define` and make
`DurableChannel` a helper later.

### 3. Idempotent Producer

The producer helper should validate input, derive keys, append a durable fact,
and return a typed result. It must not call an HTTP endpoint or perform product
side effects.

```ts
const accepted = yield* DeliveryProducer.emit(AuditChannel, {
  deliveryId: "delivery-001",
  target: "external-audit-sink",
  body: { event: "user.created" },
}, {
  producerId: "runtime:local-dev",
  idempotencyKey: "callback:provider-x:evt-123",
  correlationId: "corr-123",
  causationId: "operation:op-123",
  trace: {
    traceparent,
    tracestate,
  },
})

if (accepted.wasDuplicate) {
  yield* Effect.annotateCurrentSpan({
    "firegrid.delivery.duplicate": true,
  })
}
```

The important behavior is stable idempotency. A retry of the same callback
should not create a second logical delivery. A retry with the same key and a
different payload should create conflict evidence and should not overwrite the
winning delivery. Conflicting payloads and invalid payloads should be expected
Effect errors, not success variants.

### 4. Subscriber Runtime Layer

The runtime subscriber should be composed through `Firegrid.composeRuntime`.
It should replay to the live boundary, claim work, observe the winning claim,
and only then execute the side effect.

```ts
const AuditDeliverySubscriber = Firegrid.subscribers.delivery(AuditChannel, {
  select: (state) =>
    state.ready.map((delivery) => ({
      deliveryKey: delivery.deliveryKey,
      orderingScope: delivery.orderingScope,
    })),

  handle: (delivery, context) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        "firegrid.delivery.key": context.deliveryKey,
        "firegrid.subscriber.id": context.subscriberId,
        "firegrid.attempt": context.attempt,
      })

      const response = yield* sendAlreadyAuthorizedRequest(delivery)
      if (response.status >= 200 && response.status < 300) {
        return { deliveredAt: new Date() }
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return yield* Effect.fail(new RetryableDeliveryFailure({
          reason: `status:${response.status}`,
        }))
      }
      return yield* Effect.fail(new TerminalDeliveryFailure({
        reason: `status:${response.status}`,
      }))
    }),

  retrySchedule: Schedule.exponential("100 millis").pipe(
    Schedule.compose(Schedule.recurs(5)),
  ),
})

const runtime = Firegrid.composeRuntime({
  handlers: [],
  subscribers: [AuditDeliverySubscriber],
  provide: [AuditDeliveryPlane.layer({ streamUrl })],
})
```

`sendAlreadyAuthorizedRequest` is intentionally app-owned. Firegrid should not
mint headers, sign payloads, select customer callback URLs, or resolve secrets.
The helper should retry only retryable expected errors. Terminal expected errors
append terminal/dead-letter facts according to the channel policy.

### 5. Completion and Dead Letter Append

Subscriber helpers should lower handler outcomes into durable rows. A successful
HTTP response or resolved promise is not enough.

```ts
const complete = (delivery: Delivery, context: DeliveryAttemptContext) =>
  DeliveryProducer.complete(AuditChannel, {
    deliveryId: delivery.deliveryId,
    status: "delivered",
    deliveredAt: new Date(),
  }, {
    subscriberId: context.subscriberId,
    claimId: context.claimId,
    attempt: context.attempt,
    sourceCursor: context.sourceCursor,
    completionKey: context.completionKey,
    trace: context.trace,
  })

const deadLetter = (
  delivery: Delivery,
  context: DeliveryAttemptContext,
  reason: string,
) =>
  DeliveryProducer.deadLetter(AuditChannel, {
    deliveryId: delivery.deliveryId,
    reason,
    attempts: context.attempt,
  }, {
    subscriberId: context.subscriberId,
    claimId: context.claimId,
    sourceCursor: context.sourceCursor,
  })
```

The fold should treat completion, terminal failure, cancellation, and
dead-letter rows as terminal candidates under first-valid-terminal-wins.

### 6. RunWait Wakeup Recipe

A long-running handler should wait on app-owned completion rows through the same
RunWait/projection-match mechanics Firegrid already uses. The delivery channel
does not need a special provider-callback primitive.

```ts
const completion = yield* RunWait.for(
  AuditChannel.triggers.completed({
    completionKey,
  }),
  {
    resultSchema: Completion,
  },
)
```

Runtime composition must include the projection-match subscriber for the app
plane:

```ts
const runtime = Firegrid.composeRuntime({
  handlers: [HandlerThatWaitsForDelivery],
  subscribers: [
    Firegrid.subscribers.projectionMatch({
      evaluate: AuditDeliveryPlane.projections.byDeliveryKey.evaluate,
    }),
    AuditDeliverySubscriber,
  ],
  provide: [
    AuditDeliveryPlane.layer({ streamUrl }),
    RunWait.layer({ streamUrl }),
  ],
})
```

External writers must append the delivery result only after the request row is
durably visible. In tests, prove that with `client.observe(...)->Pending`,
projection `until`, or a deterministic poll of app-owned rows. Do not use
`Effect.sleep` as the visibility gate.

### 7. Ingress Selection Through Runtime Presence

When an external system needs a URL, runtime presence can provide a durable
source of truth for public ingress endpoints. The product still owns route
semantics and auth.

```ts
const ingress = yield* RuntimePresence.query({
  topologyId,
  capability: "delivery-ingress",
  freshness: "30 seconds",
  appScope: { channel: AuditChannel.name },
}).pipe(
  Effect.flatMap((matches) =>
    matches.length === 0
      ? Effect.fail({ _tag: "NoReadyIngress" as const })
      : Effect.succeed(matches[0]),
  ),
)

await registerExternalCallback({
  url: ingress.publicEndpoints.delivery,
  token: productOwnedCallbackToken,
})
```

Firegrid presence records can say which public endpoint is ready. They must not
carry callback tokens, private host routing, tenant authorization, DNS policy,
or provider credentials. Presence is advisory and eventually consistent. It is
acceptable for a selected endpoint to become unreachable after selection; the
product must rely on durable retry/re-registration behavior rather than treating
presence as leader election or a live-routing guarantee.

### 8. Browser/Client Observation

The client should observe product-owned delivery state through projection query
or EventStream history, not through webhook-specific methods.

```ts
const deliveries = ProjectionQuery.for(
  AuditDeliveryPlane.projections.byDeliveryKey,
  { streamUrl },
)

const visible = yield* deliveries.until(
  (state) => Option.fromNullable(state.byKey.get(deliveryKey)),
  { label: "delivery-visible", timeout: "5 seconds" },
)
```

This keeps the browser read-only while still making durable delivery state
reactive and reconnectable.

## Delivery Semantics

### Idempotency

Every delivery channel must define:

- producer identity;
- idempotency key or sequence;
- dedupe scope;
- dedupe retention window;
- canonical payload comparison;
- duplicate behavior;
- conflict behavior.

Duplicate same payload returns the original accepted result or a stable
duplicate result. Duplicate different payload returns conflict and must not
create a second logical delivery under the same key.

Transport idempotency and domain idempotency are separate. A delivery key can
dedupe callback retries; it must not automatically become the idempotency key for
the product operation derived from that callback.

The dedupe retention window is a correctness decision. If a duplicate arrives
after the documented window expires, the channel must either accept it as a new
logical delivery or retain enough durable state to classify it as a duplicate or
conflict. The spec must choose one behavior per channel profile; it should not
fall back to implementation accident.

### Cursor Acknowledgement

Append acknowledgement must include enough cursor information to resume reading
after the accepted record. Subscriber cursor acknowledgement should be durable
and scoped by subscriber identity and channel/source stream.

Cursor acknowledgement is not semantic completion. A cursor can say "this
subscriber has processed through source cursor X"; completion/dead-letter rows
say what happened to the delivery.

### Replay and Live Tail

Subscriber runtime flow:

```txt
1. acquire durable stream/projection access
2. replay retained records from durable cursor or retained beginning
3. rebuild delivery, claim, completion, conflict, dead-letter, and cursor state
4. reach live boundary
5. identify eligible work
6. append and observe claim
7. execute side effect only after winning claim
8. append terminal/retry/dead-letter facts
9. subscribe after live cursor for new work
```

Replay must not execute side effects. Retention gaps must fail explicitly.

Retention gap handling needs an explicit policy hook. Candidate policies:

- crash or stop the subscriber until operator repair;
- reset to earliest retained data and rebuild with an explicit gap row;
- reset to latest and append an explicit missed-history/gap row.

The default should be fail closed until a product deliberately chooses a
recovery policy. Silent reset is not acceptable.

### Claim, Lease, and Fencing

Claim-before-side-effect narrows duplicate execution, but it is not exactly-once
external delivery. A subscriber can pause after claiming, another subscriber can
take over after lease expiry, and both can still reach the external target if
the target does not enforce idempotency or fencing.

Therefore claim records should include:

- delivery key;
- ordering scope;
- claim id;
- owner/subscriber id;
- attempt number;
- lease expiry or heartbeat evidence;
- monotonic fencing token when the side-effect target can use one;
- source cursor;
- claimed timestamp.

The delivery contract should state:

- Firegrid provides durable at-least-once execution with claim/lease narrowing;
- exact-once external effects require app-owned idempotency keys or target-side
  fencing;
- completion first-terminal-wins protects Firegrid state, not arbitrary remote
  side-effect targets.

### Ordering Scope

`deriveOrderingScope` must have explicit semantics. Recommended default:
deliveries within the same ordering scope are processed serially; different
scopes may run concurrently.

This creates intentional head-of-line blocking. If delivery K1 in scope S is
retrying, K2 in scope S does not execute until K1 completes, dead-letters, or
the app-owned fold marks the scope unblocked. Dead-lettering a delivery should
unblock the scope unless the app fold says repair is required.

### Backpressure and Lag

Durable appends should not block on subscriber throughput. Producers append to
durable truth; subscribers catch up from cursors. The platform should expose
subscriber lag as queryable state:

- source cursor;
- subscriber acknowledged cursor;
- projection cursor;
- pending delivery count;
- oldest pending delivery timestamp;
- retry/dead-letter counts.

Backpressure inside the subscriber process should use Effect `Stream`
concurrency and buffering primitives. Cross-process backlog is durable lag, not
process memory.

### Durable Completion

Every successful subscriber side effect that matters to product correctness must
append a durable completion record. A live HTTP 2xx, callback return, or
resolved promise is not sufficient.

Completion rows should include:

- channel name;
- delivery key;
- completion key;
- subscriber id;
- claim id when claims exist;
- source cursor;
- attempt number;
- completed timestamp;
- trace metadata;
- app-owned result payload.

### First Terminal Wins

Delivery completion, terminal failure, cancellation, and dead-letter decisions
must use first-valid-terminal-wins within the documented ordering boundary.

Later identical terminals are duplicate evidence. Later conflicting terminals
are conflict evidence. Invalid terminals do not resolve waits.

"Valid" means schema-valid, within the expected keyspace/order boundary, and
accepted by the configured authority/projection rules for that app-owned row
family. The validity decision must be deterministic from durable facts; two
projection rebuilds over the same retained rows must choose the same terminal.

### Conflict and Dead Letter

Conflict rows are for duplicate keys with different payloads, terminal races,
sequence gaps, or ownership violations. Dead-letter rows are for deliveries that
cannot continue under the configured policy.

Both must be durable, rebuildable, and queryable. Neither should be logs only.

Repair is app-owned projection logic. Firegrid does not need a built-in
`RepairRecord` row family. If a product wants dead-letter repair, its app-owned
rows and fold can turn a dead-lettered delivery into ready work again under a
new claim/attempt policy.

### Producer and Subscriber Identity

Accepted deliveries must carry producer identity. Subscriber claims,
completions, failures, cursor acknowledgements, and dead letters must carry
subscriber identity. Both identities are opaque to Firegrid.

Firegrid should preserve and use identities for idempotency scopes, audit,
claim ownership, and conflict reporting. Firegrid should not define how the
identity is authenticated.

### Wait Visibility and Projection Lag

Completion-before-wait must be linearizable with respect to the cursor used for
follow. A wait that reads snapshot at cursor C must see all valid completion
rows at or before C, or fail with a typed projection/read error. If the
completion is not visible in the snapshot, live follow starts after the same
boundary so no completion row is skipped.

## What Remains App-Owned

The following remain outside Firegrid core:

- webhook signing and verification;
- callback URL auth, callback token minting, rotation, and storage;
- HTTP route names and request/response contracts;
- provider callback schema;
- `callbackEvents` filtering;
- provider semantics and provider compatibility;
- product event taxonomy;
- customer webhook fanout and retry policy;
- tenant authorization;
- credential storage and BYOK;
- browser, sandbox, MCP, skill, and capability semantics;
- mapping from delivery to downstream product operation;
- product-specific sequence semantics and gap policy.

For Flamecast, this means Firegrid can carry a provider callback as an
app-owned durable delivery row, but Flamecast owns the provider API,
callback token, normalized Event schema, session steering, permission decision,
cancel/delete behavior, Standard Webhooks outbound fanout, and provider
metadata/check contracts.

## Spec/API Lanes Before Implementation

Implementation should wait for feature specs with stable ACIDs. Proposed lanes:

### Lane 1: `durable-subscriber-channels.feature.yaml`

Product: `firegrid`

Proposed ACIDs:

- `durable-subscriber-channels.CHANNEL.1`: A channel descriptor defines
  app-owned delivery, completion, conflict, and dead-letter schemas without
  introducing product row families.
- `durable-subscriber-channels.CHANNEL.2`: A channel descriptor defines stable
  delivery key, completion key, ordering scope, and schema version hooks.
- `durable-subscriber-channels.CHANNEL.3`: Delivery and completion keys are
  branded types so transport idempotency keys, delivery keys, and product
  operation keys cannot be silently interchanged.
- `durable-subscriber-channels.PRODUCER.1`: Delivery append validates the
  app-owned schema before durable append.
- `durable-subscriber-channels.PRODUCER.2`: Delivery append records producer
  identity, idempotency key, correlation id, causation id, and optional trace
  metadata.
- `durable-subscriber-channels.PRODUCER.3`: Duplicate same-payload append returns
  a stable duplicate/original result.
- `durable-subscriber-channels.PRODUCER.4`: Duplicate different-payload append
  returns a conflict result and preserves conflict evidence durably.
- `durable-subscriber-channels.PRODUCER.5`: The channel declares the behavior
  for duplicates that arrive after the dedupe retention window expires.
- `durable-subscriber-channels.PROJECTION.1`: Delivery projection rebuilds from
  retained records and declares ordering and retention assumptions.
- `durable-subscriber-channels.PROJECTION.2`: Delivery projection uses
  first-valid-terminal-wins for completion, terminal failure, cancellation, and
  dead-letter rows.

### Lane 2: `durable-subscriber-runtime.feature.yaml`

Product: `firegrid`

Proposed ACIDs:

- `durable-subscriber-runtime.REPLAY.1`: Subscriber runtime reaches the live
  boundary before executing side effects.
- `durable-subscriber-runtime.REPLAY.2`: Subscriber replay performs no external
  side effects.
- `durable-subscriber-runtime.CLAIM.1`: Subscriber runtime appends and observes a
  winning claim before executing side effects when duplicate execution can be
  externally visible.
- `durable-subscriber-runtime.CLAIM.2`: Claim records include work key, claim id,
  owner/subscriber id, claimed timestamp, attempt number, source cursor, lease
  expiry or heartbeat evidence, and fencing token when applicable.
- `durable-subscriber-runtime.CLAIM.3`: Subscriber runtime documents at-least-once
  external delivery semantics; exactly-once side effects require app-owned
  idempotency or target-side fencing.
- `durable-subscriber-runtime.OUTCOME.1`: Subscriber handler success returns a
  completion value and retryable/terminal/conflict failures use typed Effect
  expected errors.
- `durable-subscriber-runtime.RETRY.1`: Retry/backoff policy is caller supplied
  as an Effect `Schedule` and retry exhaustion appends a durable
  terminal/dead-letter row.
- `durable-subscriber-runtime.CURSOR.1`: Subscriber cursor acknowledgements are
  durable and scoped by channel/source and subscriber identity.
- `durable-subscriber-runtime.RETENTION.1`: Retention gaps follow an explicit
  policy and never silently reset subscriber state.
- `durable-subscriber-runtime.LAG.1`: Subscriber lag is queryable as durable
  state including source cursor, acknowledged cursor, pending count, oldest
  pending timestamp, and retry/dead-letter counts when available.
- `durable-subscriber-runtime.OBSERVABILITY.1`: Subscriber attempts propagate
  correlation, causation, producer, subscriber, and trace metadata without
  treating trace metadata as authorization.

### Lane 3: `durable-subscriber-waits.feature.yaml`

Product: `firegrid`

Proposed ACIDs:

- `durable-subscriber-waits.WAIT.1`: A `RunWait` projection-match recipe can wait
  on app-owned delivery completion rows.
- `durable-subscriber-waits.WAIT.2`: A wait resolves from snapshot when the
  completion existed before subscription.
- `durable-subscriber-waits.WAIT.3`: A wait subscribes after the snapshot cursor
  when completion is not yet present.
- `durable-subscriber-waits.WAIT.4`: Snapshot and live-follow use a shared cursor
  boundary so completion rows at or before the snapshot cursor are visible or
  fail with a typed read/projection error.
- `durable-subscriber-waits.RACE.1`: Completion, cancellation, terminal failure,
  and timeout races use first-valid-terminal-wins and preserve later conflict
  evidence.
- `durable-subscriber-waits.CLIENT.1`: Public `client.observe(...)->Pending`
  remains operation lifecycle only; detailed delivery/wait causes are exposed
  through app-owned projections or event streams.

### Lane 4: `durable-subscriber-http-adapter.feature.yaml`

Product: `firegrid`

This lane is optional and should land after the generic channel/runtime specs.

Proposed ACIDs:

- `durable-subscriber-http-adapter.REQUEST.1`: HTTP delivery adapter accepts an
  app-owned request builder and payload encoder.
- `durable-subscriber-http-adapter.REQUEST.2`: HTTP delivery adapter propagates
  trace headers when supplied.
- `durable-subscriber-http-adapter.OUTCOME.1`: HTTP delivery adapter classifies
  outcomes through a caller-supplied classifier.
- `durable-subscriber-http-adapter.OUTCOME.2`: Default example classifier treats
  network errors, timeout, 408, 429, and 5xx as retryable, and other non-2xx
  responses as terminal.
- `durable-subscriber-http-adapter.BOUNDARY.1`: HTTP delivery adapter does not
  implement signing, URL auth, provider callback schema, callbackEvents,
  credential lookup, or product fanout semantics.

### Lane 5: `firegrid-runtime-presence.feature.yaml`

Product: `firegrid`

This lane supports webhook ingress selection and remote handoff. It should land
as a product-neutral runtime/discovery capability, not as a webhook-only API.

Proposed ACIDs:

- `firegrid-runtime-presence.DESCRIPTOR.1`: Runtime hosts publish durable
  presence descriptors with runtime id, host id, node id, provider kind,
  topology identity, advertised ingress endpoints, readiness status, timestamps,
  and public metadata.
- `firegrid-runtime-presence.LIFECYCLE.1`: Startup, heartbeat, readiness update,
  and retirement are durable facts that rebuild into the current presence
  projection.
- `firegrid-runtime-presence.QUERY.1`: Presence queries can select eligible
  ingress endpoints by capability, readiness, freshness, topology, and
  app-owned scope.
- `firegrid-runtime-presence.CONSISTENCY.1`: Runtime presence is advisory,
  eventually consistent discovery state and must not be used as leader election
  or authoritative live routing.
- `firegrid-runtime-presence.BOUNDARY.1`: Runtime presence does not carry
  private host transport credentials, internal-only addresses, provider secrets,
  or host-to-host command routing.

## Proposed Public API Placement

Suggested package placement after specs are ratified:

| Package | Candidate surface | Notes |
| --- | --- | --- |
| `@firegrid/substrate` | `DurableChannel`, `DeliveryKey`, `CompletionKey` or configurable branded key helpers | Descriptor and type helpers only. |
| `@firegrid/substrate/event-plane` | `DeliveryProducer`, channel projection helpers | Must remain app-owned schema driven. |
| `@firegrid/runtime` | `Firegrid.subscribers.delivery(...)` | Runtime layer composed through `Firegrid.composeRuntime`. |
| `@firegrid/client` | No webhook-specific API; optional descriptor-driven delivery emit/observe helpers only | Keep browser-safe and product-neutral. |

If these surfaces pressure Firegrid toward product vocabulary, stop and reduce
the scope to examples over existing `EventPlane`, `EventStream`, and `RunWait`
APIs.

## Conformance Tests To Require

The first implementation PR should include product-neutral tests for:

- append acknowledgement includes a stable resume cursor or equivalent token;
- duplicate same-payload append is idempotent;
- duplicate conflicting payload records or returns conflict;
- projection rebuild preserves logical delivery state;
- subscriber reaches live boundary before side effects;
- replay does not execute side effects;
- claim-lost subscriber does not execute;
- completion-before-wait resolves from snapshot;
- wait-after-snapshot resolves from live subscription;
- retryable failure retries according to policy;
- retry exhaustion records durable dead letter;
- dead-letter presence suppresses duplicate side effect until the app-owned fold
  makes the delivery eligible again;
- terminal races follow first-valid-terminal-wins;
- cursor acknowledgement prevents reprocessing already acknowledged source rows;
- retention gaps fail explicitly;
- claim lease expiry allows a new owner while preserving durable conflict/audit
  evidence;
- ordering scope serializes work within the scope and documents head-of-line
  behavior;
- dedupe window expiry follows the documented channel policy;
- subscriber lag is queryable;
- completion-before-wait is visible from snapshot or fails with a typed
  projection/read error;
- trace/correlation metadata is preserved but not used as auth;
- runtime presence selection returns an eligible public ingress endpoint without
  exposing private host transport or credentials.

## Anti-Scope Guardrails

Stop as blocker if a future implementation does any of the following:

- adds Flamecast, Fireline, Firepixel, provider, session, prompt, permission,
  tool, capability, sandbox, browser, MCP, or callbackEvents vocabulary to
  Firegrid core package APIs;
- adds Standard Webhooks signing or verification to Firegrid core;
- mints callback URLs or callback tokens in Firegrid;
- stores provider credentials, BYOK secrets, WorkOS identities, or tenant auth
  policy in Firegrid substrate/runtime packages;
- treats an HTTP response as durable completion without appending a completion
  row;
- acknowledges a delivery before the chosen durable side effect or intentional
  no-op decision is accepted;
- claims exactly-once external side effects without target-side idempotency or
  fencing;
- uses a process-local queue, promise, timeout, or cursor as the source of truth;
- executes subscriber side effects during replay;
- bypasses `Firegrid.composeRuntime` for runtime composition;
- exposes raw kernel imports or Durable Streams handles as normal app-facing
  API;
- creates a reusable Flamecast adapter package under `@firegrid/*`;
- makes `client.observe(...)->Pending` carry product-specific blocked reasons;
- uses runtime presence as a command bus, host mesh, credential directory, or
  private transport registry.

## Smallest Follow-On

The smallest safe next step is spec-only:

1. Add `features/firegrid/durable-subscriber-channels.feature.yaml`.
2. Add `features/firegrid/durable-subscriber-runtime.feature.yaml`.
3. Add `features/firegrid/durable-subscriber-waits.feature.yaml`.
4. Add `features/firegrid/firegrid-runtime-presence.feature.yaml` if webhook
   ingress selection is in scope for the next platform slice.
5. Defer any HTTP adapter feature until the generic channel and runtime ACIDs
   are accepted.

After those specs land, the first implementation should be a product-neutral
toy delivery channel proving append, idempotency, projection, subscriber claim,
completion, dead-letter, and `RunWait` wakeup. It should not mention Flamecast
outside docs.
