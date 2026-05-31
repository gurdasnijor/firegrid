# SDD: Protocol Response Unification — Collapse Specialized Channel Schemas to One Durable-Event Shape

Status: proposed
Created: 2026-05-31
Owner: Firegrid Protocol / Host SDK / Tiny Firegrid (sim: `unified-kernel-validation`)
Grounded in:
- `https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md` — append-only stream protocol
- `https://github.com/durable-streams/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md` — change-message state derivation extension
- `packages/tiny-firegrid/src/simulations/unified-kernel-validation/` — empirical proof that signal-based subscribers cover the product surface
Related:
- `docs/architecture/unified-subscriber-kernel.md` — conceptual collapse story for subscriber bodies
- `docs/cannon/architecture/kernel-owned-write-arm.md` — the durable signal primitive this SDD bottoms out on
- `SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md` — channels as the public surface
- `SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md` — prior swapover work

## Purpose

The `unified-kernel-validation` simulation set out to prove a single architectural claim: that the entire firegrid product surface (sessions, prompts, tools, permissions, scheduled prompts, webhooks, peer events, terminal) can be delivered by a small set of primitives — `@effect/workflow` + `DurableTable` + a durable **signal** primitive — and exposed through the existing channels abstraction.

The simulation succeeded on the subscriber side: every Shape C / DurableDeferred-mailbox pattern collapsed cleanly into "workflow body parks on `awaitSignal`, producer sends the signal." But when we attempted the natural final step — drive the simulation from the production `Firegrid` client SDK exactly as a real consumer would — the integration ran into a wall: each standard channel Tag (`HostPromptChannel`, `HostPermissionRespondChannel`, `HostSessionsStartChannel`, etc.) has a bespoke response schema that bakes in pre-channel-abstraction history. Producing a signal-based binding for those Tags requires either synthesizing fictitious row instances or smuggling production-runtime concepts (input intents, request rows, lifecycle status, cross-row id references) back into the new architecture.

This SDD names the **schema-level collapse** that has to land before the simulation can be a true rip-and-replace reference, and before the production cutover (`tf-c9r9`, `tf-vrz6`, `tf-jpcg`, `tf-vfq9`) can be a thin protocol-aligned change instead of an N-way row-shape synthesis exercise.

## The empirical observation

The simulation's signal primitive is structurally identical to durable-streams' append: `sendSignal({ executionId, name, value })` is "append event tagged `name` to the consumer's stream." `awaitSignal({ name })` is "read the consumer's stream filtered by `name`." Both bottom out on the same durable-streams protocol — opaque append, offset receipt, idempotent producer headers for exactly-once.

Yet the production channel surface, sitting only one layer above this bedrock, has seven distinct response shapes for what are semantically all "append event to a consumer's stream":

```
HostPromptChannel.append                  → RuntimeInputIntentRow
SessionPromptChannel.append (per-session) → RuntimeInputIntentRow
HostPermissionRespondChannel.call         → PermissionRespondOutput
HostSessionsStartChannel.call             → RuntimeStartRequestAck
HostSessionsCreateOrLoadChannel.call      → SessionHandleReference
HostContextsCreateChannel.call            → SessionHandleReference (different derivation)
HostContextsChannel.binding               → IngressChannel<RuntimeContext>  (read side)
```

Each carries fields that are either redundant with the durable-streams protocol (`inserted: boolean` duplicates wire-level dedup), redundant with payload (`inputId` as a cross-row reference where the signal name would suffice), or vestigial from a read-side state-machine era that no longer exists under signal-based subscribers (`status: "pending" | "sequenced" | "cancelled"` and `kind: "message" | "control" | ...` discriminators).

## Diagnosis: where each "special case" came from

Each deviation from the unified shape traces to a specific historical pattern that never got collapsed when channels and signals landed.

**1. Row-as-state-machine — fields encoding a runtime loop that doesn't exist anymore.** `RuntimeInputIntentRow.status` (`pending | sequenced | cancelled`) and `RuntimeInputIntentRow.kind` (a four-element literal union) existed because the Shape C `RuntimeContextSubscriber` was a state machine that read rows from `RuntimeControlPlaneTable.inputIntents` and dispatched them based on these fields. Under signal-based subscribers there is no read-side state machine — the workflow body parks via `awaitSignal` and resumes with the payload directly. Both fields are vestigial residue of the retired pattern but remain in the channel response schema because the schema predates the new subscriber architecture.

