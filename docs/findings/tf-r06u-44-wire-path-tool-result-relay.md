# tf-r06u.44 — wire-path tool-result relay spike: the relay needs a durable toolUseId→sequence assignment

Date: 2026-06-01
Owner: tf-r06u.44 (Agent2 / lane-b), workbench spike
Branch: sidecar/tf-r06u.44-wire-path-relay-spike (off origin/sim/unified-kernel-validation)
Evidence: `packages/tiny-firegrid/test/wire-path-tool-result-relay/relay-replay.test.ts` (2/2 green)
De-risks: tf-r06u.41 (ToolResult arm on `RuntimeAgentOutputObservation`) + the production wire-path tool-result cutover.

## What was probed

The emission half Agent2 deferred from the mcp-host slice (.28): an agent emits a
`ToolUse` turn → the host runs the shared typed arm (the .28
`FiregridAgentToolExecutor`) → the result is relayed as a **`ToolResult`
observation on the agent-output stream**, readable by offset by a parent/client.
The MCP-entry path (.28) is relay-free (returns in the `tools/call` response);
this is the *wire/codec* delivery shape that feeds a poll-only consumer.

## Schema verdict (Coordinator-authoritative, aligned with Agent3 .41)

The observation carries `event.part: Prompt.ToolResultPart` — the `@effect/ai`
canonical shape — mirroring the existing `ToolUse` arm (`event.part:
Prompt.ToolCallPart`, `session-facade/schema.ts:280`) and the .28 wire
`ToolResultEvent` (`events/contract.ts:53`). NOT the bare `{ toolUseId,
resultJson }` the .41 bead first sketched. Reasons:

- **`isFailure` must be structural.** A poll-only consumer (Brookhaven's
  publish-terminal `buildSha`, DECIDE-3) must distinguish a *published* terminal
  from a *failed* publish. `Prompt.ToolResultPart` carries `id/name/result/
  isFailure/providerExecuted`; bare `resultJson` loses success-vs-failure.
- **Mirror + don't reinvent.** Same part type as the `ToolUse` arm and the .28
  wire event; the library owns the shape.
- **`{ toolUseId, resultJson }` is the DERIVED projection**, not the stored
  shape: `resultJson === JSON.stringify(part.result)`, `toolUseId === part.id`
  (and the union's existing `toolUseId`/`toolName` supplemental fields). The
  leaner consumer view is free; producers keep `isFailure`.

Agent3 owns landing this in `protocol/` (.41 = `agent-output/schema.ts` +
the `session-facade/schema.ts` union arm + decode fallback). Confirmed aligned.

## Findings

### F1 — The relay needs a DURABLE `toolUseId → sequence` assignment (the load-bearing result)

Today the codec assigns the agent-output `sequence` from a **volatile**
`Ref<number>` (`unified/codec-adapter.ts:143`, `drainOutputsToJournal`):
`const sequence = yield* Ref.modify(sequenceRef, (n) => [n, n + 1])`. The
`sequenceRef` is created per session bind (`:319 const sequenceRef = yield*
Ref.make(0)`) and **resets on process/engine restart**.

`RuntimeOutputTable.events` rows are keyed by `eventId{contextId, activityAttempt,
target, sequence}` (`protocol/launch/table.ts:184`) — i.e. **keyed by sequence**.
So a relay that re-runs after a restart (replay) and re-derives `sequence` from a
fresh volatile counter would land the same `ToolResult` at a *different*
`eventId` → a **duplicate observation** at a new offset. `insertOrGet` does NOT
save you here, because the key it dedups on (sequence) is itself volatile.

**Therefore the replay-safe relay requires a durable assignment from `toolUseId`
to its output `sequence`** — a stable identity (`toolUseId`) mapped once to a
durable offset, so replay re-derives the same `sequence`/`eventId` and
`insertOrGet` dedups. The spike models this with a `toolUseId`-primary-keyed
durable row; the production cutover needs the same (the kernel-owned write+arm
direction, `docs/cannon/architecture/kernel-owned-write-arm.md` / tf-c9r9, is
exactly this durable-assignment-then-arm shape).

**Proven (test claim 1):** relaying the same `toolUseId` twice (a replay) yields
exactly ONE observation at a STABLE `sequence`; the stored row's `isFailure` and
`id` round-trip.

### F2 — Offset reads are replay-safe across a process boundary

**Proven (test claim 2):** after rebuilding the table layer over the same durable
stream (a fresh "process"), reading by `sequence` offset returns the identical
ordered observations; a post-replay re-relay of an existing `toolUseId` does NOT
duplicate it; an offset cursor (`afterSequence`) is a true tail cursor. This is
the production-cutover de-risk: a parent/client can poll `ToolUse(x)` then
`ToolResult(x){...}` on one ordered stream, replay-safe by offset.

### F3 — Durability shape is Shape C, not Shape D

Per `docs/architecture/shape-c-vs-shape-d.md`: the relay is **Shape C** —
durable row identity (`insertOrGet` on a `toolUseId`-derived key), not
`Workflow.idempotencyKey`/Activity memoization. It is the dual of the .28
MCP-entry path (Shape D, at-most-once via `idempotencyKey`): same shared arm, two
delivery shapes — MCP-entry returns in-response (Shape D), wire relays a durable
observation (Shape C).

### F4 (methodology) — a pure public-surface sim is itself blocked on .41

The `ToolResult` observation arm is not in the public protocol surface until .41
lands, so a client-sdk driver cannot decode it via the public
`RuntimeAgentOutputObservation` read (it would hit an unknown `_tag`). The spike
is therefore a **host-level workbench proof** (a self-contained DurableTable
models the .41 arm locally), not a public-surface sim. That ordering is the
finding: **.41 lands the protocol arm; THEN a public-surface client-sdk sim can
read it.** This spike de-risks .41 by proving the relay/offset/replay shape it
will rely on. (OTel-trace + client-sdk-driver sim wrapper → follow-up once .41
is on the trunk.)

## Triage

Category 2 (implementation gap, informs design): the current volatile-`sequenceRef`
emission is correct for the live drain but not replay-safe for a relayed
`ToolResult`; the production wire-path emitter needs the durable `toolUseId →
sequence` assignment (F1). Lands with .41 (Agent3, schema) + the wire-path
emitter cutover (gated on the trunk green-up + kernel-owned write+arm).
