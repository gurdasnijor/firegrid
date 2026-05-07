# Flamecast Direct State Replacement Inventory

Date: 2026-05-07
Status: Wave A1 checkpoint output, documentation-only.
Source checkpoint: `/Users/gnijor/smithery/.worktrees/fa-wave-a1-analysis` on branch `wave-a1-durable-state-inventory`.

## Boundary

This note records the Wave A1 implementation inventory for replatforming
`/Users/gnijor/smithery/flamecast-agents` onto direct Durable Streams State.
It is not a design spec and does not supersede the Flamecast PRD.

The product contract remains:

- sessions own lifecycle, provider state, callbacks, usage, transcript, and
  normalized event history;
- events stay normalized across providers;
- external provider/customer webhooks remain product behavior;
- internal DO storage/fanout compensation should be removed as Durable Streams
  State becomes the source of truth.

## Summary

Direct Durable Streams State replaces:

- `SessionDO` KV session state;
- `SessionDO` KV callback/provider runtime rows where they are part of session
  state;
- `SessionDO` SQLite event log and ordered history;
- `SessionDO` WebSocket live event fanout;
- DO-to-ClickHouse compensation for primary per-session event reads;
- browser REST and WebSocket polling/read paths where durable-streams clients
  and subscriptions can own reads.

Postgres should initially remain as the org/ownership/list index. Mutable
session status, provider metadata, and event materialization should move to
Durable Streams State rows.

ClickHouse should become optional analytics/observability infrastructure, not
the primary per-session event source.

## Architecture Contract For Implementation

This section is the build contract. Implementation workers should not start from
the inventory table below; they should start here.

### Product API Shape

The public API should remain the Flamecast Sessions API from the PRD and current
Effect `HttpApi` groups:

```text
GET    /sessions
POST   /sessions
GET    /sessions/:id
DELETE /sessions/:id
POST   /sessions/:id/messages
POST   /sessions/:id/events
GET    /sessions/:id/events
POST   /sessions/:id/cancel
```

The route contract does not become a Firegrid API and does not expose Durable
Streams State protocol messages directly. Durable Streams State is the storage
and materialization boundary underneath the Flamecast API.

The current API has legacy extras such as `/sessions/:id/abort`,
`/sessions/:id/workspace`, bundle/resource routes, `/events`,
`/observability/query`, and `/sessions/:id/events/live`. The first vertical
slice should leave unrelated extras alone unless they conflict with the direct
state path. `/sessions/:id/events/live` is explicitly a replacement target
after durable-streams subscriptions are available.

### Firegrid Boundary

Flamecast should not be implemented "on Firegrid" by introducing Firegrid
runtime concepts into `flamecast-agents`. The Firegrid learning that matters is
the durable-state proof:

```text
Effect vocabulary + Durable Streams State rows
  -> createStateSchema
  -> State Protocol appends
  -> createStreamDB materialization/actions where useful
```

Do not introduce Firegrid handlers, `ctx`, `RunWait`, `EventPlane`,
`PlaneProducer`, operation descriptors, substrate facades, or app-facing
`emit(...)` APIs. If a helper looks like an Effect or Durable Streams primitive,
use the primitive.

### Replacement Analysis Rule

Do not keep a Flamecast mechanism because it has no one-line Firegrid
equivalent. For each existing mechanism, implementation must identify:

1. the job it performs today;
2. whether that job is product semantics or durable mechanics;
3. which Firegrid primitive can carry the durable-mechanics part;
4. which Firegrid primitive is missing, unimplemented, or unproven;
5. what Flamecast code remains only until that gap is closed.

Compatibility is not a reason by itself. A remaining Flamecast path must be
labeled as one of:

- product-owned behavior that Firegrid should never absorb;
- temporary fallback because a product-neutral Firegrid primitive is not ready;
- dead internal compensation that should be deleted once state/event
  observation exists.

The Acai anchors for this rule are:

- `flamecast-product-contract.LOWERING.1`
- `flamecast-product-contract.CALLBACKS.5`
- `flamecast-product-contract.LOWERING.10`
- `firegrid-platform-invariants.BOUNDARY.1`
- `firegrid-platform-invariants.SECURITY.2`
- `firegrid-durable-subscriber-webhooks.*`