**2. Cross-row id correlation where the signal name would suffice.** `PermissionRespondOutput { responded: true, contextId, permissionRequestId, inputId }` exposes `inputId` — the row id of the production-runtime input-intent that the response was paired with. Downstream consumers used this to correlate "this response" with "that request" through shared id. Under a signal-based model the **signal name itself** is the correlation key (`name = "permission-decision"` against `executionId = hash(contextId, permissionRequestId)` — the responder and waiter share the same key construction). No `inputId` is needed; the payload-level correlation IS the wake-up correlation.

**3. Operation-shaped channels around table-shaped responses.** `HostPromptChannel.append`'s response type is `RuntimeInputIntentRow` because the channel was retrofitted on top of `RuntimeControlPlaneTable.inputIntents.insertOrGet(...)` — the channel returns the row it inserted. The channel abstraction never got the chance to define its own response shape; it inherited the row shape from the storage. Under the unified shape the channel returns an `offset` (or `void`) and the row concept disappears at the channel boundary — only the payload survives, and that's what the consumer reads from the stream.

**4. `inserted: boolean` bubbling transaction internals into the public response.** `RuntimeStartRequestAck { requestId, contextId, inserted }` exposes the outcome of an `insertOrGet` to the application layer. Durable-streams handles deduplication at the wire level via `Producer-Id` / `Producer-Seq` headers — the producer gets exactly-once write semantics and the consumer should never see whether a particular send was a fresh insert vs. a deduped retry. The field exists because firegrid's protocol mapped `Inserted | Found` from `DurableTable.insertOrGet` into the channel response instead of collapsing it into the wire's idempotent-producer guarantee.

**5. One monolithic table family pretending to be many concepts.** `RuntimeControlPlaneTable` holds multiple unrelated row families (`inputIntents`, `startRequests`, `contextRequests`, `permissionRequests`, ...). Each channel writes/reads its specific family; each family has its own schema; each schema bleeds into a channel response. The table's actual contribution is "shared transactional scope," but the families themselves are stand-ins for **per-consumer streams** that were never separated. A unified model has one stream per workflow execution (events arriving for that body), one stream per webhook source (deliveries), one stream per peer event name. The control plane table becomes thin index metadata — not the storage.

**6. Sync vs queued semantics mixed under one channel pattern.** `firegrid.sessions.createOrLoad` returns immediately with a derived value (`SessionHandleReference { sessionId }` — a synchronous computation on the input). `firegrid.prompt` returns the receipt of a queued event (`RuntimeInputIntentRow` — what's in the stream now, processed later). Both look like `CallableChannel.binding.call(...)` to the caller but mean fundamentally different things — one returns "here's a computation result," the other returns "here's a receipt for an event I queued." A clean shape separates synchronous derivations (return derived data) from durable appends (return `void` / offset; payload reflects in the consumer's stream).

**7. Pre-channel-abstraction history.** Looking at the field names (`createdAt`, `intentId`, `_otel`, `idempotencyKey`) and the cross-references between row families, the shapes appear to have evolved as direct DurableTable schemas BEFORE the channel abstraction landed. Channels were retrofitted on top — they inherited the table shapes because changing the schemas would have been a coordinated cross-package migration. The schemas are the channel abstraction's birth defect.

## The unified shape

Above durable-streams, every input-delivery operation is the same shape:

```ts
appendEvent(stream: StreamUrl, payload: Payload): Effect<Offset>
read(stream: StreamUrl): Stream<Event<Payload>>
```

That's the durable signal primitive, expressed as channels:

```ts
type DurableEventChannel<P extends Schema.Schema.Any> = EgressChannel<P, EventOffset>

interface EventOffset {
  readonly offset: string         // opaque, lexicographically sortable
  readonly deduplicated: boolean  // optional; absent for first-class idempotency
}
```

