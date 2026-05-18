# SDD: Snapshot Agent-Output Observation Typing

Status: draft - framing only, no production code
Created: 2026-05-18
Owner: Firegrid Client SDK / protocol session-facade
Tracks: TFIND-047 (Beads `tf-j94`, label `tfind:047`)
Relates: TFIND-030 (`tf-5h7`, closed by #329), TFIND-035 (`tf-1fr`,
SSOT consolidation), TFIND-040 (`tf-j08`, per-event observation
surface — distinct)

---

## §0 — The load-bearing question (read this first)

> **Should `session.snapshot().agentOutputs[]` expose the same precise,
> narrowable observation type the runtime side gets — and what is the
> minimal sound surface change to deliver that?**

Concretely: a snapshot consumer that wants the text delta of a
`TextChunk` or the tool name of a `ToolUse` today cannot narrow the
observation to reach `event.part.delta` / `event.part.name` without an
`asRecord(...) as Record<string, unknown>` escape cast. The runtime
side reads the same logical data without that cast. The question is
whether the public snapshot observation type should carry the same
precision, and the smallest type-surface change that is *sound* (no
behavior change, no decode loosening, no new opaque-record path).

This is the §0 binary Gurdas decides at signoff:

- **Reading A — accept the gap (no schema change; doc-only).** `event`
  is already the typed `AgentOutputEvent` union (TFIND-030/#329).
  Consumers should narrow on `observation.event._tag`, not the outer
  `observation._tag`. The cast in the Codex fixture is a consumer bug,
  not a protocol gap; fix the consumer, document the access pattern,
  change no public type.
- **Reading B — close the gap (minimal sound type change).** The
  observation envelope's own `_tag` is `Schema.String` (opaque),
  structurally decoupled from the typed `event` union. The public type
  therefore does not let `observation._tag` narrow `observation.event`,
  and there is no flattened accessor for non-`ToolUse` variants. That
  is a real client-surface precision gap (cat-2, factory-supports):
  the snapshot type is *weaker than the data it carries*. Make the
  minimal sound change so the public observation type is narrowable.

**Coordinator recommendation: Reading B, via Option 1 (§4)** — promote
the observation envelope `_tag` from `Schema.String` to the literal
discriminant that mirrors `AgentOutputEvent._tag`, making
`RuntimeAgentOutputObservation` a discriminated union whose `_tag`
narrows `event`. It is the smallest change that makes the public type
as precise as the data, adds zero fields, loosens no decode, and is one
schema edit + downstream type-fanout. **Gurdas owns the decision;
coordinator only recommends. Reading A is presented fairly in §3.**

`AgentOutputEvent` itself (the TFIND-035 SSOT union) is sound and is
**not** in question — no option here changes the union, its part
sub-schemas, or the STRICT decode from #329. The gap is the
*observation envelope wrapping it*, not the union.

---

## §1 — Why this is distinct from TFIND-030, TFIND-035, TFIND-040

- **TFIND-030 (`tf-5h7`, closed #329, `a7c76c268`).** Made the snapshot
  envelope/observation `event` field the typed protocol-owned
  `AgentOutputEvent` union with STRICT decode (non-conforming →
  `Option.none`), instead of `Record<string, unknown>`. It fixed the
  *`event` payload* type. It did **not** touch the observation
  envelope's `_tag` (still `Schema.String`) or add a narrowing path
  from observation → event variant. TFIND-047 is the residue #329 left:
  the typed-union win does not reach the snapshot consumer ergonomically
  because the discriminant the consumer naturally reaches for
  (`observation._tag`) is opaque. **Not closed by #329.**
- **TFIND-035 (`tf-1fr`).** SSOT: one `AgentOutputEvent` definition in
  `@firegrid/protocol`. TFIND-047 consumes that SSOT and does not
  redefine it; it only changes how the *observation envelope* exposes
  its discriminant. Orthogonal, compatible.
- **TFIND-040 (`tf-j08`).** A per-event session *observation surface*
  (streaming/subscription ergonomics — the snapshot test polls because
  no event stream exists yet). That is a *delivery-surface* gap.
  TFIND-047 is a *type-precision* gap on the existing snapshot array.
  A consumer hits TFIND-047 even with a perfect streaming surface.
  Distinct axis; the Beads issue explicitly files them apart.

---

## §2 — Verified root (Explore, file:line, origin/main `a568e4d67`)

`RuntimeContextSnapshot.agentOutputs` is
`ReadonlyArray<RuntimeAgentOutputObservation>`
(`packages/client-sdk/src/firegrid.ts:119,126`). The runtime side
reads the *same* type via `runtimeAgentOutputObservationFromRow`
(`packages/protocol/src/session-facade/schema.ts:391-431`,
`Stream.filterMap` over `RuntimeOutputTable.events.rows()` —
`tiny-firegrid/test/codex-acp-tool-call-pipeline.test.ts:185-192`).
So snapshot and runtime nominally share `RuntimeAgentOutputObservation`.
The gap is *inside that shared type*:

- `RuntimeAgentOutputObservationSchema`
  (`protocol/src/session-facade/schema.ts:271-289`): the envelope
  carries `event: AgentOutputEventSchema` (the typed union, line 268)
  **but its own `_tag` is `Schema.String.pipe(Schema.minLength(1))`**
  (line 273) — an opaque string, *not* a literal discriminant, *not*
  type-linked to `event._tag`.
- `AgentOutputEventSchema`
  (`protocol/src/agent-output/schema.ts:55-83`) is a proper
  discriminated union: `TextChunk { part: AgentTextDeltaPart }` (has
  `.delta`), `ToolUse { part: AgentToolCallPart }` (has `.name`),
  `PermissionRequest`, `TurnComplete`, `Status`, `Error`,
  `Terminated`, `Ready` — discriminated on `event._tag`.
- Only `ToolUse`/`PermissionRequest` get *flattened* convenience
  fields on the observation (`toolName`, `toolUseId`,
  `permissionRequestId`, `options` — optional, lines 280-283, populated
  in `runtimeAgentOutputObservationFromRow:415-431`). There is **no
  flattened accessor for `TextChunk` text delta**.

Consequence in the consumer
(`tiny-firegrid/test/codex-acp-tool-call-pipeline.test.ts:297-318`):

```ts
const textDeltaFromObservation = (
  observation: RuntimeContextSnapshot["agentOutputs"][number],
): string | undefined => {
  if (observation._tag !== "TextChunk") return undefined   // does NOT narrow observation.event
  const event = asRecord(observation.event)                // forced cast to Record<string,unknown>
  const part = asRecord(event?.part)
  const delta = part?.delta
  return typeof delta === "string" ? delta : undefined
}
```

`observation._tag` is `string`, so the guard narrows nothing;
`observation.event` stays the full union; `event.part` is not
type-reachable; `asRecord` is the only way out. The runtime-side
helper avoids the cast only because it reads the *flattened*
`observation.toolName` (`test:319-322`), not `event.part.*` — i.e. the
runtime path dodges the gap for `ToolUse` and never needs a `TextChunk`
delta. The precision is *present in the data, absent in the type*.

---

## §3 — Reading A in full (presented fairly)

**Claim.** #329 already made `event` the typed union. The correct,
sound access pattern is to narrow on `observation.event._tag`:

```ts
if (observation.event._tag === "TextChunk") {
  return observation.event.part.delta            // typed, no cast
}
```

So there is *no protocol gap* — only a fixture that narrowed the wrong
discriminant. Fix the consumer, document "narrow on `event._tag`",
change no public type. Zero blast radius, zero risk to the #329 STRICT
decode, ships immediately.

**Honest strengths.**

- It is *literally true* that `observation.event` is the typed union
  and `observation.event._tag === "TextChunk"` narrows `event.part` to
  `AgentTextDeltaPart` with no cast. The fixture could be fixed today
  with no protocol change.
- Smallest possible footprint; no public-type churn; no risk of a
  schema change rippling into host-sdk/runtime re-exports.
- Keeps a single discriminant authority (`event._tag`) rather than two
  (`observation._tag` *and* `event._tag`) that must be kept in sync.

**Why the coordinator recommends against it as the *whole* answer.**

- The public observation type still advertises `_tag: string` as a
  first-class field alongside flattened `toolName`/`toolUseId`. Every
  consumer is invited to reach for `observation._tag` (the fixture
  did; it is the obvious move next to the flattened fields). The type
  *teaches the wrong narrowing*. Documentation does not fix a type that
  mis-signals its own discriminant.
- The asymmetry remains: `ToolUse` has a typed flattened `toolName`,
  `TextChunk` has nothing — so even a "correct" consumer must dip into
  `event.part` for text while using `observation.toolName` for tools.
  Two access idioms for one array.
- It leaves `_tag: Schema.String` as a permanent opaque-string public
  field whose only honest use is the thing it *can't* safely do
  (narrowing). That is the cat-2 surface imprecision the finding names.

Reading A is the right call **only if** Gurdas decides the public
contract is "the observation is a flat envelope; narrow `event`, never
the envelope" and accepts `observation._tag` staying an opaque
informational string forever. That is a contract decision, not a bug —
which is exactly what §0 asks Gurdas to rule on.

---

## §4 — Options for the minimal sound surface change (Reading B space)

All options keep `AgentOutputEvent` (TFIND-035 SSOT) and the #329
STRICT decode unchanged. They differ only in how the *observation
envelope* exposes precision.

### Option 1 — Promote envelope `_tag` to the literal discriminant (recommended)

Change `RuntimeAgentOutputObservationSchema._tag` from
`Schema.String` to the `Schema.Literal` set that mirrors
`AgentOutputEvent._tag` (`"Ready" | "TextChunk" | "ToolUse" |
"PermissionRequest" | "TurnComplete" | "Status" | "Error" |
"Terminated"`), so the struct is a discriminated union and
`observation._tag === "TextChunk"` *type-links* to
`observation.event` being the `TextChunk` variant (or, equivalently,
make `_tag` a type-level alias of `event["_tag"]`).

- **Blast radius.** One schema edit (`schema.ts:273`); type fanout
  through `RuntimeAgentOutputObservation` re-exports
  (client-sdk/host-sdk/runtime `index.ts`); the constructor
  `runtimeAgentOutputObservationFromRow:399-431` already sets
  `_tag: event._tag` then specializes — confirm the literal type
  accepts those writes (see §6 F-1).
- **Tradeoffs.** Smallest change that makes the public type as precise
  as the data. Adds zero fields. The two-discriminant concern (A’s
  point) is mitigated because `_tag` becomes *definitionally*
  `event._tag`, not an independent field. Strongly preferred.

### Option 2 — Observation becomes a tagged union of per-variant structs

Replace the single widened struct with
`Schema.Union(TextChunkObservation, ToolUseObservation, …)` where each
variant carries exactly its typed `event`/part and its own flattened
fields. Maximum precision and self-documenting.

- **Tradeoffs.** Most precise, but the largest public-type change:
  every consumer of `RuntimeAgentOutputObservation` (wait outputs,
  permission-request derivation `schema.ts:432+`, host-sdk re-exports)
  must handle a union shape. Higher churn and review cost than Option 1
  for the same consumer-visible benefit at the snapshot call site.
  Reserve for if Gurdas wants per-variant observation contracts.

### Option 3 — Add a flattened `textDelta?` (and peers) like `toolName`

Mirror the `ToolUse → toolName` flattening for `TextChunk → textDelta`
(and any other variant a consumer needs), leaving `_tag` opaque.

- **Tradeoffs.** Unblocks the specific fixture without a discriminant
  change, but it is the *convenience-not-precision* anti-pattern: it
  scales per-variant-per-field forever, never makes the type
  narrowable, and entrenches the opaque `_tag`. The finding is filed as
  a *precision* gap, not a missing field — this papers it. Not
  recommended; listed for completeness.

### Option 4 — Doc-only (this is Reading A)

Listed here as the do-nothing point in the option space; mechanics and
honest tradeoffs in §3.

### Recommendation

**Option 1.** It is the minimal change that makes
`session.snapshot().agentOutputs[]` carry the same precision the data
already has, with zero new fields, no decode loosening, and a single
schema edit plus mechanical type fanout. Option 2 buys little extra at
the snapshot call site for materially more churn; Option 3 entrenches
the smell; Option 4 leaves the type mis-teaching its discriminant.

---

## §5 — Framing questions for Gurdas (signoff)

1. **The §0 binary.** Reading A (doc-only; `observation._tag` stays an
   opaque string; consumers narrow `event._tag`) or Reading B (minimal
   sound type change so the snapshot observation is narrowable)?
2. If Reading B: Option **1** (promote `_tag` to the literal
   discriminant — recommended), **2** (per-variant observation union),
   or **3** (flattened `textDelta?` peers)?
3. Confirm scope: a standalone client-surface type-precision PR
   (cat-2, factory-supports), independent of the #332 transaction and
   of TFIND-040's observation-surface work — landing as its own change
   with schema + type-fanout + the Codex fixture cast removal as the
   in-tree validation.

---

## §6 — Open items needing code/experiment (declared, not silent scope)

Per "if answering needs code/experiment, say so to 153 — that is a
finding": these do **not** block the framing decision but are flagged
as implementation-time verifications, not hidden scope.

- **F-1 (Option 1 constructor compatibility).**
  `runtimeAgentOutputObservationFromRow` (`schema.ts:399-431`) builds
  `base` with `_tag: event._tag`, then for `PermissionRequest`/`ToolUse`
  spreads specialized fields while keeping/overwriting `_tag`. Promoting
  `_tag` to a literal union must be checked to still type-accept those
  writes (esp. the `PermissionRequest` branch that sets
  `_tag: "PermissionRequest"` and the `ToolUse` branch that keeps
  `event._tag`). Expected to be a clean tightening (the values written
  are already members of the literal set), but it is an
  implementation-time typecheck, owned by the impl PR — flagged so it
  is not silent scope.
- **F-2 (re-export fanout).** `RuntimeAgentOutputObservation` is
  re-exported via client-sdk/host-sdk/runtime `index.ts` and consumed
  by `SessionAgentOutputWaitOutputSchema` (`schema.ts:310-313`) and
  `runtimePermissionRequestObservationFromAgentOutput`
  (`schema.ts:432+`). Tightening `_tag` may surface latent
  `string`-assuming sites. Mechanical, but the surface count is an
  impl-time discovery, not a framing input.

Neither is a reason to defer §0; both are downstream of choosing
Reading B / Option 1 and belong to the implementation PR.

---

## Non-Goals

- No production code in this PR before Gurdas signoff.
- No change to `AgentOutputEvent`, its part sub-schemas, the TFIND-035
  SSOT, or the #329 STRICT decode.
- No Beads/FINDINGS/CONFIGS status hand-edit (status lives in the
  Beads DB; the coordinator owns `br`). This PR is the framing artifact
  only.
- No coupling to the #332 transaction or to TFIND-040's observation
  surface; this is an independent client-surface precision change.
- The Codex ACP fixture's `asRecord` casts stay in place until this
  framing is decided and implemented; their removal is the validation,
  not a pre-emptive patch.