### Webhook And Callback Trace

Flamecast currently uses the word "callback" for several different jobs. They
should not be migrated as one category.

| Current path | Current code trace | Why it exists | Firegrid replacement posture |
| --- | --- | --- | --- |
| Customer session status callback | `callback_url` is accepted in `src/effect/schemas.ts`; routed through `src/effect/api/sessions-core-handlers.ts`; stored by `SessionDO.writeCallback`; fired from `SessionDO.writeState`; payload/signing live in `src/session-callback.ts`. | Notify an external caller that an async session status changed. Slack also reuses this path internally for turn completion. | External delivery remains Flamecast product behavior. The durable mechanics should lower to a delivery row plus replay-safe subscriber once `firegrid-durable-subscriber-webhooks.*` is implemented/proven. Internal Slack-style signalling should observe state/event rows instead of POSTing a customer webhook to ourselves. |
| Provider event callback ingest | `providerEventCallbackUrl(env, sessionId)` mints `/provider-events/:sessionId`; `eventCallbackToken` is stored in provider metadata; `src/provider-events.ts` validates bearer token, reads provider metadata from Postgres, normalizes body events, updates Postgres, then calls `writeProviderStateToDo` and `ingestProviderEventsToDo`. | Let external providers report asynchronous progress, output, terminal state, usage, or errors when polling or immediate create response is not enough. | The route, token policy, payload schema, and provider taxonomy stay Flamecast. The accepted delivery, idempotency/conflict projection, sequence/gap handling, and wakeup into session state should lower to Firegrid durable delivery/EventPlane mechanics. |
| Slack app mention ingest | `handleSlackEvents` verifies Slack signature, maps a Slack thread to a Flamecast session, starts an async turn through `SessionDO`, and posts an immediate thinking message. | Slack's Events API requires fast acknowledgement and product-specific auth/signature handling. | Slack route and signature verification stay Flamecast. The turn should lower to a Flamecast operation/runtime path. Posting final Slack replies should be an outbound delivery side effect driven by terminal state, not the session status callback transport. |
| Slack turn callback | `handleSlackTurnCallback` receives `session.status_changed`, parses terminal status, and posts the summary to the Slack thread. | Internal bridge from session terminal state to Slack reply posting. | This is not customer webhook behavior. It should become a subscriber over Flamecast terminal state/event rows, producing an outbound Slack delivery intent with at-least-once semantics and product-owned idempotency. |
| Runtime/SDK stream callbacks | Think and Claude-style runtimes use SDK callbacks/RPC targets to transform model chunks/tool events into `IngestEvent` rows, then `SessionDO` stores and fans out them. | Provider SDKs expose streaming callbacks; Flamecast needs to normalize them into session history. | Provider callback APIs remain adapter-owned. The storage/fanout target should be state/EventStream append, not DO SQLite/WebSocket. Firegrid does not replace provider SDK callback shape. |

### Firegrid Gap Ledger

The question is not "what has no direct mapping?". The question is "what durable
mechanic must Firegrid provide so Flamecast can stop owning the compensation?".