All seven specialized channels above reduce to this single shape, parameterized by their payload schema. Different operations differ in their `Payload` type and in which stream they target — nothing else.

```ts
// Before
HostPromptChannel               → EgressChannel<PublicPromptRequest, RuntimeInputIntentRow>
HostPermissionRespondChannel    → CallableChannel<Req, PermissionRespondOutput>
HostSessionsStartChannel        → CallableChannel<Req, RuntimeStartRequestAck>

// After
HostPromptChannel               → DurableEventChannel<PublicPromptRequest>
HostPermissionRespondChannel    → DurableEventChannel<PermissionDecisionPayload>
HostSessionsStartChannel        → DurableEventChannel<SessionStartPayload>
```

The cross-row id references collapse into payload correlation:

```ts
// Before: PermissionRespondOutput { responded, contextId, permissionRequestId, inputId }
// After:  PermissionDecisionPayload { permissionRequestId, decision }
//         The signal name = permission decision; the executionId derives from
//         (contextId, permissionRequestId). Correlation IS the key.
```

The synchronous-derivation channels stay callable but stop wrapping append receipts:

```ts
// Before: HostSessionsCreateOrLoadChannel returns SessionHandleReference (a derivation)
// After:  Same — but documented as "synchronous derivation, no event emitted."
//         The session lifecycle event is a separate DurableEventChannel.
```

The lifecycle-status fields disappear:

```ts
// Before: RuntimeInputIntentRow.status: "pending" | "sequenced" | "cancelled"
// After:  The consumer (workflow body) owns the lifecycle. Status is workflow
//         engine execution state (executions.finalResult), not a row column.
```

The `inserted: boolean` field disappears:

```ts
// Before: { requestId, contextId, inserted: true }
// After:  void / { offset }. Idempotency is at the wire (Producer-Seq); the
//         producer always sees success on a successful append, whether or not
//         this particular bytes-payload was deduped server-side.
```

The `kind` discriminator in `RuntimeInputIntentRow` migrates into payload-discriminated event types:

```ts
// Before: One row schema with kind: "message" | "control" | "tool_result" |
//         "required_action_result". One channel writes all of them.
// After:  Separate DurableEventChannels per event family — PromptChannel,
//         ControlChannel, ToolResultChannel, RequiredActionResultChannel —
//         or one channel with a discriminated payload schema. The choice is
//         consumer-driven (do consumers care about the discriminator at the
//         channel level, or only at the payload level?) but the discriminator
//         is no longer a row column.
```

The monolithic `RuntimeControlPlaneTable` splits into per-consumer streams:

```ts
// Before: One DurableTable with N row families
// After:  One DurableStream per consumer execution (events for that body)
//         + small index/registry mappings (e.g. contextId → executionId)
```

## What this lets the simulation drop in cleanly

Under the unified shape, the `unified-kernel-validation` simulation's signal-based subscribers become a literal drop-in:

```ts
// Production Firegrid client, unchanged:
const firegrid = yield* Firegrid
yield* firegrid.prompt({ contextId, payload })

// Routes through HostPromptChannel — which under the unified shape is just
// a DurableEventChannel<PublicPromptRequest>. The binding:

makeDurableEventChannel({
  target: HostPromptChannelTarget,
  schema: PublicPromptRequestSchema,
  append: (request) =>
    sendSignal({
      signals,
      workflow: RuntimeContextSessionWorkflow,
      executionId: sessionExecutionIdFor(request.contextId),
      name: request.idempotencyKey ?? generateName(),
      value: { kind: "prompt", payloadJson: JSON.stringify(request.payload) },
      ...
    }),
})
```

No synthesis of `RuntimeInputIntentRow`. No `inserted: boolean` decision. No `inputId` cross-reference. The channel binding is a thin adapter from request payload to signal append. The simulation's host swaps the production runtime's input loop subscribers for signal-based ones; the channels stay; the Firegrid client SDK is consumed unchanged.

## Migration strategy

The collapse touches `@firegrid/protocol/channels/*` (response schemas), `@firegrid/protocol/launch/host-control-request.ts` (binding factories), and any consumer reading the now-removed fields. Sequenced for safe rollout:

**Phase 1 — Response shape decoupling.** Introduce `DurableEventChannel<P>` as a sibling to `EgressChannel<S, Receipt>` in `@firegrid/protocol/channels/core.ts`. Existing channels stay untouched. The new shape returns `void` or `{ offset, deduplicated }`. Document the durable-streams alignment.

**Phase 2 — Per-channel migration.** For each of the seven shapes above, introduce a sibling Tag (`HostPromptDurableEventChannel`, etc.) using `DurableEventChannel<PayloadSchema>`. Both old and new Tags coexist; consumers opt into the new shape. Old Tags marked deprecated.

**Phase 3 — Signal-based bindings land.** The new Tags' Live Layers use signal-based subscribers (the simulation's pattern). The old Tags continue to route through Shape C / `RuntimeControlPlaneTable.inputIntents`. Production runs both paths in parallel; observability captures which path each call took.

**Phase 4 — Consumer migration.** Update `firegrid.prompt`, `firegrid.permissions.respond`, etc. to dispatch through the new Tags. Old Tags become unreachable from the public client surface.

**Phase 5 — Remove the old Tags + Shape C subscribers + the monolithic table families.** Delete `inputIntents`, `permissionRequests`, `startRequests` from `RuntimeControlPlaneTable`. The `contexts` family stays (it's a small derivation index, not an event log). Per-execution event streams replace the per-row-family storage.

Each phase is independently shippable. Phases 1–3 establish the unified abstraction in parallel with the existing system; phase 4 flips production to the new path; phase 5 is cleanup.

## Strategic claim

Firegrid's public abstractions — durable-streams beneath, channels above — are exactly the right primitives. The friction in the rip-and-replace is not in the abstractions themselves; it's in the specialized **response schemas** that accreted before either abstraction was stable. Once those schemas collapse to one durable-event shape, the `unified-kernel-validation` simulation becomes a drop-in reference for production subscriber replacement, not a hand-waved analogy. The protocol layer stops being seven historical patterns wearing a channel disguise and becomes what it should always have been: a thin typed surface over durable-streams' append-only log.

## Open questions

1. **`inserted: boolean` consumer audit.** Are there production consumers that branch on `inserted` for any reason other than logging? If yes, those branches need a different signal (e.g., observable retry-attempt counters on the producer side) before we can drop the field.

2. **`inputId` consumer audit.** Same question for `PermissionRespondOutput.inputId` — are downstream consumers correlating responses to requests via this id? If yes, the migration needs a documented "correlation by signal name" alternative.

3. **`kind` discriminator placement.** Do we keep one event channel per agent body with payload-level discrimination, or split into multiple typed channels (PromptChannel, ToolResultChannel, ControlChannel, ...)? The first is fewer channels; the second is stronger typing. The simulation uses payload-level discrimination today; production may want the split for ergonomics.

4. **`RuntimeControlPlaneTable.contexts` and `sessions`.** These are derivation indexes (contextId → metadata), not event logs. Do they stay as DurableTable families, or do they become derived state over a `context-lifecycle` event stream (per the state-protocol's change-message model)? Either is defensible; the simulation has no opinion.

5. **OTel propagation through the collapsed shape.** Production rows carry `_otel: RowOtelContext` for span linkage. Under the unified shape this lives in event metadata (durable-streams supports `headers.txid`). Mapping is mechanical but needs a small protocol decision about which header carries what.

## Cross-references

- `https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md` — the bedrock
- `https://github.com/durable-streams/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md` — change-message extension
- `packages/tiny-firegrid/src/simulations/unified-kernel-validation/` — empirical proof of the subscriber pattern
- `packages/protocol/src/channels/core.ts` — where `DurableEventChannel<P>` would land
- `packages/protocol/src/channels/host-control.ts` — the seven specialized Tags this SDD proposes to collapse
- `packages/protocol/src/launch/host-control-request.ts` — the binding factories that mirror the response shapes
- `packages/runtime/src/channels/router.ts` — `HostPlaneChannelRouter` (downstream routing untouched by this collapse)
- `docs/architecture/unified-subscriber-kernel.md` — subscriber-side collapse this SDD completes
