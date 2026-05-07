# Firegrid → Durable Streams State Protocol Mapping Audit

Date: 2026-05-07
Status: Spike output (no code change). Spike #2 from `SDD_FIREGRID_RUNTIME_ERGONOMICS.md` "Spike Plan."
Branch: `agent5/fg-state-protocol-mapping-audit` (clean-base on `origin/main` `eb7735c`).

## Spike Boundary

This audit tests **Firegrid mapping/impedance only** against the upstream
Durable Streams + Durable Streams State Protocol. It does **not**:

- instantiate `@durable-streams/state` to prove materialization (upstream
  owns that behavior);
- exercise the upstream protocol via a scratch encoder/decoder;
- propose feature-spec edits;
- modify any source file under `packages/`;
- touch the Durable Clock spike (surface:66 owns that) or operation
  lifecycle (surface:81 owns that);
- review or merge PR #120.

The output is a categorized mapping table plus a verdict on which Firegrid
mechanics already ride the upstream protocol, which carry justified
descriptor payloads, which are load-bearing Firegrid extensions, and which
are candidates for collapse if upstream protocols are fully adopted.

## Source Of Truth Surveyed

Inventory was derived from `origin/main` `eb7735c` only. Files surveyed:

```text
packages/substrate/src/protocol/schema/rows.ts
packages/substrate/src/protocol/schema/state.ts
packages/substrate/src/protocol/state-machine.ts
packages/substrate/src/protocol/descriptors/operation.ts
packages/substrate/src/protocol/descriptors/event-stream.ts
packages/substrate/src/protocol/descriptors/append.ts
packages/substrate/src/event-plane/define.ts
packages/substrate/src/event-plane/producer.ts
packages/substrate/src/event-plane/projection.ts
packages/substrate/src/event-plane/layer.ts
packages/substrate/src/state-store/stream.ts
packages/substrate/src/state-store/retained-records.ts
packages/substrate/src/read-models/projection.ts
packages/substrate/src/read-models/ready-work.ts
packages/substrate/src/coordination/run-wait/service.ts
packages/substrate/src/execution/operator.ts
packages/substrate/src/execution/claims.ts
packages/substrate/src/execution/waits.ts
packages/substrate/src/execution/subscribers.ts
packages/substrate/src/write-api/producer.ts
packages/substrate/src/kernel/index.ts
packages/substrate/src/index.ts
packages/runtime/src/runtime-api.ts
packages/runtime/src/internal/event-stream-materializer.ts
packages/runtime/src/internal/runner.ts
packages/client/src/operations.ts
features/firegrid/durable-records-and-projections.feature.yaml
features/firegrid/awakeables-and-runs.feature.yaml
features/firegrid/claim-and-operator-authority.feature.yaml
features/firegrid/firegrid-event-streams.feature.yaml
features/firegrid/client-event-plane-registration.feature.yaml
features/firegrid/firegrid-durable-subscriber-webhooks.feature.yaml
features/firegrid/firegrid-runtime-presence.feature.yaml
features/firegrid/firegrid-platform-invariants.feature.yaml
```

## Findings Summary

Firegrid is already partially aligned with the State Protocol. The
canonical substrate state schema is built with `createStateSchema(...)`
from `@durable-streams/state` (see
`packages/substrate/src/protocol/schema/state.ts`), and every foundational
collection (`runs`, `completions`, `claimAttempts`, `eventStreams`) declares
`type` (row family) and `primaryKey` consistent with the State Protocol's
`type`/`key`/`headers.operation`/`value` shape. Append goes through
`appendChange(target, change, mapError)` which writes `JSON.stringify(change)`
where `change` is a State Protocol `StateEvent` produced by the State
helpers (`substrateState.runs.insert({ value })`, `…upsert`, etc.).

Three Firegrid mechanics, however, do **not** lower to upstream protocols
as-is:

1. **First-valid-terminal-wins fold** for runs, completions, and claims.
   State Protocol materialization is "latest write wins per `(type, key)`";
   Firegrid's authority is "first valid terminal in stream order wins."
   This is computed via `retained-records.ts` (raw `stream({ live: false,
   offset: "-1" })` reader plus `foldRunRecords` /
   `foldCompletionRecords` / claim-winner derivation), not via the
   StreamDB live state. This is the load-bearing Firegrid extension.