| Need | Current Flamecast compensation | Firegrid primitive or spec | Gap to close before deletion |
| --- | --- | --- | --- |
| Durable inbound provider delivery | `/provider-events/:sessionId` writes Postgres metadata and `SessionDO` storage directly. | Caller-owned EventPlane rows plus `@firegrid/runtime` workflow execution. | Product code should append provider delivery facts to its own stream rows, then execute a top-level workflow whose payload schema and idempotency key describe the provider callback intent. Firegrid must not host the Flamecast HTTP route or token policy. |
| Replay-safe processing of accepted deliveries | Provider callback handler performs state mutation inline inside the HTTP request. | `firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.*`; `firegrid-claimed-intent-transport.CLAIM_BEFORE_DISPATCH.*`. | Use caller-declared `Workflow.make` and `Activity.make` definitions on the Durable Streams backed workflow engine so claim-before-body, replay, deferred waits, and durable sleep are workflow mechanics rather than a parallel subscriber store. |
| External customer webhook fanout | `SessionDO.deliverStatusCallback` fetches the customer URL on status change, without durable retry/dead-letter state. | Caller-owned outbound intent rows plus workflow activities; `firegrid-platform-invariants.SECURITY.6`. | Need a Flamecast-declared outbound workflow with app-owned idempotency/fencing, retry policy, terminal/dead-letter projection, and request classifier. Signing, callback URL, customer auth, and callbackEvents filtering remain Flamecast. |
| Internal terminal signalling | Slack turn callback receives a customer-shaped status webhook from the same worker. | State/EventPlane/EventStream observation; `flamecast-product-contract.CALLBACKS.5`; `flamecast-product-contract.LOWERING.10`. | No Firegrid product feature is needed if terminal session state is already durable and observable. The blocker is wiring Slack reply logic as a Flamecast subscriber/delivery side effect rather than as an HTTP callback to self. |
| Public ingress discovery for providers/callback registrars | `WORKER_URL` is embedded in `providerEventCallbackUrl`. | `firegrid-runtime-presence.INGRESS_SELECTION.*`. | Need presence publication/query if callback registration must select among multiple runtime/edge ingress endpoints. Presence supplies endpoint discovery only; product code still owns route auth and token minting. |
| Browser read/live replacement | REST polling and `/events/live` WebSocket read `SessionDO` or ClickHouse. | `firegrid-client-projection-api.*`; direct Durable Streams State subscriptions. | Need a no-gap snapshot-then-live facade over app-owned rows before deleting UI polling/WebSocket compensation. |
| Event history projection | `SessionDO` SQLite assigns sequence and ClickHouse compensates for reads. | Direct Durable Streams State rows now; Firegrid EventStream/EventPlane if the broader chassis uses Firegrid. | Need explicit append boundary that allocates per-session `seq`, preserves normalized `IngestEvent`, and proves reads do not hit DO SQLite or ClickHouse. |

Current Firegrid runtime slice:

- `@firegrid/runtime` exposes the Durable Streams backed workflow engine. It
  does not expose a separate delivery store or hidden subscriber runtime.
  Product code declares inbound or outbound work as top-level `Workflow.make`
  and `Activity.make` constructs, then provides the workflow layer to the
  configured stream URL.
- The slice proves caller-owned workflow payload/result schemas, workflow
  idempotency and activity replay for duplicate suppression, durable activity
  result/deferred/sleep recovery after engine reconstruction, and
  caller-selected stream partitioning through configured workflow engine stream
  URLs.
- Firegrid still does not expose an HTTP ingress surface. Flamecast remains
  responsible for accepting external HTTP, verifying auth/signatures/tokens, and
  translating accepted product deliveries into stream appends.
- Remaining Flamecast integration gaps before deleting all compensation:
  product-owned delivery/conflict/terminal projections, retry/backoff and
  dead-letter policy expressed in workflows, stale workflow activity takeover
  validation, and an outbound HTTP activity helper only if Flamecast chooses to
  reuse one after preparing an already-authorized request descriptor.

The immediate implementation implication is that provider-event ingest and
customer webhook fanout are not "keep for compatibility" items. They are either
product-owned HTTP/auth surfaces, or temporary holders for missing/proving
Firegrid durable delivery mechanics. Internal callback-to-self paths should be
removed once the state transition is observable.

### Stream Topology

Use a small number of configured Flamecast state streams. Do **not** create one
Durable Stream per session.

The first implementation slice should use one canonical state stream for the
deployment/environment:

```text
/flamecast/state
```

The actual stream URL should come from configuration, for example
`FLAMECAST_STATE_STREAM_URL`. App code should not construct stream names from
`sessionId`.

The stream is the topic-like durable log. `sessionId` is data inside State
Protocol messages, not the top-level stream identifier. This keeps the
operational model closer to a Kafka-style topic where messages carry
`session_id`, rather than creating one topic per session.

Future scaling can shard the state stream deliberately, for example by org or a
stable hash:

```text
/flamecast/state/{shard}
```

That is an operational sharding decision, not part of the product API and not
something app code should choose per request.

Reasons:

- avoids per-session stream/config sprawl;
- keeps subscriptions and clients pointed at stable stream URLs;
- lets session, event, provider, callback, and future summary rows share one
  ordered state log;
- preserves the Flamecast API boundary: callers use sessions/events endpoints,
  not stream names;
