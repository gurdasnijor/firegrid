# tf-22fo — Delegated child output through the existing channel/router

**Verdict: 🟢 GREEN**

A `session_new` / `session_prompt`-style parent can observe a child session's
`TextChunk` and terminal (`TurnComplete` / `Terminated`) output, after a cursor,
with no stale duplicate reads — using only the **existing** channel/router
primitives. No `session_read` protocol, no parallel `ChildOutput*` schema, and
no source-specific event taxonomy were needed.

## Load-bearing constraint observed

`docs/cannon/architecture/runtime-design-constraints.md` **C6 — "Observations
Are Typed Source, Cursor, Match"**, and its "Delegated Child Output" section:

```
source = child session output   (typed SessionAgentOutputChannel, keyed by sessionId)
cursor = after output sequence  (afterSequence; -1 = from start)
match  = optional event predicate
```

C6 mandates **snapshot-first, then subscribe-after-cursor**: read a snapshot at a
known cursor, then subscribe strictly after it — preventing both missed terminal
rows and stale replay. The proof exercises exactly that boundary over a *live,
still-producing* child.

## What the proof reuses (nothing new defined)

The proof wires the real production primitives unchanged:

- `sessionAgentOutputObservationRoute` (`@firegrid/runtime/channels`, tf-1ymw) —
  the cursored ingress `wait_for` route, built on
  `runtimeRouteFromFactoryIngressChannel`.
- `makeRuntimeChannelRouter` / `RuntimeChannelRouter` dispatch surface.
- `makeIngressChannel` + `SessionAgentOutputChannelTarget`
  (`@firegrid/protocol/channels`).
- `RuntimeAgentOutputObservationSchema` + `SessionAgentOutputRouteInputSchema`
  (the existing observation union and `{ sessionId, afterSequence }` input).

The only thing the proof adds is a **clean-room child-output log** standing in
for the durable per-session source: a snapshot-first / subscribe-after-cursor
live `Stream` (subscribe to the live hub *before* reading the durable snapshot,
drop live rows already covered by the snapshot via `sequence > lastSnapshotSeq`).
That is test substrate, not new protocol.

## Evidence (path + how to run)

- Proof logic: `packages/tiny-firegrid/src/simulations/child-output-existing-channel-router/probe.ts`
- Proof test:  `packages/tiny-firegrid/test/child-output-existing-channel-router/probe.test.ts`
- Run: `cd packages/tiny-firegrid && npx vitest run test/child-output-existing-channel-router/probe.test.ts`
- Result: **7 passed**; `pnpm run typecheck` clean.

Asserted behaviors:

1. **Same route, no new schema** — descriptor is `ingress` / `["wait_for"]` on
   `session.agent_output`; input schema is `SessionAgentOutputRouteInputSchema`.
2. **Snapshot-first** — already-produced rows are returned strictly after the
   cursor without blocking.
3. **Cursor round-trip, no stale duplicates** — round-tripping the observed
   `sequence` back as `afterSequence` reads `[0,1,2]` exactly once, in order,
   through the turn terminal; sequences strictly increasing + distinct; every
   row a member of the existing union (`Schema.is`).
4. **Subscribe-after-cursor (liveness)** — an observation at the frontier
   **parks** (verified blocked-pending via `Fiber.poll` = `None`), then **wakes**
   on the next live append — proving it is not a stale re-read.
5. **Terminal reachable through the same route** — `Terminated` is observed via
   the identical `wait_for` route; no separate terminal/`session_read` path.
6. **Empirical no-stale contrast** — a non-advancing reader (`afterSequence`
   always `-1`) re-reads seq `0` four times (1 distinct = stale dup), while the
   cursored reader yields `[0,1,2,3]` (4 distinct).
7. **Source identity keys observation** — sibling child `b`'s output is not
   observable on child `a`'s cursor.

## What would falsify GREEN

This proof would have been **RED/YELLOW** if any of the following had been
required, and would have named the exact missing primitive:

- A new `session_read`/`ChildOutput*` request/response **schema** distinct from
  `RuntimeAgentOutputObservationSchema`. → Not needed: the dispatch result IS a
  `RuntimeAgentOutputObservation`.
- A **source-specific cursor or event-tag taxonomy** for child output. → Not
  needed: cursor is the existing `afterSequence`; event tags are the existing
  `TextChunk` / `TurnComplete` / `Terminated` union members.
- A protocol surface that **bypasses the channel router** (a direct child-output
  read API). → Not needed: observation goes through `router.dispatch(wait_for)`.
- A source unable to provide a **stable snapshot/subscription boundary** (would
  break snapshot-first/subscribe-after-cursor restart safety). → Not observed:
  the snapshot-first-then-filter-live boundary holds.

If a future production source cannot supply that snapshot/subscription boundary,
the verdict drops to YELLOW with that source named as the missing primitive.

## Production dependency / scope boundary

- The production route already exists (`packages/runtime/src/channels/session-agent-output-route.ts`,
  tf-1ymw, landed `83fad6e64`). This proof validates that route's *shape* is
  sufficient for delegated child output as a **live** observation — the gap the
  existing production unit test left open (it feeds a finite
  `Stream.fromIterable`, so it cannot exercise the subscribe-after-cursor /
  liveness path).
- **No production change is required by this proof** (per the bead non-goal). The
  parent→child **authorization** boundary is the `SessionAgentOutputChannelService.forContext`
  resolver: it is where a durable parent-child link check attaches before a
  `sessionId` becomes observable. The proof leaves that resolver open (any
  registered session observable) and marks the boundary; wiring real authority
  is a production concern, not a missing channel/router primitive.
- The only open production-side question this surfaces (and does **not** resolve
  here) is whether the durable production `sessionAgentOutputChannel` source
  (`RuntimeOutputTable.events.rows()`) presents the same snapshot-first /
  subscribe-after-cursor boundary the proof relied on. That is existing-source
  behavior, not a new primitive.
