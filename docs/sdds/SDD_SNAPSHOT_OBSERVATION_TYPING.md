# SDD: Snapshot Agent-Output Observation Typing

## §0 — The load-bearing question, read this first

**Is TFIND-047 a real public client typing gap, or should consumers treat `RuntimeAgentOutputObservation.event._tag` as the only supported discriminant and ignore the outer `observation._tag` for narrowing?**

This is the TFIND-047 / Beads `tf-j94` framing question. Current status lives in the Beads DB (`bv --robot-triage` / `br`, join key `tfind:047`); deleted Markdown ledgers are not authoritative.

Triage verdict: **category 2 — real production gap, wrong public type shape**. A real client SDK consumer can hit this when reading `session.snapshot().agentOutputs[]`: the observation has a first-class outer `_tag` that looks like the natural discriminant, but its public type is only `string`, so `if (observation._tag === "TextChunk")` does not narrow `observation.event`. The typed discriminant exists at `observation.event._tag`; the gap is not missing data, it is the envelope teaching the wrong narrowing surface.

Disposition for PR #353: **salvage / rework, not close**. The parked draft correctly identified a real client-surface typing smell, but its original recommended "promote `_tag` to a literal set" direction was not sound by itself: a single struct with `_tag: "Ready" | "TextChunk" | ...` and `event: AgentOutputEvent` still does not correlate the two fields. A sound fix must either declare `event._tag` as the only narrowing contract, or make the observation envelope a correlated discriminated union.

Coordinator recommendation: choose **B: make the observation envelope a correlated public discriminated union**, because the API already exposes outer `_tag` as a first-class observation field and the constructor already writes `_tag: event._tag`. The minimal sound implementation shape is not a literal-set-only edit; it is either a per-variant `RuntimeAgentOutputObservation` union or an equivalent type/schema construction that proves `_tag` and `event._tag` move together.

## Status

Status: draft framing for coordinator/Gurdas signoff. No production code is in scope for this PR.

Finding: TFIND-047, Beads `tf-j94`, label `tfind:047`, factory-supports, priority P2.

Related findings:

- TFIND-030 (`tf-5h7`, closed): snapshot output `event` is now the typed protocol union, not an opaque record.
- TFIND-035 (`tf-1fr`): `AgentOutputEvent` SSOT; TFIND-047 does not redefine that union.
- TFIND-040 (`tf-j08`): per-event observation delivery surface; TFIND-047 is type shape on the existing snapshot/wait observation value.

## Evidence

`packages/client-sdk/src/firegrid.ts:119-127` defines `RuntimeContextSnapshot.agentOutputs` as `ReadonlyArray<RuntimeAgentOutputObservation>`.

`packages/protocol/src/session-facade/schema.ts:258-289` defines `RuntimeAgentOutputObservationSchema`. The inner `event` field is the typed `AgentOutputEventSchema`, but the outer `_tag` field is `Schema.String.pipe(Schema.minLength(1))`.

`packages/protocol/src/agent-output/schema.ts:55-84` defines `AgentOutputEventSchema` as the real discriminated union. A consumer who narrows `observation.event._tag === "TextChunk"` can read `observation.event.part.delta` without a cast.

`packages/protocol/src/session-facade/schema.ts:390-429` constructs observations by decoding the typed event and writing `_tag: event._tag`. Runtime values already maintain the invariant. The public schema/type does not express it.

The original cast evidence is in `packages/tiny-firegrid/test/codex-acp-tool-call-pipeline.test.ts:295-317`: helper code narrows on `observation._tag`, then falls back to `asRecord(observation.event)` to read `part.delta` / `part.name`. That cast is not needed if the consumer narrows on `observation.event._tag`, but its presence is a useful signal: the public envelope invites the wrong narrowing path.

Current tests also show the alternative. Several production-consuming tiny tests now read text deltas by narrowing `observation.event._tag`, proving Reading A is viable for consumers that know the intended pattern.

## Correction To The Parked Draft

The original PR #353 body recommended "promote envelope `_tag` to the literal discriminant" as if that alone made the observation narrowable. That is not sufficient.

This shape is still not correlated:

```ts
type NotEnough = {
  readonly _tag: "TextChunk" | "ToolUse"
  readonly event: TextChunkEvent | ToolUseEvent
}
```

After `if (value._tag === "TextChunk")`, TypeScript still cannot conclude `value.event` is `TextChunkEvent`, because the type allows `{ _tag: "TextChunk", event: ToolUseEvent }`.