- leaves room for deliberate sharding once usage warrants it.

Postgres remains the org/ownership/list index during the first slice. Do not
attempt a data migration. Do not remove Postgres ownership checks. Cross-session
list summaries may be degraded or continue using existing paths until a later
state-backed summary/index collection is designed.

### State Collections

Define a Flamecast state schema with `createStateSchema`. Use Effect Schema as
the row validation source, converted to Standard Schema via Effect's
`Schema.standardSchemaV1(...)` where needed.

The first slice should include these collections:

| Collection | State `type` | Primary Key | Purpose |
| --- | --- | --- | --- |
| `sessions` | `flamecast.session` | `sessionId` | Current public session state plus internal counters needed for ordering. |
| `sessionEvents` | `flamecast.session_event` | `eventId = sessionId:seq` | Ordered normalized event history for a session. |
| `providerSessions` | `flamecast.provider_session` | `sessionId` | Provider-native session id/status/cursor/usage/runtime metadata. |
| `sessionCallbacks` | `flamecast.session_callback` | `sessionId` | External customer/provider callback configuration. |

All session-owned rows in the shared state stream must include `orgId` and
`sessionId` where applicable. Postgres remains the authoritative ownership
gate, but state rows should still carry org identity so materialized reads,
indexes, subscriptions, and future shard moves do not rely on out-of-band
session lookup.

Recommended row shapes:

```ts
type FlamecastSessionRow = {
  sessionId: string
  orgId: string
  agent: AgentName | ProviderId
  machine: Machine
  workspace: WorkspaceLayout
  status: SessionStatus
  model?: string
  lastMessage?: string
  lastTurnAt?: string
  turnCount: number
  eventCount: number
  lastEventSeq: number
  lastEventAt?: string
  error?: string
  githubInstallationId?: string
  agentId?: string
  agentFingerprint?: string
  createdAt: string
  updatedAt: string
}

type FlamecastSessionEventRow = {
  eventId: string
  orgId: string
  sessionId: string
  seq: number
  at: string
  type: IngestEvent["type"]
  event: IngestEvent
  tool_name: string
  tool_use_id: string
  is_error: boolean
  text: string
  payload: unknown
  metadata: Record<string, string>
}

type FlamecastProviderSessionRow = {
  sessionId: string
  orgId: string
  providerId: ProviderId
  nativeSessionId: string
  status: ProviderStatus
  nativeStatus?: string
  model?: string
  lastMessage?: string
  links?: ProviderSession["links"]
  usage?: ProviderSession["usage"]
  providerEventCursor?: string
  providerEventIds?: string[]
  runtimeAgent?: AgentSpec
  updatedAt: string
}

type FlamecastSessionCallbackRow = {
  sessionId: string
  orgId: string
  url: string
  updatedAt: string
}
```

The row names above are a contract for the first slice, not permanent naming.
Do not store ClickHouse-shaped `EventRow` as the canonical value. The canonical
event row should contain the normalized `IngestEvent` under `event`; flattened
fields exist only to preserve current response/filter ergonomics.

### Event Ordering

The state-backed event history must preserve stable per-session order. For the
first slice, order by `seq`, not by timestamp.

Sequence allocation belongs inside the low-level Durable Streams State write
boundary:

1. materialize or read the current `sessions` row;
2. allocate `seq = lastEventSeq + n` for each event in the append batch;
3. append `sessionEvents.insert(...)` rows in the same logical write path;
4. append a `sessions.update(...)` row that bumps `eventCount`,
   `lastEventSeq`, `lastEventAt`, `updatedAt`, and derived status/lastMessage
   when applicable.

Do not expose sequence allocation as an app-facing producer API. App code should
ask to create a session, send a message, ingest normalized events, or read
history. The only boundary that writes State Protocol messages should be the
state service/action implementation.

### Mutation Boundary

The canonical implementation unit should be an app-owned session state module,
for example:

```text
src/effect/services/session-state.ts
```

It should own:

- resolving the configured Flamecast state stream URL or shard;
- `createStateSchema(...)`;
- `createStreamDB({ streamOptions, state, actions? })` if actions simplify
  mutation call sites;