2. **State-machine transition legality** for runs and completions
   (`packages/substrate/src/protocol/state-machine.ts`). The upstream
   protocol does not opine on which `(prev_state, next_state)` transitions
   are legal; Firegrid validates the transition *before* appending the
   `ChangeEvent` and fails with `IllegalRunTransition` /
   `IllegalCompletionTransition`. This is descriptor-level domain logic
   above State Protocol.

3. **Per-kind completion data** (timer / projection_match / scheduled_work
   / etc.). The completion row's `data` is `Schema.Unknown` at the State
   Protocol value level; Firegrid layers per-kind payload schemas
   (`TimerCompletionData`, `ProjectionMatchCompletionData`,
   `ScheduledWorkCompletionData`) decoded at use sites. This is a justified
   descriptor payload, not a protocol extension.

Two areas are clearly redundant if upstream is fully adopted:

A. **Producer idempotency header plumbing** (`PlaneProducer.emit` and
   `WorkProducer.declareWork` add `idempotencyKey` as a `ChangeEvent`
   header via a `Record<string, string>` cast on `ChangeHeaders`). If the
   Durable Streams base protocol's idempotent producer semantics cover
   this case, Firegrid's parallel header-based dedup is redundant. The
   spike does not validate this against upstream behavior, but flags the
   collapse target.

B. **`firegrid.event` envelope-in-value** (`{_envelope: "firegrid/event@1",
   stream, event}` wrapped inside the State Protocol `value`). One State
   Protocol collection per EventStream descriptor (with `type =
   <stream-name>`, `primaryKey = eventId`, schema = the caller-owned event
   schema) would remove the envelope and let raw `ChangeEvent.value` carry
   the typed event directly. This collapse is currently blocked by a
   different concern: keeping all EventStream rows in one
   `eventStreams` collection lets Firegrid reuse one preloaded
   `StreamDB` for all caller streams; per-stream collections would
   multiply state overhead unless the runtime layer stays.

## Mapping Table

Each row reports: Firegrid concept, current owner file/spec, proposed State
Protocol shape (`type` / `key` / `headers.operation` / `value`),
partition/idempotency notes, and one of four statuses:

- **clean** — already maps onto State Protocol with no Firegrid extension;
- **descriptor payload** — maps onto State Protocol; carries a Firegrid or
  caller descriptor schema as the `value` payload;
- **extension** — requires Firegrid logic the State Protocol does not
  express;
- **delete/refactor** — redundant if upstream is adopted, or worth
  removing for ergonomics regardless.

