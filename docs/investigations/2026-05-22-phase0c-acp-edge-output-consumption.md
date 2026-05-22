# Phase 0C edge finding F5 — what the ACP stdio edge should consume after DurableOutputCursor (2026-05-22)

**Bead:** `tf-3ief` (P0). **Parent:** `tf-b1jm` Phase 0C migration map, Finding F5 / surface S12.
**Status:** bounded finding. **This is not a production patch** — no production code, route-completion metadata, or feature YAML is changed here.

## The question (and the one-line answer)

> After Phase 0B (`DurableOutputCursor` / O(outputs)), what should the ACP stdio
> edge *consume*, and what stops being the edge's job?

**Answer.** The edge keeps the transport job (wire-encode each output, map the
terminal observation to an ACP `StopReason`, enforce the turn timeout) and
consumes a **single incremental, cursor-seeded subscription per turn** from a
channel that exposes Phase 0B `after(sequence)` semantics. It stops
re-subscribing from sequence 0 per output, and it must **not** start deriving
"the turn is complete" from route/receipt metadata — terminal completion is an
output/result fact owned by the workflow-owned output log, which the edge reads,
not synthesizes.

## Current consumption (source-grounded, this branch)

The prompt turn loop is `waitForTurnCompleteEffect` (`acp-stdio-edge.ts:318-355`):
a `for(;;)` that repeatedly calls `waitForAgentOutput`, forwards each output,
and returns on a `TurnComplete` observation (or fails on `Terminated`/timeout).

`waitForAgentOutput` (`acp-stdio-edge.ts:298-316`) is the problem shape:

```
channel.binding.stream            // SessionAgentOutputChannel.forContext(ctx)
  |> Stream.filter(seq > session.lastSequence)
  |> Stream.runHead               // take ONE, then the stream is torn down
```

Three source facts:

1. **`binding.stream` is the full from-zero output stream.** The channel's
   stream is `RuntimeOutputTable.events.rows()` filterMapped to observations
   (`session-agent-output.ts:27-50`), i.e. the same full table scan as the
   authority's `forContext` (`per-context-output.ts:181-198`). It is **not** an
   `after(sequence)` projection.