- raw State Protocol appends when clearer than actions;
- materialized reads for session row and ordered event history;
- validation/decoding with Effect Schema.

This module is not a Firegrid abstraction. It is the Flamecast app boundary over
Durable Streams State.

Acceptable action names:

```text
createSession
recordUserMessage
ingestEvents
updateProviderSession
completeTurn
cancelSession
deleteSession
readSession
readEvents
```

Unacceptable app-facing shapes:

```text
emit
producer
sink
EventPlane
operation descriptor
ctx
RunWait
```

### Read Boundary

`GET /sessions/:id` should:

1. perform the existing org ownership check through Postgres;
2. materialize the configured state stream or relevant shard;
3. filter the `sessions` collection by `orgId` and `sessionId`;
4. return the `sessions` row converted to current `SessionState`, including
   current `links` behavior where still needed.

`GET /sessions/:id/events` should:

1. perform the existing org ownership check through Postgres;
2. materialize `sessionEvents`;
3. filter by `orgId` and `sessionId`;
4. sort by `seq ASC`;
5. apply `since`, `limit`, and `tail`;
6. return current `EventsResponse` shape.

ClickHouse must not be used as the primary per-session event source in the new
path. It can remain for `/events`, `/observability/query`, and optional
analytics sinks.

### Route Mapping

The first vertical slice should move one narrow existing path, then expand.

| Existing Path | First Direct-State Behavior |
| --- | --- |
| `POST /sessions` | Create Postgres ownership row as today, append `sessions.insert`, optionally append callback/provider rows, and return materialized `SessionState`. If `message/input` is present, append a `user_message` row and mark session running before invoking provider/runtime. |
| `GET /sessions/:id` | Org-gate through Postgres, then read the `sessions` state row. Do not fetch `SessionDO /state`. |
| `POST /sessions/:id/events` | Normalize provider/runtime input using current event vocabulary, append `sessionEvents`, update `sessions` counters/status, and only then invoke external provider steering if required. Do not write DO SQLite. |
| `GET /sessions/:id/events` | Org-gate through Postgres, then read state-backed ordered event rows. Do not query ClickHouse for primary history. |
| `POST /sessions/:id/messages` | Append user message and running state through state service, then invoke provider/runtime adapter. |

Runtime execution may temporarily continue to use existing provider/runtime
adapters. That does not permit `SessionDO` to remain the session/event storage
source of truth.

### Provider Sessions

Provider-backed sessions currently store provider metadata in Postgres JSON and
mirror it into `SessionDO`. In the direct-state path:

- Postgres keeps org ownership and list membership;
- `providerSessions` stores provider-native session state;
- normalized provider events are appended to `sessionEvents`;
- provider cursors/event IDs stay in provider row metadata, not in public event
  variants;
- opaque providers must not synthesize tool-level events they do not expose.

The current `provider-session.ts` normalization helpers can remain app-owned,
but their durable writes must go through the session state module.

### Callback Semantics

External customer/provider webhooks remain part of the Flamecast product.
Internal DO callback/fanout compensation does not.

Status transitions should first be recorded as durable state/event facts. Any
external customer callback is then an outbound delivery side effect derived from
that state. The callback builder should not depend on DO storage, SQLite event
counts, or `SessionDO.writeState`.

Internal consumers such as Slack replies should not receive customer-shaped
webhooks from Flamecast itself. They should observe terminal state or event rows
and append their own product-owned outbound delivery intent. This is the
practical distinction required by
`flamecast-product-contract.CALLBACKS.5` and
`flamecast-product-contract.LOWERING.10`.

### `@electric-sql/durable-session` Decision Rule

`@electric-sql/durable-session` must be inspected before building an equivalent
chat/session client because it already wraps `createStreamDB`.

Use it directly only if its `sessionStateSchema`, `createSessionDB`, and
`materializeMessage` can preserve the Flamecast normalized event contract above.
If it forces TanStack AI message parts to become the canonical state shape, do
not use it for the source of truth. Use it as prior art and implement direct
`@durable-streams/state` collections.

`@durable-streams/ai-transport` is not the first storage primitive. It is a
Vercel AI SDK transport/resume adapter and may be useful later for a specific
client/runtime path.

### Required First Test

The first implementation is not complete until a focused test proves:

```text
create session
  -> send user message
  -> ingest assistant and terminal events
  -> read session
  -> read ordered event history
```

Assertions:

- `GET /sessions/:id` or the internal read returns the state-backed session row;
- event history is ordered by `seq`;
- assistant and terminal events round-trip as normalized `IngestEvent` values;
- `eventCount`, `lastEventSeq`, `lastEventAt`, `lastMessage`, and `status`
  reflect the ingested events;
- the proof does not read from DO SQLite or ClickHouse.

### Worker Acceptance Criteria

Any implementation lane that touches the source-of-truth path must report:

- which current Flamecast mechanism it replaces, the job that mechanism
  performed, and whether any remaining code is product-owned behavior,
  temporary Firegrid-gap fallback, or dead internal compensation;
- exact `createStateSchema` collections and primary keys;
- exact stream resolver/config and proof it does not create per-session Durable
  Streams;
- exact append boundary;
- whether `createStreamDB` actions or raw State Protocol appends are used;
- the route/internal call site moved first;
- tests and typecheck results;
- proof that no new Firegrid abstractions or app-facing emit/producer/sink
  concepts were introduced.

## Inventory

| File | Current Responsibility | Replace With | Delete / Keep / Modify | Owner Risk |
| --- | --- | --- | --- | --- |
| `src/session.ts` | `SessionDO` owns KV session state, callback/provider runtime rows, DO SQLite events, history, subscribe, callbacks, and ClickHouse flush. | Durable Streams State rows for session, session event, provider session, and callback config; materialized reads/subscriptions. | Modify heavily, then delete most DO persistence/fanout. Keep only runtime orchestration until replaced. | Highest: active turn orchestration and current runtime integration still depend on DO. |
| `src/effect/schemas.ts` | Effect Schema source for `SessionState`, `IngestEvent`, `EventRow`, and API bodies. | Reuse as `createStateSchema` validators and durable row schemas; add explicit durable row objects with primary keys. | Modify. | Medium: current `EventRow` is ClickHouse-shaped, not State Protocol-shaped. |
| `src/events.ts` | Constructors for normalized runtime events. | Keep constructors; add durable envelope adapter at the Durable Streams append boundary. | Keep/modify. | Low: product event union remains valid. |
| `src/index.ts` | Worker routing, `SESSION` DO binding, `/provider-events`, and WebSocket upgrade bypass. | Route session/event APIs to state-backed services; remove `/events/live` WebSocket shortcut after subscriptions land. | Modify. | High: auth gate and legacy provider callbacks pass through here. |
| `src/effect/survivor-router.ts` | Non-`HttpApi` routes and WebSocket carveout documentation/path. | Drop session live-route carveout once durable-streams subscription path owns live reads. | Modify. | Low. |
| `src/effect/streaming-handlers.ts` | Workspace/transcript streams and `eventsLiveDispatch` DO proxy. | Replace live event dispatch with durable-streams subscription client, or delete if handled elsewhere. Keep workspace/transcript streaming. | Modify/delete live section. | Medium: file streaming should remain unrelated. |
| `src/session-callback.ts` | Builds and signs status webhook payloads. | Keep signing/payload helpers for external webhooks; trigger from state transition subscription/action, not DO `writeState`. | Keep/modify. | Medium: PRD still includes external callbacks. |
| `src/clickhouse.ts` and `src/effect/services/clickhouse.ts` | Primary public event reads, event summaries, analytics SQL, and DO flush sink. | Durable Streams State materialized reads for primary `/sessions/:id/events`; ClickHouse optional analytics/observability only. | Modify, possibly shrink. | High if observability depends on SQL. |
| `src/db/schema.ts` | Postgres org ownership/list metadata for agents and sessions. | Keep org gate/index initially; move mutable session status/provider metadata to Durable Streams State. | Modify narrowly. | Medium: ownership and claims are real Postgres use cases. |
| `src/db/store.ts` | Postgres connection factory. | Keep for agents/org ownership unless all metadata moves later. | Keep. | Low. |
| `web/src/api.ts` | REST polling client, `/sessions/:id/events`, WebSocket URL builder. | Use durable-streams/StreamDB client collections/subscriptions for session/event reads; keep REST mutations if server actions own writes. | Modify. | Medium: UI currently merges by `seq` from REST plus WebSocket. |

