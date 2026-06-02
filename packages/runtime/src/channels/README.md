# channels/

Logical pipeline position: **5** (peer with `producers/`, `transforms/`). May
import `events/` and `tables/` as needed for channel bindings. Peers do not
import each other. Must not import `subscribers/` or `composition/`.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`,
`docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`.

## Owns

Channel capability bindings and wire-edge dispatch. Target layout:

- `host-control/` — host-control channel implementations
- `session/` — session-scoped channel implementations (agent output,
  permission, logs, self)
- `routes/` — typed channel registrations projected to router routes
- `router.ts` — `HostPlaneChannelRouter` / `RuntimeChannelRouter`; schema
  parsing, direction/verb checks, route invocation
- `observation-streams/` — typed observation-source capability tags used by
  wait/router subscribers

Channels are typed semantic capabilities. A channel folder defines an
`IngressChannel`, `EgressChannel`, `CallableChannel`, or
`BidirectionalChannel` service and the route projection that registers it.

## Completion semantics

Every route descriptor declares its completion shape — what evidence
signals "operation done" to the edge — via `ChannelRouteMetadata` and a
typed terminal receipt schema. The two production shapes:

| Shape | Meaning | Used by |
|---|---|---|
| `terminal` (response schema) | The dispatch returns a typed terminal value (e.g. `RuntimeStartRequestAck`, `SessionHandleReference`, a `RuntimeAgentOutputObservation` row, a `RouteCompletionReceipt`). The presence of the typed value IS the completion evidence. | `call`-verb routes; `wait_for`-verb routes. |
| `acknowledgement` (input intent row receipt) | The dispatch returns an acknowledgement that the intent was durably accepted. Completion of the *business operation* is observed separately through an ingress route. | `send`-verb routes (e.g. `host.prompt`, `session.prompt`). |

The completion shape lives on the **route descriptor + a terminal
receipt schema** — not on call-site flags, not solely on schema
annotations. This is load-bearing: the edge (ACP, MCP, CLI, HTTP) must
inspect the contract BEFORE dispatch so it can map terminal receipts to
the transport's response shape (e.g. ACP `PromptResponse` → `Done` |
`Rejected` based on `transportStopReason`).

### Falsifiers (what was rejected)

The `channel-completion-contracts` simulation explicitly rejected:

| Rejected placement | Why |
|---|---|
| Call-site flags (`isComplete`, `awaitMode`, `expectedReject`) | Callers can diverge from operation evidence — the edge has no inspectable contract before dispatch. |
| Schema annotations as the sole contract | Discoverable but not edge-facing; the edge cannot extract them from the route descriptor uniformly. Treat as supporting input only. |

### Reference

`packages/tiny-firegrid/src/simulations/channel-completion-contracts/`
+ `packages/tiny-firegrid/test/channel-completion-contracts/probe.test.ts`
— the structural proof that completion belongs on route descriptor
metadata + typed terminal receipt schema. If a future channel proposes
a different completion placement, the simulation is the regression gate.

## Channel-target indirection (host-declared registry)

A channel target is **the only name the agent sees**. The host owns
the underlying durable storage and stream routing; the channel name
points at *whatever projection the host wires under it*, and the agent
has no visibility into the substrate.

This name indirection is load-bearing:

- The agent issues `wait_for({ channel: "factory.events", whereFields:
  {…} })`. The agent does NOT know the channel is backed by
  `darkFactory.facts` rows projected through a host-owned
  `CallerOwnedFactStreams.streamFor("darkFactory.facts")`.
- The host can rewire the backing source without the agent changing.
  Storage migrations, source merges, schema-version splits — all
  invisible to the agent if the channel name + match-field shape are
  preserved.
- Substrate-leak strings (`DurableTable`, `RuntimeOutputTable`,
  `WorkflowEngine`, table names) must not appear in agent-facing
  schemas or `tools/list` responses. The locked-tool-surface guard in
  `subscribers/tool-dispatch/README.md` enforces this.

The `inv4-channel-registry` simulation
(`packages/tiny-firegrid/src/simulations/inv4-channel-registry/`)
demonstrates the pattern: an agent waits on the opaque channel name
`factory.events`; the host routes that to a private
`darkFactory.facts` durable table. The agent's `wait_for` tool input
schema names `channel: string` — not "table," not "stream URL," not
"row key."

### When you're adding a channel target

1. Declare the target name and `Context.Tag` in
   `packages/protocol/src/channels/<area>.ts` via
   `makeChannelTarget("…")`.
2. Provide the Live in `packages/runtime/src/channels/<name>/live.ts`
   binding the agent-facing name to your durable source (channel
   projection, observation stream, or `CallerOwnedFactStreams`
   resolver).
3. Register the route on `HostPlaneChannelRouter` /
   `RuntimeChannelRouter` (composition in `channels/router/live.ts`
   takes a list of `ChannelRegistration`s).
4. Pick a name that names the **agent-meaningful concern**, not the
   substrate. `factory.events` ✓; `verifiedWebhookFacts` ✗.

### When you're tempted to expose substrate

Don't. If an agent needs to observe a row, the host wires a channel
projection over the table. If the host has multiple sources that
belong under one observable name, it merges them under one
`IngressChannel` (see
[`makeVerifiedWebhookSource` + `mergeWebhookSourceChannels`](verified-webhook/README.md)
for the worked example).

## Terminal completion ordering

Per constraint **C7** in
`docs/cannon/architecture/runtime-design-constraints.md` §"Route
Completion":

> Immediate append/call receipts are router metadata. **Terminal prompt
> completion is durable runtime result state. Do not synthesize terminal
> `Done` at the ACP edge over raw `TurnComplete` observation. Bind
> terminal completion to the state/result fact that the keyed handler
> owns.**

In practice this means **observe `SessionLifecycleChannel`, not the
`Terminated` variant of `SessionAgentOutputChannel`**, when you need
the terminal "operation done" evidence:

| Concern | Channel | Why |
| --- | --- | --- |
| Did the agent emit a `Terminated` event? (raw codec event) | `session.agent_output` → `_tag: "Terminated"` | Raw TurnComplete-shaped observation. Useful for streaming UI, not for "did the run actually settle." |
| Did the durable run actually settle? (operation evidence) | `session.lifecycle` → `RuntimeRunEvent { status: "exited" \| "failed", exitCode, signal, message, … }` | The durable run-lifecycle row written by the keyed handler. The channel's `stream` IS `control.runs.rows().filter(...)`, so observation cannot resolve before the row exists. |

The ordering gap that motivates this: the codec's `Terminated` event
can fire **before** the keyed handler durably writes the run-lifecycle
row. An edge synthesizing "Done" from `Terminated` will signal
completion that downstream code can observe before the run state has
settled — leading to flaky races and lost retry context.

### Reference

`packages/tiny-firegrid/src/simulations/shape-c-terminal-ordering/`
reproduces the ordering gap and proves `SessionLifecycleChannel`
closes it. Production wiring:

| Concern | Production symbol |
|---|---|
| Durable run-lifecycle event row | `RuntimeRunEventSchema` — `packages/protocol/src/launch/schema.ts` |
| Durable runs table | `RuntimeControlPlaneTable.runs` |
| Per-session lifecycle ingress channel | `SessionLifecycleChannel.forSession(sessionId)` — `packages/protocol/src/channels/host-control.ts` |
| Channel Live | `RuntimeHostControlChannelsLive` — `packages/runtime/src/channels/host-control-routes.ts` |

## May import

- `events/`, `tables/`
- protocol channel contracts (`@firegrid/protocol/channels/*`)
- `effect`, `effect/Stream`

## Must not import

- peer-tier `producers/`, `transforms/`
- `subscribers/`, `composition/`. Subscribers consume channel tags through
  their `R` channel; the channels folder does not call subscribers.

## DO

```ts
// session/agent-output/index.ts
export const sessionAgentOutputChannel =
  Context.GenericTag<SessionAgentOutputChannelService>("...")
// session/agent-output/route.ts projects a route over the tag
```

## DO NOT

```ts
// router.ts
import { handleRuntimeContextEvent } from "../subscribers/runtime-context/handler.ts" // direction violation
```

## Scaffold status

Empty `host-control/`, `session/`, and `routes/` subfolders are staged as
Wave 2 destinations. The current top-level `.ts` files (`router.ts`,
`session-agent-output.ts`, `session-permission.ts`, `session-log.ts`,
`host-control.ts`, `session-agent-output-route.ts`,
`host-control-routes.ts`) are the live pre-cutover layout. Wave 2 sorts them
into the subfolders; the public `@firegrid/runtime/channels` barrel stays
stable.