2. **It is re-created and torn down on every output.** `runHead` consumes one
   element then ends the stream; the `for(;;)` loop opens a brand-new
   subscription for the next output. A turn of *N* outputs therefore opens *N*
   subscriptions, each re-scanning up to *N* rows to skip the ones already past
   `lastSequence` — **O(N²)** edge-side reads. This is the consumer-side
   analogue of the `tf-7kq8` re-subscription storm (the producer-side analogue
   is `events.initial`'s full scan, `per-context-output.ts:115-155`).
3. **The cursor `session.lastSequence` is a volatile `EdgeSession` field**
   (`acp-stdio-edge.ts:71`, set `:338`). Unlike the workflow body, **the edge is
   not durably replayed** — it is an in-process stdio transport — so a volatile
   cursor is *acceptable here*. The defect is the per-iteration re-subscription,
   **not** cursor durability. (Do not "fix" the edge by making its cursor
   durable; that solves a problem the edge does not have.)

Terminal handling today is already correct in shape: the edge derives the turn
end from the **output observation** `_tag === "TurnComplete"` / `"Terminated"`
(`acp-stdio-edge.ts:340-349`) and maps it via `acpStopReason`
(`:103-122`). It does **not** read a route receipt or completion-metadata field.

## Classification

### Remains an ACP transport concern — KEEP in the edge

- **Wire encoding.** `forwardOutput` (`acp-stdio-edge.ts:357-398`) maps
  `RuntimeAgentOutputObservation` variants to ACP `sessionUpdate` shapes
  (`TextChunk`→`agent_message_chunk`, `ToolUse`→`tool_call`, …). Transport-specific.
- **Stop-reason projection.** `acpStopReason` (`:103-122`) maps the terminal
  observation's `finishReason` to an ACP `StopReason`. Transport-specific.
- **Turn timeout.** `turnTimeoutMs` (`:74`, `:310-315`) — how long the editor
  waits — is an edge policy, not a runtime fact.
- **The per-turn forward loop and the volatile per-connection cursor seed.** The
  edge owns "for this ACP prompt turn, forward outputs to the client until the
  turn ends." `lastSequence` stays as the cursor *seed* it passes to the
  subscription (see below), not as a per-iteration re-scan filter.

### Collapses into workflow-owned output / result state — COLLAPSE out of the edge

- **"Next output after sequence N" discovery.** The edge currently re-implements
  incremental discovery by re-scanning `rows()` and filtering. That belongs to
  the Phase 0B cursor / an `after(sequence)` channel projection, consumed once.
- **Ordering and exactly-once delivery of outputs.** Guaranteed by the cursor's
  monotonic position over the workflow-owned append log, not by the edge's
  client-side filter.
- **The terminal/`TurnComplete` (and `Terminated`) fact.** Produced by the
  workflow-owned output log and Phase 0B output-result state (`tf-ly2g`, closed;
  `tf-7kq8`, in flight). The edge reads it as the last element the cursor
  delivers. It is **not** edge-synthesized and **not** carried as route metadata.

### The exact surface the edge should consume

A **channel-level incremental subscription** that the router can expose to the
edge (the edge may only consume channels via `HostPlaneChannelRouter`; it must
not reach the runtime-internal `RuntimeAgentOutputAfterEvents` authority
directly). Concretely, add an `afterSequence` parameter (a cursor seed) to the
`SessionAgentOutputChannel` ingress registration so a consumer can open **one
ordered, long-lived stream** of outputs strictly after a sequence:

```
sessionAgentOutput.forContext(ctx).after(session.lastSequence)   // one subscription per turn
  |> Stream.runForEach(forward) until _tag ∈ {TurnComplete, Terminated}
```

This is the channel projection of Phase 0B `after(source)`
(`per-context-output.ts:156-179`) — which already exists as a runtime-internal
authority but is **not** exposed through the channel the edge consumes. Two
tiers:

- **Cheap immediate win (no new primitive):** open the existing
  `forContext` stream **once per turn** and consume with a single `runForEach`
  instead of `runHead`-per-output. Drops edge reads from O(N²) to O(N) and
  removes the re-subscription storm, even before an indexed cursor exists.
- **Full O(outputs) version (needs `tf-qk6h`):** back the `after(sequence)`
  channel projection with the production `DurableOutputCursor` (indexed read at
  `position+1`, wait keyed by sequence) so total reads are O(distinct outputs).
  Whether the durable cursor lives in engine internals, a workflow-owned table
  helper, or the channel binding is `tf-qk6h`'s decision; the edge's only
  requirement is that the **channel** expose a cursor-seeded incremental stream.

### Explicit rejection — do not synthesize terminal completion in the edge

The edge must **not** gain a "turn complete" signal derived from route-completion
metadata or a router receipt (the `tf-r6br` / `tf-nioy` route-completion-contract
direction). Terminal completion is already an output/result fact: the
`TurnComplete` observation flows through the same workflow-owned output log as
every other output and is delivered as the cursor's last element. Introducing a
parallel route-receipt "isComplete" the edge consults would **duplicate**
output/result state in two places that can disagree (the exact failure the
target architecture removes). The edge reads terminal-ness from the output
stream it already consumes; route-completion metadata is a separate concern and
is out of scope for this seam. (`tf-r6br` stays its own track; it is not a
dependency of, nor unblocked by, this edge collapse.)

## Blocked on

- **`tf-7kq8`** (lane 1, production output-observation patch, #612) — until the
  workflow-body side observes its output log incrementally and reliably emits
  `TurnComplete`, there is no clean incremental output stream for the edge to
  consume. The edge collapse rides behind this.
- **`tf-qk6h`** (Phase 0C primitive spike, #615) — defines the production
  `DurableOutputCursor` and **where** it lives. The full O(outputs) edge
  consumption depends on the channel exposing a cursor-seeded `after(sequence)`
  surface; `tf-qk6h` decides the primitive and layer that backs it. The cheap
  one-subscription-per-turn win is **not** blocked on `tf-qk6h` and could land
  against today's `forContext` stream once `tf-7kq8` stabilizes output.
- **Not blocked on `tf-r6br`** — and must not be coupled to it (see rejection).

## Migration checklist (small)

1. **(Phase 0B/0C surface)** Add an `afterSequence` cursor-seed parameter to the
   `SessionAgentOutputChannel` ingress registration so consumers subscribe past
   a sequence in one ordered stream. Source-of-truth: the Phase 0B
   `after(source)` semantics, exposed through the channel/router — not the
   runtime-internal authority. *(Owner: Phase 0B/0C channel surface; gated by
   `tf-qk6h` for the indexed-cursor backing.)*
2. **(Edge)** Replace `waitForAgentOutput` + the `for(;;)` loop with a single
   `after(session.lastSequence)` subscription per turn, consumed by one
   `Stream.runForEach` that forwards each output and stops on `TurnComplete` /
   `Terminated`. Keep `lastSequence` as the seed advanced as outputs are
   forwarded.
3. **(Edge — unchanged)** Keep `forwardOutput`, `acpStopReason`, the turn timeout,
   and the volatile per-connection cursor. Do not make the edge cursor durable.
4. **(Boundary)** Derive terminal-ness only from the `TurnComplete` / `Terminated`
   observation delivered by the cursor. Add no route-completion-metadata / receipt
   `isComplete` consumption to the edge (`tf-r6br` stays separate).
5. **(Verify)** On the live ACP repro (`firegrid acp --agent claude-acp …`,
   prompt "sleep 0ms using your Firegrid tool"): consumer-side
   `agent_output.for_context` / re-subscription count drops from ~per-output to
   one subscription per turn; `TurnComplete` is forwarded exactly once; the turn
   no longer times out via `AcpStdioEdgeTurnOutputError reason=timeout`.

## Sources

Source-verified against this branch (fresh off `origin/main`) plus the Phase 0C
map from PR #613:
`packages/host-sdk/src/host/acp-stdio-edge.ts` (`:71`, `:103-122`, `:298-316`,
`:318-355`, `:357-398`),
`packages/runtime/src/channels/session-agent-output.ts` (`:27-50`),
`packages/runtime/src/agent-event-pipeline/authorities/per-context-output.ts`
(`:115-155` initial, `:156-179` after, `:181-198` forContext);
`docs/investigations/2026-05-21-phase0c-migration-map.md` (S12 / F5),
`docs/investigations/2026-05-21-phase0b-output-replay-oracle.md`,
`docs/investigations/2026-05-21-live-acp-tool-call-triage.md`;
beads `tf-b1jm`, `tf-7kq8` (#612), `tf-qk6h` (#615), `tf-ly2g` (closed),
`tf-r6br` (#nioy follow-on), `tf-nioy` (#595).