## Removal Catalog

- DO KV persistence: replace `ctx.storage.get/put("state" | "callback" |
  "providerRuntimeAgent" | "currentTurnId")` with typed Durable Streams State
  rows.
- DO SQLite event persistence: replace the `events` table, autoincrement `seq`,
  `/history`, and replay SQL with durable `session_event` rows and
  materialization.
- Cloudflare DO session transport as storage API: remove app-facing
  `env.SESSION.get(...).fetch("/init" | "/turn" | "/ingest" |
  "/provider-state" | "/state")` for state storage; keep only while needed for
  runtime execution.
- Manual HTTP event history transport: replace primary
  `/sessions/:id/events?since=&limit=` reads with durable-streams materialized
  collection reads.
- WebSocket/SSE live fanout: replace `/sessions/:id/events/live`,
  `WebSocketPair`, `acceptWebSocket`, and `broadcastEvents` with Durable
  Streams subscriptions/client live queries.
- Internal callback transport where subscriptions replace it: remove internal
  callback-style session status delivery paths; keep external customer/provider
  webhooks required by the PRD.
- ClickHouse-as-primary-event-read path: remove ClickHouse dependency for
  per-session event history and session list event counts if those only
  compensate for missing stream materialization; keep ClickHouse for
  observability/analytics SQL if still product-owned.
- Ad hoc polling/read APIs: replace UI `setInterval(listSessions)`,
  `listSessionEvents`, cursor replay, and WebSocket reconnect logic with
  durable-streams clients/live queries where possible.

## Open Questions

None blocking from Wave A1.

The main scope note is that external provider/customer webhooks remain PRD
behavior. Only internal callback/fanout compensation should be removed.

## Wave A2 Prior Art Checkpoint

Source checkpoint: Wave A2 transport prior-art lane,
`/Users/gnijor/smithery/.worktrees/fa-wave-a2-transport-prior-art` on branch
`wave-a2-transport-prior-art`.

### Stop-Condition Decision

`@electric-sql/durable-session` already provides a durable chat/session shape.
It must be inspected and tried before building a Flamecast-local equivalent.

The package is not a perfect match for Flamecast by default: it assumes a
TanStack AI message model, while Flamecast's PRD centers normalized provider
events. If that message model is acceptable, the first implementation diff
should try it directly. If it distorts Flamecast's normalized event contract,
use it as implementation prior art over direct `@durable-streams/state`.

Firegrid should not own a competing session transport abstraction.

### APIs Inspected

`@electric-sql/durable-session`:

- `DurableChatClient`
- `createDurableChatClient`
- `sessionStateSchema`
- `createSessionDB`
- `createMessagesCollection`
- `createToolCallsCollection`
- `createPendingApprovalsCollection`
- `createToolResultsCollection`
- `createActiveGenerationsCollection`
- `createModelMessagesCollection`
- `materializeMessage`
- `messageRowToUIMessage`

Key implementation detail: `createSessionDB` wraps
`createStreamDB({ streamOptions, state: sessionStateSchema })` from
`@durable-streams/state`.

`@durable-streams/ai-transport`:

- `durableTransport(sessionId, fetchOptions, transportOptions, durableOptions?)`
- `clearPersistedMessages`
- `clearSession`
- `StorageOptions`

This is a Vercel AI SDK `DefaultChatTransport`/resume adapter. It is narrower
than Flamecast's session source of truth.

`@durable-streams/transport`:

- `createFetchClient`
- `create`
- `read`
- `resume`
- stream schemas/types
- active-generation and message local storage helpers

### Implementation Guidance

For the first vertical slice:

1. Try `@electric-sql/durable-session` APIs first only if
   `sessionStateSchema`, `createSessionDB`, and `materializeMessage` can
   preserve the Flamecast normalized session/event contract.
2. If the TanStack AI message model conflicts with Flamecast events, implement
   direct `@durable-streams/state` rows locally, using
   `@electric-sql/durable-session` as prior art.
3. Do not start with `@durable-streams/ai-transport`; it is useful for Vercel
   AI SDK transport/resume behavior, not the canonical Flamecast session/event
   state source.
