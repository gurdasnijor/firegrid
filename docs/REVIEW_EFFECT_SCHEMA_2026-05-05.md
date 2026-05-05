# Effect-TS Schema Review — Firegrid (2026-05-05)

Scope: substrate, client, runtime — schema definitions, encode/decode boundaries, branded types, envelope helpers, type guards. Tests, scripts, and docs excluded. Layer-factory configuration interfaces (`FiregridClientConfig`, `WorkClaimLiveConfig`, etc.) are intentionally non-Effect surfaces and are out of scope per the configuration review.

## Summary

Firegrid is in a healthy schema-first posture for wire data. Substrate row families (`RunValue`, `CompletionValue`, `ClaimAttemptValue`, `EventStreamValue`, `TraceValue`) are `Schema.Struct` in `packages/substrate/src/schema/rows.ts`, the durable-streams State schema is built from those declarations in `schema/state.ts`, and `ReadyWorkItem` is in `schema/ready-work.ts`. Descriptors (`Operation`, `EventStream`) hold caller-owned schemas as first-class fields. Encode/decode at every boundary goes through `Schema.encodeUnknown` / `Schema.decodeUnknown` with typed `ParseError`-mapped errors, never ad-hoc `JSON.parse`. R0/R0B landed declarative state-machine adjacency maps with `Data.TaggedError` errors.

Where the codebase still drifts from the schema skill: (1) the `Schema.Schema.AnyNoContext` cast is duplicated nine times across four files; (2) per-kind `completion.data` decoders flagged in R0 review §C4 are still inline `as` casts in `subscribers.ts`; (3) trigger / wait IO-boundary types are plain `interface`s while their values are durably written into `completion.data`; (4) envelope helpers and row builders that the original review §3g/§5 wanted in `schema/` still live under `descriptors/`; (5) hand-rolled type guards (`isOperationEnvelope`, `isEventStreamEnvelope`, `isEventStreamStateRow`) shadow the `Schema.is` pattern the skill prefers; (6) brands in `choreography/branded.ts` use `Brand.nominal` rather than `Schema.brand`. None are bugs — each is a leverage point where Schema would replace defensive imperative code.

## Findings by concept

### 1. `Schema.Schema.AnyNoContext` cast helper centralization

Repeated nine times across four files:

- `packages/client/src/firegrid/operation-client.ts:142, 157, 215`
- `packages/client/src/firegrid/event-client.ts:85, 96`
- `packages/runtime/src/runtime/internal/operation-handler.ts:77, 136, 171`
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:123`

The block comments at `operation-client.ts:131-137` and `operation-handler.ts:163-169` both explain the same rationale: descriptor schema slots are typed `Schema.Schema.All` (which admits `Schema<never, …>` branches), and `decodeUnknown`/`encodeUnknown` need the `AnyNoContext` alias to keep `R = never`. The justification is correct, but copying the cast inline at every call site means the explanation drifts, future changes touch nine sites, and `as` syntax clutters the hot path. A single helper (e.g. `decodeAtBoundary(schema)(value)` / `encodeAtBoundary(schema)(value)`) colocated with the descriptor module — which already owns the type-bound rationale — would erase the cast at every consumer. Code-style review §2 noted this; still open.

### 2. Per-kind `completion.data` decoders (TimerData / ProjectionMatchData / ScheduledWorkData)

R0 review §C4 recommended typed Schema decoders per completion kind. Still open. `subscribers.ts` treats `completion.data` (a `Schema.optional(Schema.Unknown)` slot on `CompletionValue`) by inline `as` cast plus runtime `typeof` checks:

- `subscribers.ts:218-219` — timer: `completion.data as { dueAtMs?: unknown } | undefined` then `typeof data.dueAtMs !== "number"`.
- `subscribers.ts:235-238` — scheduled-work: `completion.data as { whenMs?: unknown; input?: unknown } | undefined` then `typeof data.whenMs !== "number"`.
- `subscribers.ts:347-353` — projection-match: `completion.data as { trigger?: unknown; timeoutMs?: unknown; deadlineAtMs?: unknown } | undefined`.
- `subscribers.ts:360` — `data.trigger as ProjectionMatchTrigger` (no validation).

The durable contract is written from `waits.ts`:

- Timer: `waits.ts:177-181` writes `{ durationMs, dueAtMs }`.
- Projection-match: `waits.ts:199-213` writes `{ trigger, timeoutMs?, deadlineAtMs? }`.
- Scheduled-work: `waits.ts:222-230` writes `{ whenMs, input }`.

Both sides should reference one Schema per kind (`TimerCompletionData`, `ProjectionMatchCompletionData`, `ScheduledWorkCompletionData`) defined alongside `CompletionValue` in `schema/rows.ts`. The subscriber then calls `Schema.decodeUnknown(TimerCompletionData)(completion.data)` and surfaces typed `SubscriberDataError` on `ParseError`. This also resolves detector hits `conditionals/rule-002` at `subscribers.ts:219, 238, 354`.

Natural shape: `CompletionValue` as a discriminated union over `kind`, each branch carrying its own typed `data` — consistent with skill §1 ("tagged unions over optional properties") and the existing `Schema.Literal` for `CompletionKind` at `rows.ts:50-57`.

### 3. Plain interfaces vs Schema.Struct/Schema.Class at IO boundaries

The codebase correctly distinguishes layer-config interfaces (out of scope) from IO-boundary types. Several boundary types are still plain interfaces:

**Durable-write boundary (should be Schema):**

- `waits.ts:49-52` — `ProjectionMatchTrigger` is a plain `interface` AND there is a separate Schema-defined `ProjectionMatchTrigger` at `choreography/triggers.ts:12-16` (`Schema.TaggedStruct("ProjectionMatch", { label, projectionKey, matcherId })`). Two parallel definitions with different shapes: `waits.ts` has `{ kind: "projection_match"; description: unknown }`, `choreography/triggers.ts` has `{ _tag: "ProjectionMatch"; label; projectionKey; matcherId }`. The substrate writes the `waits.ts` shape into `completion.data.trigger`; the subscriber casts to the same shape at `subscribers.ts:360`. The choreography Schema is the right model — collapsing onto one Schema resolves both the duplicate-name confusion and the per-kind decoder gap from §2.
- `waits.ts:22-45` — `SleepResult`, `WaitForResult`, `ScheduleWorkResult`, `AwakeableResult`. Caller-observed Effect success values; `kind`/`state` already point at `CompletionKind`/`CompletionState` literal schemas. Promoting to `Schema.Struct` is a one-line change enabling `Schema.is` narrowing.
- `waits.ts:54-77` — `SleepInput`, `WaitForInput`, `ScheduleWorkInput`, `AwakeableInput`, `AwakeableGlobalInput`. Cross the API boundary into substrate; decoded into `completion.data` durably. Schema would let substrate validate caller input (e.g. `durationMs >= 0`, non-empty `name`) instead of relying on TS-only invariants.

**Already Schema-driven (no change):** `OperationDescriptor` at `descriptors/operation.ts:62-73` and `EventStreamDescriptor` at `descriptors/event-stream.ts:104-111` hold `Schema.Schema.All` slots; the wrapper itself is a value carrier, not a Schema.

**Out of scope (internal layer params, no encode/decode):**

- `subscribers.ts:42-45` (`SubscriberInput`), `:71-73` (`ProjectionMatchSubscriberInput`).
- `stream-resolver.ts:41-50, 82-91, 117-120, 142-147` — `EmbeddedDurableStreamsConfig`, `DurableStreamAdminCreateInput`, `ResolvedStream`, `EmbeddedResolverConfig`.
- `operation-handler.ts:82-87` — `DispatchInput` (internal Effect callback).

### 4. Envelope helpers and row builders: `descriptors/` vs `schema/`

The original review §3g/§5 said envelope helpers and row builders should live under `schema/` because they are Schema-tied wire-shape concerns, not descriptor-side caller types. The current layout drifts from that:

- `packages/substrate/src/descriptors/event-stream.ts:32-49` — `makeEventStreamEnvelope`, `makeEventStreamStateRow` (closes over `substrateState.eventStreams.insert`, which is a row schema concern).
- `packages/substrate/src/descriptors/event-stream.ts:51-80` — `isEventStreamEnvelope`, `isEventStreamStateRow`, `eventStreamEnvelopeFromStateRow` (envelope predicates).
- `packages/substrate/src/descriptors/operation.ts:20-25` — `isOperationEnvelope`.
- `packages/substrate/src/descriptors/append.ts:9-17` — `appendChange` (uses raw `JSON.stringify` over a `StateEvent`).

The descriptor module's stated job is the caller-owned descriptor type plus its `Schema.Schema.All` slots; envelope tag values are already imported from `schema/rows.ts` (`EventStreamEnvelopeTag`, `EventStreamRowType` at `event-stream.ts:1-8`), so the dependency arrow already flows the right direction — only the helpers need to move. Concrete suggestion: move the envelope predicates and row builders into `schema/event-stream.ts` (new file) or `schema/rows.ts`, leaving `descriptors/event-stream.ts` to hold only `EventStreamDescriptor`, `EventStream.define`, `EventStream.Any`, `EventStream.Event`. Same shape for `descriptors/operation.ts` — keep the descriptor type, move `isOperationEnvelope` next to a future `OperationEnvelopeSchema` (see finding §5).

### 5. Hand-rolled type guards vs `Schema.is`

Three guards are written by hand:

- `packages/substrate/src/descriptors/operation.ts:20-25` — `isOperationEnvelope` (object/null check, then literal-tag comparison).
- `packages/substrate/src/descriptors/event-stream.ts:51-56` — `isEventStreamEnvelope` (same shape).
- `packages/substrate/src/descriptors/event-stream.ts:58-75` — `isEventStreamStateRow` (delegates to `isChangeEvent`, then composite check).

The skill (§3 and §1.4 of the "Don't" list) explicitly recommends `Schema.is(Schema)` over hand-rolled guards. There is no `OperationEnvelope` Schema in the codebase — the type is currently a TS-only `interface` at `operation.ts:14-18` even though its `_envelope: typeof OPERATION_ENVELOPE_TAG` discriminant and `operation: string` / `payload: unknown` fields are exactly a `Schema.Struct`. Promoting it to a Schema would (a) replace the hand-rolled guard with `Schema.is(OperationEnvelope)`, (b) make the wire envelope a first-class Schema decoded at the runtime boundary (currently the runtime calls `isOperationEnvelope(run.data)` at `operation-handler.ts:75, 202` and only then decodes the inner payload), and (c) catch malformed envelopes (e.g. missing `operation` field) at decode time rather than slicing-by-shape. `EventStreamValue` already exists at `schema/rows.ts:103-107` so its `Schema.is` is one rename away; `isEventStreamStateRow` would be replaced by `Schema.is(substrateState.eventStreams.changeEvent)` (or the local equivalent).

### 6. JSON parsing outside test fixtures

Audit of `JSON.parse` / `JSON.stringify` in source (excluding `__tests__`):

- `packages/substrate/src/descriptors/append.ts:15` — `JSON.stringify(change)` is the only occurrence and is correct; the durable-streams client expects a serialized payload, and `change` is already a typed `StateEvent`. No `JSON.parse` exists in source. Test fixtures using `JSON.parse` (skeleton.test.ts, package-name-cutover.test.ts) are intentional and excluded.

The skill recommends `Schema.parseJson` for JSON-string inputs; that surface only applies if the substrate ever decoded a JSON string into a domain value, which it does not — Durable Streams returns parsed objects via `subscribeJson` and `response.jsonStream()`. No finding here beyond confirmation that the boundary is correctly placed.

### 7. Schema.Class vs Schema.Struct

Current Schema.Struct usage at `schema/rows.ts` (`RunValue`, `CompletionValue`, `ClaimAttemptValue`, `EventStreamValue`, `TraceValue`) and `schema/ready-work.ts` (`ReadyWorkItem`) is appropriate: these are pure data carriers consumed by Durable Streams' Standard Schema interop (`Schema.standardSchemaV1` at `schema/state.ts:15-18`), so promoting to `Schema.Class` would introduce class-instance overhead at every row read for no observable benefit. `ChoreographyTrigger` at `choreography/triggers.ts:25` uses `Schema.Union(ProjectionMatchTrigger)` over a `Schema.TaggedStruct` — the right choice for a discriminated union the runtime pattern-matches on. No changes recommended for this concept.

### 8. Branded types: `Brand.nominal` vs `Schema.brand`

Four nominal brands in two files:

- `packages/substrate/src/descriptors/operation.ts:57-59` — `OperationHandleId`.
- `packages/substrate/src/choreography/branded.ts:14-21` — `WorkId`, `CompletionId`, `OwnerId`.

All use `Brand.nominal<T>()` for zero-runtime-cost nominal typing. The skill (§ "Branded Types") shows `Schema.String.pipe(Schema.brand("UserId"))` as the recommended form. Tradeoff:

- **`Brand.nominal` (current):** purely compile-time; no validation. The brand constructor is a type assertion. Used at `operation.ts:148` (`OperationHandleId(id)`) without validation.
- **`Schema.brand` (skill):** integrates with Schema decode/encode so a brand can be parsed from `unknown`, validated, and exported via JSON Schema; carries an optional refinement (`Schema.NonEmptyString.pipe(Schema.brand("WorkId"))`).

For the choreography brands the schema-first form is strictly stronger — `WorkId` / `CompletionId` / `OwnerId` flow across the durable-streams wire (they are appended to `RunValue.runId`, `ClaimAttemptValue.workId`, etc.) and a `Schema.brand` definition would let `RunValue` reference `WorkIdSchema` directly instead of the current `runId: Schema.String`. For `OperationHandleId` the gain is smaller: the only producer is `OperationHandle.make` at the client, and the value never round-trips through a substrate row. Reasonable to keep `Brand.nominal` there. The choreography brands are the higher-leverage migration.

## Out of scope

- `Data.TaggedError` vs `Schema.TaggedError` choice — covered in the code-style review.
- Layer-factory configuration interfaces (`FiregridClientConfig`, `WorkClaimLiveConfig`, `EventStreamClientConfig`, `DurableWaitsConfig`, `EmbeddedDurableStreamsConfig`, `DurableStreamAdminCreateInput`, `EmbeddedResolverConfig`, `RuntimeContextService`) — covered in the configuration review.
- Test fixtures that use `JSON.parse` for fixture loading — intentional pattern.
- The detector hits in `/tmp/effect-detect-packages.txt` against `subscribers.ts:334-335, 365, 371` (rule-010 ternaries) and `subscribers.ts:219, 238, 354` (rule-002 multi-OR) — those are pattern-matching/conditionals review concerns, but they collapse naturally if finding §2 lands.

## Top 5 highest-leverage improvements

1. **Centralize the `Schema.Schema.AnyNoContext` cast** in one helper near the descriptor module (e.g. `descriptors/codec.ts` exporting `decodeAtBoundary` and `encodeAtBoundary`). Removes nine inline casts and consolidates the type-bound explanation in one place. Touches `operation-client.ts`, `event-client.ts`, `operation-handler.ts`, `event-stream-materializer.ts`. Mechanical change, no behavioural risk.

2. **Define per-kind `completion.data` Schemas** (`TimerCompletionData`, `ProjectionMatchCompletionData`, `ScheduledWorkCompletionData`) in `schema/rows.ts` and use them on both the write side (`waits.ts:177-181, 199-213, 222-230`) and the read side (`subscribers.ts:218-227, 234-247, 347-360`). Closes the R0 review §C4 item, eliminates four inline `as`-casts plus three `typeof` guards, and makes `completion.data` self-documenting. Largest correctness win on the list.

3. **Promote `OperationEnvelope` to `Schema.Struct` (`OPERATION_ENVELOPE_TAG` literal + `operation: Schema.String` + `payload: Schema.Unknown`)** colocated with `EventStreamValue` in `schema/rows.ts`. Replaces `isOperationEnvelope` at `descriptors/operation.ts:20-25` with `Schema.is`, lets the runtime decode the envelope as the boundary instead of probing-and-narrowing, and rejects malformed envelopes with a typed `ParseError`. Also resolves finding §4 for the operation envelope.

4. **Reconcile the two `ProjectionMatchTrigger` definitions** by deleting the `interface` at `waits.ts:49-52` and importing the `Schema.TaggedStruct` from `choreography/triggers.ts:12-16`. The substrate would then write a Schema-validated trigger into `completion.data` and the subscriber's `data.trigger as ProjectionMatchTrigger` cast at `subscribers.ts:360` becomes a Schema decode. Folds into finding §2 cleanly.

5. **Migrate choreography brands (`WorkId`, `CompletionId`, `OwnerId`) to `Schema.brand`** so they participate in row schemas (e.g. `RunValue.runId: WorkIdSchema` rather than `Schema.String`) and the durable-streams-derived `StandardSchemaV1` carries the brand information through the State Protocol boundary. `OperationHandleId` can stay on `Brand.nominal` since it never round-trips.

## What strict-baseline already enforces

The post-R0-R-STRICT-BASELINE work has the following schema-shaped guarantees in place, which the suggestions above build on rather than duplicate:

- All substrate row families are `Schema.Struct` definitions in `schema/rows.ts` with `Schema.Literal` discriminants for `RunState`, `CompletionState`, `CompletionKind`, `ClaimAttemptStatus` (`schema/rows.ts:13, 50, 60, 85`).
- The durable-streams State schema is built from those declarations exactly once via `createStateSchema` at `schema/state.ts:24-45`, with `Schema.standardSchemaV1` interop — no duplicate type definitions for collections.
- State-machine builders (`createPendingCompletion`, `resolveCompletion`, `rejectCompletion`, `cancelCompletion`, `startRun`, `blockRun`, `completeRun`, `failRun`, `cancelRun` in `schema/state-machine.ts`) return `Effect<ChangeEvent, IllegalCompletionTransition | IllegalRunTransition>` — appendChange consumers (e.g. `appendChange` at `descriptors/append.ts`) never construct raw rows.
- Transition adjacency is declarative (`completionTransitionMachine`, `runTransitionMachine` at `schema/state-machine.ts:24-48`) with `satisfies TransitionAdjacency<...>` constraints that the TS compiler checks.
- `IllegalCompletionTransition` and `IllegalRunTransition` are `Data.TaggedError` (the `Schema.TaggedError` migration is the code-style review's call).
- Descriptor schema slots are typed `Schema.Schema.All` (not the looser `Schema.Schema.Any`), per the rationale comment at `descriptors/operation.ts:45-55` and `descriptors/event-stream.ts:97-103`. This correctly admits `Schema.Never` as the default error schema (`Operation.define` defaults `error` to `Schema.Never` at `descriptors/operation.ts:91-100`).
- Encode/decode at every IO boundary goes through `Schema.encodeUnknown` / `Schema.decodeUnknown` with explicit `ParseResult.ParseError` mapping into typed `Data.TaggedError` instances (`OperationEncodeError`, `OperationDecodeError`, `EventStreamEncodeError`, `EventStreamDecodeError`, `EventStreamMaterializerDecodeError`).
- Public projection contract `ReadyWorkItem` is Schema-defined (`schema/ready-work.ts:6-11`) and re-exported through the public schema barrel.
- Retained-record reads in `retained-records.ts:22-23` use `Schema.decodeUnknownEither` for `ClaimAttemptValue` and `RunValue` rather than ad-hoc parsing.

The remaining work is incremental: the wire shape is already schema-first; the leverage is in pulling the last `as`-casts and hand-rolled guards into the same Schema-driven decode pipeline.
