# tf-br1w STOP — delegated child-session output is not a narrow `wait_for` patch (2026-05-22)

**Bead:** `tf-br1w` (P1). **Outcome:** **STOPPED per the bead's STOP/EXIT instruction** — exposing a child session's output as an agent-visible `wait_for` channel cannot be done as a narrow patch. It requires changes across the four boundaries the bead named as out of scope. No production code was changed.

**Investigation reference:** the gap is real and reproduced live (the parent guessed 10 channel names, all `ToolInvalidInput: unknown channel`) — see `feat/acp-dev-tooling`'s `docs/investigations/2026-05-21-acp-parent-child-output-channel-gap.md` (not yet on `main`).

## The agent `wait_for` path today (source-verified, off `origin/main`)

```
wait_for(channel: string, match)                       [no sessionId, no afterSequence]
  -> router.route(channel)                             [static target lookup, exact match]
  -> source = CallerFact { stream: registration.target }   [uniform — never AgentOutputAfter]
  -> WaitForWorkflow -> streamForSource
  -> CallerOwnedFactStreams.streamFor(streamName)      [bound by NAME at host-compose time]
```

- `WaitForToolInputSchema` is `{ channel, match }` only — no `sessionId`, no `afterSequence`/cursor (`packages/protocol/src/agent-tools/schema.ts:103-107`).
- The router resolves a **static** target by exact string: `routeByTarget = new Map(routes.map(r => [r.descriptor.target, r]))` (`packages/runtime/src/channels/router.ts:131-143`), built once from a compose-time channel set (`packages/host-sdk/src/host/channel.ts:65-73`).
- The `wait_for` lowering builds **only** `CallerFact { stream: String(registration.target) }` (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:359-362`); it never constructs `AgentOutputAfter`.
- `CallerFact` resolves by name through `CallerOwnedFactStreams.streamFor(name)`, a host-composition service; unbound names yield `Stream.empty` (`packages/runtime/src/streams/runtime-observation-streams.ts:51-57,130-134`).
- `session_new` returns a `SessionHandle` (sessionId, which **is** the child `contextId` — `schema.ts:377`) but **no output-channel binding** (`schema.ts:405-414`). It passes `parentContextId` to the spawn seam for replay-safe id derivation (`tool-use-to-effect.ts:591`), but no durable parent→child *observation authority* record is created.

The runtime *can* already produce any context's output stream — `agentOutputForContext(contextId)` and the `AgentOutputAfter{contextId,activityAttempt,afterSequence}` source (`runtime-observation-streams.ts:114-128`, `sources.ts:17-22`). The gap is that **the agent `wait_for` path has no way to reach it for a child context**, and wiring it crosses the named boundaries.

## Why each acceptance criterion is blocked

| Acceptance criterion | Blocked by | Evidence |
| --- | --- | --- |
| Parent `wait_for`s a child's output | child `contextId` is created at runtime by `session_new`; the agent router only resolves **static** compose-time targets by exact string | `router.ts:131-143`; `channel.ts:65-73`; `schema.ts:377` |
| Avoid stale replay via cursor/`afterSequence` | the only cursored source is `AgentOutputAfter` (`sources.ts:17-22`), but the lowering uniformly emits `CallerFact` (no cursor), and the tool input has no `afterSequence` field | `tool-use-to-effect.ts:359-362`; `schema.ts:103-107` |
| Host-declared channel (no guessing) | a per-child channel must be addressable/declared at spawn time, but the agent router is built once at compose time with no runtime route-registration surface | `channel.ts:65-73`; `router.ts:131-143` |

## The four boundaries (each independently out of the bead's narrow scope)

1. **`wait_for` source model.** The agent path produces a single `CallerFact{stream}` for every ingress channel (`tool-use-to-effect.ts:359`). Child output with a cursor needs either a per-channel source-selection branch or an `AgentOutputAfter` route — both redesign the uniform source-resolution model. The cursor requirement also needs an `afterSequence` on `WaitForToolInputSchema` (a protocol-contract change, `schema.ts:103-107`).

2. **`RuntimeObservationSource`.** Cursored child observation is naturally `AgentOutputAfter{contextId: child, afterSequence}` (`sources.ts:17-22`), but the agent path never constructs it. Reaching it from a channel requires extending the source model / adding a variant — explicitly out of scope.

3. **Router dynamic route semantics.** Addressing an arbitrary runtime-created child id needs a parametric/dynamic ingress route or runtime route registration. The existing `runtimeRouteFromFactoryChannel` (`router.ts:246`) keys off an **egress payload field** (e.g. `session_prompt`'s `sessionId`, `host-control-routes.ts:71-73`), not an ingress `wait_for` channel string — so it does not cover this case. Out of scope.

4. **Parent/child authority + workflow result ownership.** Observing a child means reading another context's `RuntimeOutputTable` via `agentOutputForContext(childContextId)`. No durable parent→child observation-authority record exists (`session_new` knows `parentContextId` transiently but records no observable link). Exposing context-keyed output reads to agents without an authority model is an authority hole; and *who owns delivering the child's terminal result to the parent* is a result-ownership decision that the standing HostKernelWorkflow control-plane direction assigns to the host kernel workflow, not to ad-hoc cross-context reads. Out of scope.

There is no narrow patch: the request is **inexpressible** (no `sessionId`/`afterSequence` on the tool input), **unroutable** (static router, runtime-created id), **unsourced** (uniform `CallerFact`, no cursor), and **unauthorized** (no parent→child observation authority) — four independent gaps, three of which are the named boundaries verbatim.

## What a correct design needs (for the focused architecture analysis)

A minimal-but-correct shape — explicitly NOT attempted here — would have to decide:

- **A cursored child-observation contract on the agent surface:** either (a) add `sessionId` + `afterSequence` to a child-output `wait_for` (or a dedicated `session_read`/`session.wait` verb) and route it to an `AgentOutputAfter{contextId: child}` source; or (b) a host-declared per-child ingress channel created at `session_new` time. `session_new`/tool metadata must declare the channel + match shape (no client prediction).
- **Authority:** a durable parent→child observation link (recorded at spawn) the observation path authorizes against — so a context can only observe children it spawned.
- **Result ownership:** how the child's `TurnComplete` is delivered to the parent's wait (host kernel workflow vs. cursored output read), consistent with the HostKernelWorkflow control-plane direction.
- **Cursor:** the `afterSequence` must come from the agent (or a returned cursor handle) so repeated waits do not replay (`tf-aseo` / `DurableOutputCursor` is the related O(outputs) work).

## Recommended beads

1. **`tf-8hwy` (P1) Architecture analysis / SDD: agent-visible delegated child-session observation.** Decide the cursored child-output contract, the parent→child observation-authority model, and the child-result-delivery ownership across the four boundaries above. Blocks `tf-br1w`.
2. **`tf-1ymw` (P2) Protocol: cursored child-output `wait_for` (or `session.wait`/`session_read`) input contract** — `sessionId` + `afterSequence`/cursor — blocked on `tf-8hwy`.

## Sources

Source-verified against this branch (fresh off `origin/main`):
`packages/protocol/src/agent-tools/schema.ts` (`:103-107`, `:377`, `:405-414`),
`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` (`:359-362`, `:591`),
`packages/host-sdk/src/host/channel.ts` (`:65-73`),
`packages/runtime/src/channels/router.ts` (`:131-143`, `:246`), `.../host-control-routes.ts` (`:71-73`),
`packages/runtime/src/streams/sources.ts` (`:17-22`, `:41-49`),
`packages/runtime/src/streams/runtime-observation-streams.ts` (`:51-57`, `:114-134`),
`packages/runtime/src/channels/session-agent-output.ts`.