| # | Firegrid concept | Owner | type | key | headers.operation | value | Partition / idempotency | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Run lifecycle | `protocol/schema/rows.ts` `RunValue`; state machine in `protocol/state-machine.ts`; `awakeables-and-runs.feature.yaml`, `durable-records-and-projections.RECORDS.6` | `durable.run` | `runId` | `insert` (start) / `upsert` (transitions) | `RunValue` `{runId, state, blockedOnCompletionId?, data?, result?, error?, terminalReason?}` | Partition: by `runId`. Idempotency: `idempotencyKey` carried as `ChangeEvent.headers` extra; declare/start dedup is Firegrid-side via header lookup over retained rows. | **descriptor payload** (transitions are clean upserts; `data` carries Operation envelope) |
| 2 | Run state-machine transition legality | `protocol/state-machine.ts` (`runTransitionMachine`, `IllegalRunTransition`); `awakeables-and-runs.RUN_TRANSITIONS.*` | (no row) | (no row) | (no row) | (no row) | Validates `(prev, next)` before append; State Protocol has no transition opinion. | **extension** |
| 3 | Run terminal authority (first-valid-terminal-wins over `durable.run`) | `protocol/state-machine.ts` `foldRunRecords`; `state-store/retained-records.ts` `readRetainedRunRecords` | `durable.run` (read raw retained rows) | `runId` | n/a (read path) | n/a (read path) | Read uses raw `@durable-streams/client` `stream({ live: false, offset: "-1" })` so multiple retained inserts/upserts are visible in append order. State Protocol live materialization gives latest-by-key only. | **extension** |
| 4 | Completion lifecycle | `RunValue.data` carries operation envelope; `protocol/schema/rows.ts` `CompletionValue`; `awakeables-and-runs.AWAKEABLE.*`, `durable-records-and-projections.RECORDS.7` | `durable.completion` | `completionId` | `insert` (pending) / `upsert` (terminal) | `CompletionValue` `{completionId, workId?, kind, state, data?, terminal fields}` | Partition: by `completionId`. Idempotency: awakeable keys (`awk:work:<workId>:<name>`, `awk:global:<ns>:<name>`) per `durable-waits-and-scheduling.AWAKEABLE_API.4-7` are caller-derived and used as `completionId`; same key returns the existing id. | **descriptor payload** (per-kind `data` schemas; same status as #1) |
| 5 | Per-kind completion `data` schemas | `protocol/schema/rows.ts` `TimerCompletionData`, `ScheduledWorkCompletionData`, `ProjectionMatchCompletionData` | `durable.completion` | `completionId` | (whichever) | `value.data: <per-kind schema>` decoded at use site | n/a | **descriptor payload** |
| 6 | Completion terminal authority (first-valid-terminal-wins) | `protocol/state-machine.ts` `foldCompletionRecords`; retained-records reader | `durable.completion` (raw retained read) | `completionId` | n/a | n/a | Same as #3. | **extension** |
| 7 | Claim attempts | `protocol/schema/rows.ts` `ClaimAttemptValue`; `claim-and-operator-authority.CLAIM_ATTEMPT.*` | `durable.claim.attempt` | `claimId` (per-attempt; multiple attempts per `workId`) | `insert` only | `ClaimAttemptValue` `{claimId, workId, ownerId, observedCursor, status="attempted"}` | Partition: each attempt is its own row. Idempotency: none — duplicate attempts are evidence (`CLAIM_AUTHORITY.2`). | **clean** (per-attempt rows) |
| 8 | Winning-claim derivation | `state-store/retained-records.ts` `readRetainedClaimAttempts`; `claim-and-operator-authority.CLAIM_AUTHORITY.1-7` | `durable.claim.attempt` (raw retained read) | filter by `workId` | n/a | n/a | Winner = first attempt for a `workId` in stream order; State Protocol latest-by-key cannot express this because each attempt has a distinct primary key. | **extension** |
| 9 | EventStream rows (Firegrid envelope) | `protocol/schema/rows.ts` `EventStreamValue`; `protocol/descriptors/event-stream.ts`; `firegrid-event-streams.*` | `firegrid.event` | `${streamName}:${eventId}` | `insert` only | `{_envelope: "firegrid/event@1", stream, event}` (caller-owned `event` payload) | Partition: by stream-scoped key. Idempotency: caller-supplied `eventId` deduplicates by primary-key collision under State Protocol's `insert` semantics. | **descriptor payload** |
| 10 | EventStream envelope as a row family | same as #9 | same | same | same | The `{_envelope, stream, event}` wrapper unifies all caller streams under one collection. | n/a | **delete/refactor** (collapse target — see "Redundancy" §A2) |
| 11 | OperationEnvelope (carried inside `durable.run.data`) | `protocol/descriptors/operation.ts` `OperationEnvelopeSchema`; `firegrid-operation-messaging.*` | (no row of its own) | (no row) | (no row) | embedded in `RunValue.data` as `{_envelope: "firegrid/operation@1", operation, payload}` | Partition: same as run. Idempotency: client `idempotencyKey` lookup walks `durable.run` rows and returns existing `runId` if the header matches. | **descriptor payload** (envelope-in-data) |
| 12 | OperationEnvelope as a separate row family | same | (proposed) `firegrid.operation.invocation` | `runId` | `insert` | `{operation, payload}` | Same partition as run. Would let State Protocol materialize "this run was invoked with operation X" without read-side decode of `RunValue.data`. | **delete/refactor** (collapse target — see "Redundancy" §A3) |
| 13 | App-owned EventPlane rows | `event-plane/define.ts`, `event-plane/producer.ts`; `client-event-plane-registration.*` | caller-declared `type` per collection | caller-declared `primaryKey` per collection | per State Protocol semantics (`insert` / `update` / `delete`) | caller-owned schema | Caller owns partition/idempotency policy; producer adds `idempotencyKey` / `correlationId` / `causationId` / `extra` to `ChangeEvent.headers`. | **clean** |
| 14 | Producer idempotency (substrate) | `write-api/producer.ts` `withIdempotencyHeader`; `event-plane/producer.ts` `mergeMetadataIntoHeaders` | (header on existing rows) | n/a | n/a | n/a | Header-based dedup; the substrate walks retained rows on `declareWork` to find an existing row with the same `idempotencyKey`. Parallel to upstream HTTP producer-key semantics. | **delete/refactor** (collapse target — see "Redundancy" §A1) |
| 15 | Producer correlation/causation/extra headers | `event-plane/producer.ts` `ProducerMetadata` | (headers on existing rows) | n/a | n/a | n/a | Cast onto `ChangeHeaders` via `Record<string, string>`. | **descriptor payload** (caller-owned header convention) |
| 16 | Trace observability | `protocol/schema/rows.ts` `TraceValue`, `TraceRowType="durable.trace"`; `durable-records-and-projections.RECORDS.8` | `durable.trace` | not declared as a State Protocol collection (excluded from `substrateState`) | append-only via raw `appendChange` | `{traceId, kind, data?}` | Not materialized; observability only. | **extension** (intentional — observability outside materialization) |
| 17 | RunWait projection-match (snapshot-then-follow) | `coordination/run-wait/service.ts`; `run-wait-primitives.RUN_WAIT_API.*`; `durable-records-and-projections.PROJECTIONS.8` | uses `durable.completion` rows + caller projection rows | various | n/a | n/a | Relies on State Protocol's snapshot boundary / no-gap cursor semantics for the snapshot/follow boundary. | **clean** (depends on upstream cursor guarantees) |
| 18 | Ready-work derivation | `read-models/ready-work.ts` `deriveReadyWork`; `ready-work-projection.*` | derived from `durable.run` + `durable.completion` materialized State | n/a | n/a | n/a | Pure fold over materialized live state. | **clean** |
| 19 | Awakeable key conventions (`awk:work:<workId>:<name>`, `awk:global:<ns>:<name>`) | `execution/waits.ts`; `durable-waits-and-scheduling.AWAKEABLE_API.4-7` | `durable.completion` | `completionId = <key>` | `insert` (idempotent: same key → existing row) | `CompletionValue` with caller awakeable kind | Partition: by completion key. Idempotency: primary-key collision under State Protocol `insert`. | **descriptor payload** (key convention is Firegrid; row stays clean) |
| 20 | Substrate `WorkProducer` (`declareWork`) | `write-api/producer.ts` | `durable.run` | `runId` | `insert` | `RunValue { state: "started", data? }` | Caller may pass `idempotencyKey`; declare walks retained rows for existing match. | **descriptor payload** + **delete/refactor** (idempotency redundant per §A1) |
| 21 | Future durable-subscriber delivery rows (channel mechanics) | `firegrid-durable-subscriber-webhooks.CHANNEL_DESCRIPTOR.*`, `DELIVERY_PRODUCER.*`, `DELIVERY_PROJECTION.*` | caller-declared row family | caller-declared key (delivery key + completion key) | per State Protocol | caller-owned delivery / completion / conflict / dead-letter schemas | Partition by `OrderingScope`; idempotency by caller-derived delivery key. | **clean** (spec is explicit: caller-owned EventPlane rows, no Firegrid-native subscriber row family) |
| 22 | Future runtime presence rows | `firegrid-runtime-presence.DESCRIPTOR.*`, `LIFECYCLE.*` | caller-owned EventPlane | caller-declared | per State Protocol | presence descriptor (runtime id, host id, ingress endpoints, readiness, freshness) | Partition by `runtimeId`; identity opaque to Firegrid. | **clean** (advisory, no fencing) |
| 23 | Future claimed-intent transport rows | `firegrid-claimed-intent-transport.*` | caller-owned EventPlane + `durable.claim.attempt` | caller-declared | per State Protocol | caller intent payload | Partition by intent ordering scope; claim mechanics reuse #7/#8. | **clean** (composes existing claim mechanics) |

## Redundancy Analysis (if upstream is fully adopted)

### A1. Producer idempotency header plumbing → Durable Streams producer semantics

**Current code:**
- `packages/substrate/src/write-api/producer.ts:104-141` —
  `withIdempotencyHeader(event, idempotencyKey)` mutates
  `ChangeEvent.headers` and `declareWork` walks retained rows to detect
  duplicates;
- `packages/substrate/src/event-plane/producer.ts:73-89` —
  `mergeMetadataIntoHeaders` casts `ChangeHeaders` to `Record<string,
  string>` to layer `idempotencyKey` / `correlationId` / `causationId` /
  `extra`.

**Collapse target:** Durable Streams base protocol's documented idempotent
producer semantics (HTTP-level idempotency keys + caching/collapsing per
the SDD's reference to upstream PROTOCOL.md). If those upstream semantics
suppress duplicate appends at write time, Firegrid does not need its own
header-walk dedup on `declareWork`. EventPlane producer metadata can stay
as caller-owned correlation/causation headers (no idempotency duplication).

**What to verify before deletion (out of scope for this spike):**
- whether the upstream producer-key semantics survive across stream
  restart and reconnection;
- whether they cover the Firegrid case where idempotency must yield the
  *same `runId`* (Firegrid currently returns the existing `runId` on
  duplicate `declareWork`; HTTP-level idempotency may only suppress the
  byte-stream append).

### A2. `firegrid.event` envelope-in-value → per-stream State Protocol collections

**Current code:**
- `packages/substrate/src/protocol/schema/rows.ts:201-206` —
  `EventStreamValue` wraps caller events in `{_envelope, stream, event}`;
- `packages/substrate/src/protocol/descriptors/event-stream.ts:30-49` —
  `eventStreamStateKey(streamName, eventId)` colocates all streams in one
  `eventStreams` collection.

**Collapse target:** each `EventStream` descriptor becomes its own State
Protocol collection (`type = <stream-name>`, `primaryKey = "eventId"`,
schema = caller event schema). Removing the envelope lets readers consume
typed events without a Firegrid decode step.

**Cost of collapse:** the runtime currently preloads one `StreamDB` per
plane and reuses it. Per-stream collections multiply that cost unless the
runtime layer stays a single multi-collection State schema or the runtime
shifts to lazy per-stream materialization.

### A3. OperationEnvelope-in-`durable.run.data` → standalone invocation row

**Current code:**
- `packages/substrate/src/protocol/schema/rows.ts:157-164` —
  `OperationEnvelopeSchema` lives inside `RunValue.data`;
- `packages/runtime/src/internal/operation-handler.ts` (per inventory) —
  decodes the envelope on dispatch.

**Collapse target:** a separate State Protocol collection
(provisional `firegrid.operation.invocation`, key=`runId`, value=`{operation,
payload}`). Run lifecycle stays on `durable.run`. The materialized
projection joins the two by `runId`. Browser/runtime readers no longer
need to decode `RunValue.data` shape to know what was invoked.

**Cost of collapse:** two writes per invocation (one to
`firegrid.operation.invocation`, one to `durable.run`). Order matters:
the invocation row should land before the start-run row so a reader can
trust the join. Idempotency must apply to both rows.

### A4. `retained-records.ts` raw-stream readers — cannot collapse without protocol extension

**Current code:**
- `packages/substrate/src/state-store/retained-records.ts` reads raw
  `ChangeEvent`s with `stream({ live: false, offset: "-1" })` and folds
  them in append order.

**Why not collapsible:** this is the implementation of A3-style
"first-valid-terminal-wins." State Protocol materialization gives
latest-by-key, not first-terminal-by-key. Removing the raw reader
requires either (a) Firegrid layering a fold projection over State
Protocol control messages, or (b) upstream State Protocol extending its
materialization rules with first-terminal-wins semantics. Option (a) is a
Firegrid-internal refactor; option (b) is upstream surface area Firegrid
should not assume.

**Recommendation:** keep the retained-records reader as the
implementation of the first-valid-terminal-wins extension, but document
it as "Firegrid extension over State Protocol" rather than "parallel
read path."

### A5. Header-cast plumbing — narrow refactor candidate

**Current code:** `event-plane/producer.ts:73-89` casts a built
`Record<string, string>` to `ChangeHeaders`. This is a
documentation/typing weakness, not a protocol mismatch.

**Collapse target:** if upstream State helpers expose a
producer-metadata API that accepts a closed extras shape (per the SDD
"State Protocol message format" lesson), Firegrid can drop the cast.

## Firegrid Semantics Not Represented By Upstream Protocols

These are the load-bearing Firegrid extensions. Each is a candidate for
either (i) staying as a Firegrid descriptor extension above State
Protocol, or (ii) escalating upstream if the same pattern repeats across
products.

1. **First-valid-terminal-wins fold** for runs, completions, and claim
   winners. State Protocol gives latest-by-key; Firegrid needs
   first-terminal-by-key in append order. Owners: rows.ts terminal fold
   helpers + retained-records reader.

2. **State-machine transition legality** for runs and completions
   (`runTransitionMachine`, `completionTransitionMachine` in
   `protocol/state-machine.ts`). State Protocol has no transition opinion.

3. **Per-attempt evidence rows for claim authority** (each
   `durable.claim.attempt` is its own row keyed by `claimId`). State
   Protocol cleanly carries the rows; the *winner derivation rule* is the
   Firegrid extension.

4. **Per-kind completion `data` schemas** (timer / projection_match /
   scheduled_work / fan_in / child_run / externally_resolved_awakeable).
   These are caller-decoded inside an `Unknown` value field; State
   Protocol does not type the `data` payload.

5. **Awakeable key namespacing rule** (`awk:work:<workId>:<name>` vs
   `awk:global:<ns>:<name>`). Caller-derived primary key rule; the row
   itself is clean.

6. **Operator authority / claim-before-invoke ordering** — handler
   invocation is gated on observing a winning durable claim attempt.
   State Protocol has no opinion on side-effect ordering.

7. **EventStream envelope** (`{_envelope, stream, event}`) unifying
   caller-owned schemas under one row type. Firegrid-specific value shape
   above State Protocol.

8. **Operation envelope** (`{_envelope, operation, payload}`) embedded in
   `RunValue.data`. Same pattern as #7 but inside `data` rather than
   value-as-row.

9. **`durable.trace` observability rows** explicitly excluded from
   `substrateState` (no State Protocol collection, no materialization).
   Append-only via raw `appendChange`.

10. **Producer correlation/causation/extra headers** convention
    (`ProducerMetadata`). Caller-owned header keys on `ChangeEvent`;
    Firegrid does not own the schema.

11. **Snapshot-then-follow boundary discipline** for projection-match
    waits — Firegrid requires a no-gap cursor boundary or a typed
    unsupported error. Maps onto State Protocol cursor semantics, but
    Firegrid owns the discipline.

12. **`@firegrid/substrate` curated public surface** (descriptors,
    `event-plane`, `id-gen`) with kernel-only internals — package
    discipline above the protocol layer.

## Code That Becomes Redundant If Upstream Is Adopted

Listed in increasing order of refactor cost.

1. `mergeMetadataIntoHeaders` `ChangeHeaders` cast in
   `event-plane/producer.ts` — narrow type cleanup. Independent of
   upstream changes.
2. `idempotencyKey` header plumbing in
   `write-api/producer.ts` (`withIdempotencyHeader`, `declareWork`
   retained-row scan). Collapses to upstream producer-key semantics if
   they preserve `runId` identity across duplicate appends.
3. `idempotencyKey` field on `ProducerMetadata` in
   `event-plane/producer.ts` — collapses with #2 if upstream covers
   EventPlane append idempotency.
4. EventStream `_envelope` wrapper (`EventStreamValue`,
   `EventStreamStateRow`, `eventStreamStateKey`,
   `makeEventStreamEnvelope`) — collapses if EventStream descriptors
   become first-class State Protocol collections (per A2).
5. Operation envelope embedded in `RunValue.data`
   (`OperationEnvelopeSchema`, `isOperationEnvelope`) — collapses if a
   standalone invocation row is added (per A3); requires runtime handler
   dispatch to read the new collection.
6. `LegacyProjectionMatchCompletionData` decoder branch in
   `protocol/schema/rows.ts:113-153` — already a backwards-compat shim
   for an older inner-trigger shape; deletable on the next ergonomics
   refactor regardless of upstream alignment.

`retained-records.ts` is **not** redundant — it implements the
first-valid-terminal-wins extension and stays as the canonical Firegrid
read path for terminal authority.

## Verdict

Firegrid's foundational substrate is mostly aligned with the Durable
Streams + State Protocol vocabulary. The State Protocol shape (`type` /
`key` / `headers.operation` / `value`) already covers the four
authoritative collections (`runs`, `completions`, `claimAttempts`,
`eventStreams`) and every app-owned EventPlane. There is **no Firegrid
row family that fundamentally cannot be expressed as a State Protocol
message**.

The Firegrid extensions that remain load-bearing are:

1. first-valid-terminal-wins fold (runs, completions, claim winners);
2. state-machine transition legality (runs, completions);
3. claim-before-invoke ordering;
4. per-kind / per-stream / operation descriptor payloads inside otherwise
   clean State Protocol values.

The redundancy candidates are:

A. producer idempotency header plumbing (parallel to upstream HTTP
   producer-key semantics);
B. `firegrid.event` envelope-in-value (collapsible to per-stream State
   Protocol collections at the cost of multiple `StreamDB`s);
C. operation envelope in `RunValue.data` (collapsible to a standalone
   invocation row at the cost of a second write per invocation).

None of A/B/C is required to make the runtime ergonomics SDD's stream-graph
direction land. They are independent cleanup wins.

## Next Substrate Decision Unlocked

**Decision:** is `packages/substrate` worth re-centering around the State
Protocol vocabulary directly (with first-valid-terminal-wins as the *one*
documented Firegrid extension), or does it stay layered on the current
authority row families?

The audit answers a precondition for that decision: the current layering
is already 80% protocol-aligned, with the impedance concentrated in three
places (terminal-wins fold, transition legality, descriptor envelopes).
Re-centering substrate around State Protocol does not require ripping out
authority rows — it requires:

- documenting first-valid-terminal-wins as Firegrid's *only* protocol
  extension and keeping the retained-records reader as its implementation;
- collapsing redundancy candidates A1/A2/A3 if and when the runtime
  ergonomics SDD's stream-graph primitive lands (since the graph will
  re-shape what processors consume and produce);
- declining to add new Firegrid-native row families for durable
  subscribers, runtime presence, claimed-intent, or scheduling — those
  specs are already explicitly caller-owned EventPlane.

This is consistent with the SDD's `STATE_PROTOCOL_ALIGNMENT` candidate
spec component: app-owned state changes use State Protocol
insert/update/delete/control messages by default; Firegrid-specific
durable row families require feature-spec justification. The audit shows
the current substrate already meets that bar on the read/write boundary;
the remaining work is descriptor-payload cleanup and producer-idempotency
collapse, not protocol replacement.

## Spike Output Manifest

- Files changed: `docs/research/firegrid-state-protocol-mapping.md`
  (new, this artifact). No source/spec edits.
- Commands run: `git fetch origin`; `git worktree add -b
  agent5/fg-state-protocol-mapping-audit
  .worktrees/fg-state-protocol-mapping-audit origin/main`; `pnpm
  check:docs` (passing); `git diff --check` (clean).
- Branch HEAD: `agent5/fg-state-protocol-mapping-audit` on `origin/main`
  `eb7735c`.
- Out-of-scope confirmed: did not instantiate `@durable-streams/state`;
  did not encode/decode a representative row through a scratch adapter;
  did not touch Durable Clock spike, operation-lifecycle spike, or PR
  #120.