The sound shapes are:

```ts
type Correlated =
  | { readonly _tag: "TextChunk"; readonly event: TextChunkEvent }
  | { readonly _tag: "ToolUse"; readonly event: ToolUseEvent }
```

or a helper/API contract that tells consumers to ignore outer `_tag` and narrow only `event._tag`.

## Options

### A. Document `event._tag` as the only discriminant and close TFIND-047

Under A, no schema/type change lands. The public contract is: `RuntimeAgentOutputObservation._tag` is informational only; consumers narrow on `observation.event._tag`.

Benefits:

- Zero public type churn.
- Already works today because `event` is the typed protocol union from TFIND-030.
- Avoids duplicating discriminant authority between the envelope and event.

Costs:

- Leaves a first-class outer `_tag: string` field that looks like a discriminant but is not one.
- Forces consumers to learn that the obvious envelope tag is not the narrowing tag.
- Keeps the Codex fixture's cast pattern understandable, even if technically avoidable.

Choose A if Gurdas decides the outer observation tag is not part of the public narrowing contract. In that case the right disposition is a structured close/reframe: fix consumers to narrow `event._tag`, document the pattern, and do not implement a protocol/client type change.

### B. Make `RuntimeAgentOutputObservation` a correlated discriminated union

Under B, the public observation type expresses the invariant already written at runtime: outer `_tag` equals `event._tag`. Consumers can narrow either `observation._tag` or `observation.event._tag`.

Benefits:

- Makes the public type match the durable value invariant.
- Removes the misleading `_tag: string` surface.
- Lets snapshot and wait consumers use one natural observation-level discriminant.
- Keeps `AgentOutputEvent` SSOT unchanged.

Costs:

- Requires a real schema/type reshaping, not a one-line literal-set edit.
- Has fanout through `RuntimeAgentOutputObservation` re-exports and wait output schemas.
- Must preserve convenience fields such as `toolName`, `toolUseId`, and permission fields without weakening decode.

Choose B if outer `_tag` is intended to be a public observation discriminant. This is the coordinator recommendation.

### C. Add flattened convenience fields for more variants

Under C, keep `_tag: string`, but add convenience fields such as `textDelta` for `TextChunk`, mirroring the existing `toolName` / `toolUseId` fields for `ToolUse`.

Benefits:

- Solves the immediate TextChunk delta access pattern.
- Smaller than a full correlated observation union.

Costs:

- Does not make the observation narrowable.
- Scales as per-variant field accretion.
- Entrenches the ambiguous outer `_tag` instead of deciding its contract.

Not recommended.

## Recommendation

The coordinator recommendation is **B: correlated observation union**, with one explicit guardrail: do not implement the parked draft's literal-set-only Option 1.

The implementation should prove one of these sound shapes:

1. `RuntimeAgentOutputObservationSchema` becomes a union of per-event observation schemas where each variant has a literal outer `_tag` and the matching event variant; or
2. an equivalent type/schema construction gives TypeScript the same correlation and keeps strict decode.

This is a cat-2 client SDK type-shape issue, not a cat-1 missing capability: the data and typed event union exist, but the public envelope shape misleads consumers and forces casts when they use the envelope tag.

## Secondary Questions After §0

1. If B lands, should every `AgentOutputEvent` variant get a matching observation variant, or only variants currently emitted by runtime sessions?
2. Should `RuntimePermissionRequestObservationSchema` also specialize its `event` field to the `PermissionRequest` event variant as part of the same reshape?
3. Should the client README explicitly say "narrow `event._tag`" even if B lands, or should examples use the outer observation tag after correlation?
4. Should implementation validation remove the `asRecord` casts from the Codex ACP fixture, or add a dedicated type-level test in `packages/client-sdk` / `packages/protocol`?
5. Is there any downstream consumer assuming `RuntimeAgentOutputObservation["_tag"]` is arbitrary string rather than `AgentOutputEvent["_tag"]`?

## Acceptance Bar For The Follow-Up Implementation

The implementation PR that follows this framing should prove:

- `session.snapshot().agentOutputs[number]` can be narrowed by outer `_tag` and then read the matching `event.part.*` fields without casts;
- `session.wait.forAgentOutput(...).output` has the same correlated observation type as snapshot rows;
- `AgentOutputEvent` remains the SSOT and strict decode from TFIND-030 is not loosened;
- no broad opaque-record escape hatch is reintroduced;
- existing permission/tool flattened fields keep their current behavior or are deliberately replaced by typed variant access with tests.
