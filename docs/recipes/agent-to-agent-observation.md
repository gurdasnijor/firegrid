# Agent-To-Agent Observation

Audience: anyone building multi-agent flows where one agent (parent,
planner, supervisor, sibling) needs to observe another agent's output
or react to a named peer event.

**TL;DR — two patterns, both on existing primitives:**

1. **Observe another agent's output stream** → `wait_for` on
   `session.agent_output` with the target session's `contextId` as
   the cursor key. Same channel target every public observation
   already uses.
2. **React to a named peer event (pheromone)** → `wait_for` on a
   `CallerOwnedFactStreams.streamFor(<name>)` source backed by an
   app-owned `DurableTable`. The emitter writes a row; the observer
   matches on a typed field.

Neither pattern requires a new channel target, a new schema, or a
parent-child-specific route. The substrate handles the cross-agent flow
through `HostPlaneChannelRouter` + `CallerOwnedFactStreams`.

## Pattern 1 — Observe another agent's output

### When to use

- A planner observing a child session's `TextChunk` / `Terminated` /
  `PermissionRequest` / `Error` output.
- A supervisor agent observing a sibling agent's output.
- An outer-driver harness observing any session it spawned.

### Code shape

The observer issues a standard `wait_for` against `session.agent_output`
with the target `contextId` and a cursor:

```ts
// Observer-side (in an agent's tool call, or from the client SDK)
const observation = await handle.wait.forAgentOutput({
  // contextId is implicit when called on the target's handle.
  // For cross-handle observation, dispatch through the router directly:
  afterSequence,
  // optional predicate: only match Error events, only match a specific tag, …
})
```

For router-mediated cross-handle observation (no client handle on the
observer side):

```ts
const observation = await Effect.runPromise(
  HostPlaneChannelRouter.dispatch({
    verb: "wait_for",
    target: "session.agent_output",
    payload: { sessionId: targetContextId, afterSequence },
  }),
)
```

The dispatch returns a `RuntimeAgentOutputObservation` — the same union
(`TextChunk` | `TurnComplete` | `Terminated` | `PermissionRequest` |
`ToolUse` | `Error` | …) the parent's own handle returns. Observers
match on the `_tag` and the typed fields.

### Cursor + snapshot-first / subscribe-after-cursor (C6)

The boundary that makes cross-agent observation safe:

1. The observer captures `lastSeenSequence`.
2. The observer issues `wait_for({ afterSequence: lastSeenSequence })`.
3. The route reads a snapshot of rows strictly after that sequence, then
   subscribes to live appends — dropping live rows already covered by
   the snapshot via `sequence > lastSnapshotSeq`.
4. After consuming an observation, the observer updates
   `lastSeenSequence = observation.sequence` and loops.

This is the C6 contract from
`docs/cannon/architecture/runtime-design-constraints.md`. **Without it,
observers either miss the terminal row or re-read a stale snapshot
forever.** The `child-output-existing-channel-router` simulation
empirically asserts both failure modes (#6 in its test list: a
non-advancing reader re-reads sequence 0 four times; the cursored
reader yields the correct distinct sequence).

### Authorization is at `.forContext`, not at the channel

`SessionAgentOutputChannelService.forContext(contextId)` is the
**resolver seam** for parent→child authorization. A production host
that wants to restrict which agents can observe which sessions
attaches its authority check inside this resolver — it is not a
channel-protocol concern.

The tiny-firegrid sims leave the resolver permissive (any registered
session observable) and call out that the production resolver is where
the authority binding lives.

### Evidence

- `packages/tiny-firegrid/src/simulations/child-output-existing-channel-router/` —
  proves the cursor + snapshot-first / subscribe-after-cursor boundary
  holds for live, still-producing child sessions. 7 vitest assertions.
- `packages/tiny-firegrid/src/simulations/agent-coordination-readiness/` —
  proves the public client path (`handle.wait.forAgentOutput`) and the
  router-direct path (`HostPlaneChannelRouter.dispatch`) return the same
  observation `sequence`. See its FINDING.md for the readiness matrix
  + the upstream blocker that gates running it as a full simulation.

## Pattern 2 — Named peer events (`event(name)` pheromones)

### When to use

- Choreography: two or more agents need to rendezvous on a named
  signal (`plan.ready`, `lock.acquired`) without naming each other.
- Pub/sub-shaped flows where the emitter doesn't know the observers.
- Loose coupling: an event "lands" durably; any agent that later
  waits for it satisfies.

### Code shape

The app declares a `DurableTable` for the event family and binds it as
a caller-owned fact source:

```ts
// host.ts
const events = AppEventsTable.layer({ streamUrl: ... })

const callerFacts = Layer.effect(
  CallerOwnedFactStreams,
  Effect.gen(function*() {
    const table = yield* AppEventsTable
    return CallerOwnedFactStreams.of({
      streamFor: (stream) =>
        stream === "app.events"
          ? (table.events.rows() as Stream.Stream<unknown, unknown, never>)
          : Stream.empty,
    })
  }),
)
```

The app also exposes an `emit_event(name, payload)` MCP tool that
writes a row to `AppEventsTable.events`. The emitter agent calls the
tool; the observer agent calls `wait_for` on the named source:

```json
// Observer agent's tool call
{
  "tool": "wait_for",
  "input": {
    "eventQuery": {
      "stream": "app.events",
      "whereFields": { "name": "plan.ready" }
    },
    "timeoutMs": 60000
  }
}
```

The wait-router resolves `"app.events"` through `CallerOwnedFactStreams`,
finds the app's stream, matches on the scalar field, and returns the
row.

### What this is the same shape as

- **Verified webhooks** — also use `CallerOwnedFactStreams` with a
  channel target (`firegrid.verifiedWebhooks`). The only difference is
  the row writer: external HTTP for webhooks, an MCP tool for peer
  events.
- **Any caller-owned fact stream** — the durable-tools wait router
  resolves stream names through this same surface. See
  `docs/recipes/durable-webhook-facts-and-wait-for.md` for the
  channel-projection cousin.

### Evidence and current limit

- `packages/tiny-firegrid/src/simulations/inv5-cross-agent-event-choreography/` —
  proves the choreography mechanism: one real `claude-agent-acp`
  process emits via `emit_event`, the row lands in the
  `CallerOwnedFactStreams` source, the host can read it.
- **Substrate gap (current as of the finding):** the multi-agent
  end-to-end variant is blocked because `FiregridRuntimeHostLive` does
  not terminate a runtime-context workflow when its agent finishes —
  the control-request reconciler stays blocked in the first context
  and never activates the engine for the second. See the FINDING for
  the named substrate prerequisite. The mechanism is sound; the
  multi-agent wiring is a future-work item, not a missing primitive.

## Ground Truth

- `packages/runtime/src/channels/session-agent-output-route.ts` — the
  cursored ingress `wait_for` route registered on
  `HostPlaneChannelRouter`.
- `packages/runtime/src/channels/host-control-routes.ts` — where
  `sessionAgentOutputObservationRoute(...)` is registered.
- `packages/runtime/src/channels/observation-streams/` —
  `CallerOwnedFactStreams` tag + service.
- `packages/protocol/src/channels/session-agent-output.ts` — the
  `SessionAgentOutputChannel` per-context factory + route input schema.
- `packages/protocol/src/session-facade/schema.ts` — the
  `RuntimeAgentOutputObservation` union.
- `docs/cannon/architecture/runtime-design-constraints.md` § C6 — the
  typed-source + cursor + match contract.
- `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` Slice C.2 — the
  `event(name)` peer-pheromone design.
- Simulations:
  `child-output-existing-channel-router/`,
  `agent-coordination-readiness/`,
  `inv5-cross-agent-event-choreography/`.

## Do Not Reimplement

- **No `session_read` / `ChildOutput*` schema.** The dispatch result is
  already a `RuntimeAgentOutputObservation`; a child-output-specific
  schema would duplicate the existing union.
- **No parent-child-specific channel target.** Parent and child both
  use `session.agent_output`. The cursor + the `contextId` key in the
  input schema are how the observer addresses a specific session.
- **No protocol surface that bypasses the channel router.** Direct
  child-output reads against runtime tables from agent code are a
  Shape C boundary violation. Observation goes through
  `router.dispatch(wait_for)`.
- **No per-event-name channel target for peer events.** Use
  `CallerOwnedFactStreams.streamFor(<stream>)` with a typed predicate.
  Many event names share one stream; the predicate filters.
- **No source unable to provide a stable snapshot/subscription
  boundary.** If a new observation source can't supply C6's
  snapshot-first / subscribe-after-cursor boundary, it can't be a
  wait-routable source — name it as the missing primitive and find
  another shape.

## Related

- [Client SDK ↔ channel targets](client-sdk-channel-targets.md) —
  `handle.wait.forAgentOutput` is the public-method form of pattern 1.
- [Durable webhook facts and `wait_for`](durable-webhook-facts-and-wait-for.md) —
  same `CallerOwnedFactStreams` pattern, channel-projected over
  `VerifiedWebhookFactTable` rows.
- [Runtime permission resume](runtime-permission-resume.md) — same
  cursor + filter pattern (`wait.forPermissionRequest` is a
  predicate-filtered observation on `session.agent_output`).
