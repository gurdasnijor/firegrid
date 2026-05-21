# SDD: Firegrid Agent Body Plan — Channels As Nervous System

Status: proposal
Created: 2026-05-20
Owner: Firegrid Runtime / Agent Tool Surface

Related specs / docs:

- `/Users/gnijor/gurdasnijor/fireline/vault/guides/principles/concepts/channels-as-nervous-system.md`
- `/Users/gnijor/gurdasnijor/fireline/durable-stream-agent-plaform-rfc/concepts/choreography-and-combinators.fireline.md`
- `/Users/gnijor/gurdasnijor/firepixel/features/fireline-rfc/choreography-and-combinators.feature.yaml`
- `/Users/gnijor/smithery/forge/packages/agent/src/tools/index.ts` (reference for product-shape tool composition over substrate primitives)
- This repo: `SDD_CHOREOGRAPHY_FACADE.md`, `SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md`, `SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md`, `SDD_PERMISSION_CODEC_AUTHORITY.md`
- Field evidence: PR #446 (tf-v7t codec rationalization), PR #444 (tf-s8y native-`.mcp.json` spike), `docs/research/tf-h1gm-dark-factory-honest-halt.FINDING.md`

## Purpose

Capture a corrective design for Firegrid's agent-facing tool surface. The current surface conflates **substrate addressing** (`source._tag: "CallerFact", stream: "..."`) with **agent-facing semantics**. The substrate has the right machinery — durable rows, claim-first execution, projection streams, awakeable suspension, workflow deferred resume — but it leaks upward as the agent's mental model.

This SDD reframes the agent tool surface as a **body plan**: a typed inventory of *senses* (ingress channels), *faculties* (egress channels + the `call` paired req-resp pattern), and a small fixed verb count. Channels are opaque-to-the-agent typed handles registered by the host; substrate addressing happens entirely behind the channel boundary.

This is the same shape Fireline already implements at the substrate-neutral layer (`channel: ChannelTarget`), elevated by the channels-as-nervous-system framing in Fireline's vault, with concrete additions surfaced by tonight's dark-factory live run.

## Architectural Boundary: Channels Above Workflow Infrastructure

Channels are the application/agent-facing transport abstraction. Workflows are
the lower-tier durable execution substrate that makes channel operations
replayable, suspendable, and restart-safe.

The intended layering is:

```text
agent / app code
  -> semantic channel handle
  -> host-provided channel Layer / binding
  -> workflow engine, stream substrate, durable table CDC, clock, signal infra
```

The forbidden layering is:

```text
agent / app code
  -> workflow handle / execution id / stream URL / durable table CDC details
  -> manual engine or substrate wiring
```

In other words: workflows belong in the infrastructure tier, like a database
driver or queue client. Application and agent code should not pass workflow
handles around as naked coordination objects. Host composition may register
channel bindings backed by workflows, durable streams, tables, clocks, webhooks,
human approval queues, or future engine-native primitives, but the agent-facing
surface remains the channel handle plus the fixed verbs in this SDD.

In Effect terms, the channel inventory should be a `Context`/`Layer`-provided
capability surface, not a mutable application registry object. A host composes
the agent's body plan by providing channel services in a Layer. The MCP string
name boundary may need a lookup table to decode `"factory.events"` into the
corresponding service, but that lookup is an adapter at the protocol edge, not
the application model and not something business logic passes around. If a file
or service is called "registry", it must behave like a Layer-composed binding
manifest, not a second runtime or naked map of workflow handles.

This distinction matters for the Phase 1 bridge. A temporary
`wait_for(source/query) -> WaitForWorkflow` cutover is acceptable as a substrate
collapse step because it removes the `durable-tools` wait-router. It is not the
final body-plan surface. Phase 2 must continue to hide `source._tag`, stream
names, workflow execution ids, engine services, and table CDC details behind
registered channels.

## Problem (substrate currently leaks into the agent)

Tonight's `dark-factory` live run (against a real `claude-agent-acp@0.36.1` planner, with PR #446's codec rationalization landed) made the leak concrete. From `tf-h1gm-dark-factory-honest-halt.FINDING.md`:

> *"The available Firegrid surface in this session offers `wait_for` over `CallerFact{stream: 'darkFactory.facts'}` only with a non-empty `whereFields` predicate set (empty predicates are rejected). There is no read-latest, list-stream, peek, or schema-introspection operation exposed on the runtime-context MCP toolset, and the seeded fact's schema is not declared in the task framing or recoverable from the tools available."*

The agent honestly halted (`DARK_FACTORY_FINDING` per the prompt's halt-honestly clause) — a successful introspective act, but a clear signal that the body plan was thin. Specifically:

1. **`wait_for` exposes substrate source taxonomy.** The agent sees `source._tag: "CallerFact"` and addresses by `stream` name — both are substrate storage concepts. The agent's mental model becomes "I am querying a substrate" instead of "I am sensing a channel."

2. **Channel discovery is forced into the predicate path.** Empty `whereFields` is rejected. There is no peek-without-predicate semantic. The agent therefore cannot observe a channel before knowing its schema.

3. **Schema is implicit.** A channel's row shape is known only to the host author. The agent has no body-plan-time declaration to read; tonight's agent guessed six predicate shapes (`_tag: Trigger / DarkFactoryTrigger / Seed / Start`, `kind: trigger`, `type: trigger`) and timed out on each.

4. **Permission flow is hidden as driver glue.** Tonight's run only progressed because the driver's `forkAutoApprovePermissions` handled `session.wait.forPermissionRequest`. The agent has no first-class `call(approval, ...)` verb that surfaces the request-response paired pattern; permission is a side channel the driver mediates, not a body-plan-visible faculty.

5. **No interoception.** The agent cannot perceive its own lifecycle, budget, or checkpoint state. It cannot self-modulate. (`session.self.*` is absent from the agent tool surface.)

6. **No peer-pheromone channel.** `event(name)` (named ad-hoc ingress + egress on the durable log) is not exposed. Inter-agent indirect coordination — the choreography thesis's strongest case — requires either piggy-backing on `CallerFact` streams (substrate-leaky) or out-of-band orchestration (which the choreography model rejects).

7. **Wait-router and durable-tools record names are substrate-shaped, not body-plan-shaped.** Fireline's contract names the records `fireline.agent.suspended` and `fireline.agent.resumed`. Firegrid emits `durable_tools.wait_for.upsert_active` and `wait_router.complete_match`. Functionally analogous; semantically misaligned with the spec.

## Design Inputs

This SDD is the synthesis of three reference frames:

1. **Fireline's `choreography-and-combinators.fireline.md`** — substrate-neutral primitive set. Six canonical verbs (`sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, `execute`) with opaque `ChannelTarget` / `SandboxTarget` / `agent: String` addressing. Every primitive emits a canonical `suspended` + `resumed` record pair carrying the operation, channel, and result.

2. **Fireline's `channels-as-nervous-system.md`** — the mental model that elevates "what tools should the agent have?" into "what is the agent's body plan?" Channels are typed ingress (sensory) or egress (motor) pathways. The agent reasons about senses and faculties, not tools. The substrate (the spinal cord) makes durable suspension possible without burning compute.

3. **Smithery Forge's `tools/index.ts`** — empirical reference for product-shape composition over a substrate. Forge hides substrate verbs entirely; agents see `send_message(to, text, {wait_for_reply})`, `wait_for_message(from, timeout)`, `memory.{...}`, `update_plan(..., {requestApproval})`, `delegate(task, {maxBudget, maxTurns})`. Each is a semantic verb that composes substrate ops (awakeable, sleep, state, emit) under a typed name. The agent never sees "stream," "awakeable," or "sandbox-provider."

The Firepixel feature spec `choreography-and-combinators.feature.yaml` ties these together: the substrate primitives (TOOL_SURFACE), the agent-side composition (COMBINATORS), the materializer model (MATERIALIZERS), and the round-trip requirement (ROUND_TRIP) that every managed-agent feature must map cleanly to a primitive plus a combinator or materializer operation.

## Mental Model (the body plan)

Adopting the channels-as-nervous-system framing, every Firegrid agent has three structural parts:

```
                 ┌─────────────────────┐
                 │       BRAIN         │       LLM + harness loop
                 │  (LLM + harness)    │       — reasons, decides
                 └──────────┬──────────┘
                            │
            sensory ⬆ │ ⬇ motor
                            │
                 ┌──────────┴──────────┐
                 │    NERVOUS SYSTEM   │       Channels — typed,
                 │     (channels)      │       opaque to substrate
                 │  carries signals    │       below, semantic to brain
                 └──────────┬──────────┘       above
                            │
                 ┌──────────┴──────────┐
                 │       HANDS         │       Sandboxes / MCP / tools
                 │ (sandboxes, hands)  │       — execute, return
                 └─────────────────────┘
                       (and: the world,
                        time, peers, humans)
```

The brain is configured by host composition (agent registration + system prompt). The hands are declared by the host's sandbox bindings. **The nervous system — the channels — is what this SDD's body plan declares.** Verbs (the small fixed set) operate over channels; channels are typed; channel direction is type-enforced.

## Verb Inventory

The verb count is **fixed and small**, aligned with the Fireline canonical primitives plus the two communication verbs the channels-as-nervous-system doc names:

| Verb | Direction | Suspends? | Result shape |
|---|---|---|---|
| `sleep(duration, reason?)` | (internal — time channel) | yes | `WaitOutcome` (time elapsed) |
| `wait_for(channel: ChannelTarget, match?, timeoutMs?)` | ingress | yes | `WaitOutcome { matched, eventJson?, reason? }` |
| `wait_for_any([channelDescriptor...], timeoutMs?)` | ingress (multi) | yes | `{ winnerIndex, channel, result }` |
| `send(channel: WritableChannel, payload)` | egress (fire-and-forget) | no | `{ ok }` (best-effort) |
| `call(channel: CallableChannel, request)` | egress + paired ingress | yes | response payload |
| `schedule_me(when, prompt)` | egress (time.schedule) | no (resumes via new session later) | `{ scheduledAt }` |
| `spawn(agent, prompt, opts?)` | (peer — not a channel; ACP-native) | yes | `SpawnResult` |
| `spawn_all([tasks])` | (peer multi) | yes | `SpawnResult[]` |
| `execute(sandbox, input)` | egress (sandbox channel) | yes | `ExecuteResult` |

**Total: 9 verbs.** Strict superset of Fireline's 6 (adds `send`, `call`, `wait_for_any` as first-class verbs per the channels-as-nervous-system doc's sensory-integration and motor patterns).

- `send` vs `call`: biological-style distinction. `send` is fire-and-forget into an egress channel (broadcast, notification, log). `call` is the paired request-response pattern (approval, gated review, ask-permission). `call` suspends durably waiting on its paired response.
- `wait_for_any` is sensory integration — the agent waits on multiple channels concurrently, acts on whichever fires first. The brain doesn't dedicate one process per modality.

**No new verbs are needed beyond these nine.** Tonight's "discovery gap" (peek / list-streams / schema-introspection) dissolves at the verb layer: it becomes a property of how channels are *declared* (schema-carrying registration) and how `wait_for` is *invoked* (`match` is optional; `timeoutMs: 0` + no match returns latest-or-none).

## Channel Inventory

The channels are the body plan's typed inventory. Each channel is registered at the host layer with: a name (opaque to the agent), a direction (ingress / egress / call), a typed payload schema, and a substrate-side binding (which durable-table / runtime-state / awakeable mechanism backs it).

Cross-referencing the channels-as-nervous-system doc against Firegrid today:

| Channel | Direction | Biological analogue | Firegrid substrate binding (existing) | Status |
|---|---|---|---|---|
| `time.elapsed(duration)` | ingress | circadian | `Effect.sleep` / `DurableClock` | wraps `sleep`; needs naming as a channel for `wait_for_any` composition |
| `time.at(instant)` | ingress | scheduled alarm | `DurableClock` | not exposed |
| `time.schedule(prompt, when)` | egress | "I'll wake at dawn" | `schedule_me` substrate | exists as verb-bound; rename to channel-bound |
| `state.changes(collection)` | ingress | proprioception | `DurableTable.rows()` | substantive add — wrap rows-stream as channel; schema-carrying via collection type |
| `state.control` | ingress | vestibular reorientation | snapshot / reset substrate | substantive add |
| `session.self.lifecycle` | ingress | interoception | `firegrid.runtime_context.workflow.*` spans | **substantive add — high leverage** |
| `session.self.checkpoint` | ingress | interoception | workflow checkpoint substrate | substantive add |
| `webhook.intent(name)` | ingress | hearing | (no current binding; closest: `CallerFact` streams) | substantive add or rename of `CallerFact` |
| `event(name)` | ingress + egress | pheromone | `CallerFact` streams reshaped | substantive add — high leverage for choreography |
| `dm(handle)` (human channel) | ingress | conversation | (no binding) | substantive add — human-loop sense |
| `notification(handle)` (human channel) | egress | speech | (no binding) | substantive add — human-loop faculty |
| `approval(handle)` (human channel) | call (req+resp) | asking permission | `PermissionRequest`/`PermissionResponse` substrate | exists as substrate; not channel-shaped at agent surface |
| `sandbox.<name>` | egress | skeletal motor | `executeSandboxTool` | exists as verb-bound (`execute`); align as channel |
| `session.log` | egress | memory consolidation | runtime input intent / agent output rows | substantive add |

**Net of "substantive add" items:** seven new channels to introduce, three existing channels to rename/realign. The verb layer above doesn't change shape — each new channel is consumable by existing `wait_for` / `send` / `call`.

### Channel direction is type-enforced

The doc's typed-verb constraint must be carried into Firegrid's type system. The proposed types:

```ts
type ChannelDirection = "ingress" | "egress" | "call"

interface IngressChannel<Row> {
  readonly direction: "ingress"
  readonly id: string                 // opaque to agent; host-registered
  readonly schema: SchemaTag<Row>     // row type the agent can observe
}

interface EgressChannel<Req> {
  readonly direction: "egress"
  readonly id: string
  readonly schema: SchemaTag<Req>     // payload type the agent emits
}

interface CallableChannel<Req, Resp> {
  readonly direction: "call"
  readonly id: string
  readonly requestSchema: SchemaTag<Req>
  readonly responseSchema: SchemaTag<Resp>
}

type Channel<Req = never, Res = never> =
  | IngressChannel<Res>
  | EgressChannel<Req>
  | CallableChannel<Req, Res>

// The verb signatures enforce direction:
declare function wait_for<Req, Res>(
  channel: IngressChannel<Res> | CallableChannel<Req, Res>,
  options?: { match?: ChannelMatch<Res>; timeoutMs?: number },
): Effect<WaitOutcome<Res>>

declare function send<Req, Res>(
  channel: EgressChannel<Req> | CallableChannel<Req, Res>,
  payload: Req,
): Effect<{ ok: true }>

declare function call<Req, Resp>(
  channel: CallableChannel<Req, Resp>,
  request: Req,
): Effect<Resp>
```

The compile-time enforcement means `send(state.changes(...), ...)` is rejected at the type level (state writes go through the dedicated `memory()` middleware path per the doc); `wait_for(notification, ...)` is rejected (notifications are egress-only); `call(time.elapsed, ...)` is rejected (time isn't callable).

There is no separate `channel.peek(...)` operation. Immediate observation is
the existing verb shape: `wait_for(channel, {match, timeoutMs: 0})`. Body
authors who need Pattern A peek/await behavior operate below the channel layer
with engine/body primitives; the agent-facing channel surface stays the fixed
`wait_for` / `send` / `call` verb set.

## What this is, in one diagram (Firegrid-specific)

```
Agent's mental model:
  senses: [time, state.changes(...), session.self.lifecycle,
           webhook.intent(...), dm(human), event("plan.ready"), ...]
  faculties:
    plan_future = schedule_me
    manipulate  = execute(sandbox.<name>, ...)
    speak       = send(notification(human), ...)
    ask         = call(approval(human), ...)
    broadcast   = send(event("X"), payload)
    log         = send(session.log, marker)
    spawn       = spawn(agent, prompt) | spawn_all([...])
    rest        = sleep(...) | wait_for(...) | wait_for_any([...])

Substrate (hidden from agent):
  DurableTable rows ─┐
  Awakeables / Deferreds ─┼─→ channel-typed wrappers (host-registered)
  Workflow checkpoints ─┘
  Sandbox providers ─→ sandbox.<name> channel binding
  ACP session/request_permission ─→ approval(human) call channel
  CallerFact streams ─→ event(name) ingress+egress channel
```

The agent never sees the bottom layer. The substrate is **how channels stay durable**, not what the agent reasons about.

## Channels Over Durable Operators

The strongest version of the channel abstraction is generic over the typed
durable operator it hides. A channel can be parameterized by the request and
response row/event types of a `DurableTable` collection or any equivalent
projection stream:

```ts
type VerifiedWebhookFactChannel = IngressChannel<VerifiedWebhookFact>
type ApprovalChannel = CallableChannel<ApprovalRequest, ApprovalResponse>
```

Firegrid channel types are semantic tagged-union capabilities, not aliases for
`effect/Channel`. Effect's `Channel` is a lower-level stream/sink transducer
primitive; pulling that name into the agent surface or channel binding
vocabulary would conflate body-plan semantics with implementation plumbing.
Use ordinary substrate shapes behind the Firegrid channel boundary:

```ts
type IngressSource<Row, E, R> = () => Stream.Stream<Row, E, R>
type EgressSink<Req, E, R> = (request: Req) => Effect.Effect<void, E, R>
type CallableHandler<Req, Res, E, R> = (request: Req) => Effect.Effect<Res, E, R>
```

If a concrete adapter later benefits from `effect/Channel` internally, it may
use it below this boundary and expose a `Stream`, sink, or effectful handler to
the Firegrid channel layer. Do not import `effect/Channel` into channel
registry, agent-tool schema, or body-plan vocabulary.

`packages/effect-durable-operators/src/DurableTable.ts` already exposes the
right substrate shape: `CollectionFacade<Row>.rows()` returns a branded
`ProjectionStream<Row>` — current rows plus live non-deleted row changes. That
is exactly an ingress channel's hidden transport. The channel source is a lazy
factory, not a pre-materialized subscription, so host composition can provide
the binding without opening the stream until the hidden substrate needs it:

```ts
const VerifiedWebhookFacts = Channel.ingress<VerifiedWebhookFact>({
  name: "firegrid.verifiedWebhooks",
  schema: VerifiedWebhookFactSchema,
  source: () => VerifiedWebhookFactTable.verifiedWebhookFacts.rows(),
})
```

The channel's schema is normally the same Schema instance used by the durable
table row definition. When the agent-facing channel is a projection, the
channel schema is a derived projection schema. It should not be a duplicated
parallel validator that can drift from the durable row shape.

The agent sees only:

```ts
wait_for("firegrid.verifiedWebhooks", {
  match: {
    source: "linear-demo",
    eventType: "Issue.create",
    webhookId: "delivery_123",
  },
  timeoutMs: 30_000,
})
```

Linear is data in this example, not a canonical channel family. A product or
adapter package may add a convenience projection for Linear if it has a real
consumer, but the protocol/root channel remains the source-neutral verified
webhook fact channel.

At the SDK/channel-binding layer, `match` lowers to Effect's `Predicate<Row>`
vocabulary, aligned with the engine-native primitives SDD:
`Predicate.and`, `Predicate.or`, `Predicate.struct`, and Firegrid-owned
predicate factories that attach optional engine optimization hints. At the MCP
wire edge, the agent sends serializable JSON match input such as
`{action: "issue.created"}`; the channel binding decodes that input against the
channel schema and compiles it into the hidden `Predicate<Row>`. The predicate
contract is the same as `streamWait` / `streamWaitAny`: deterministic row
inspection only, no wall-clock, random, I/O, or mutable closure state.

It does not see `DurableTable`, `ProjectionStream`, collection names,
subscriptions, CDC mechanics, primary keys, workflow execution ids, or the
engine service. The channel binding owns those details.

Egress is the symmetric shape: the agent emits a typed payload, while the
channel binding owns the durable append/upsert mechanics:

```ts
const ToolResultEvents = Channel.egress<ToolResult>({
  name: "tool.result",
  schema: ToolResultSchema,
  sink: (row) => ToolResultTable.events.upsert(row),
})

send("tool.result", {
  toolUseId: "...",
  result: {...},
})
```

This generalizes beyond webhooks:

- `Channel<VerifiedWebhookFact>` exposes verified inbound webhooks through
  `firegrid.verifiedWebhooks`; app layers may add narrower provider-specific
  projections.
- `Channel<RuntimeAgentOutputObservation>` exposes session output.
- `Channel<RuntimeRun>` exposes lifecycle state.
- `Channel<MyDomainEvent>` exposes any app-owned durable table row stream.

So channels are not a parallel data model. They are the typed semantic façade
over Firegrid's existing durable operators and stream-backed workflow substrate.
Combinators such as `Channel.union(a, b)` and `Channel.map(c, fn)` are natural
future additions, but they are intentionally deferred until the first concrete
consumer needs them.

## Current Substrate Bridge

This SDD is a **presentation-layer reframing**, not a substrate redesign. It
assumes the one-substrate work is collapsing the old `durable-tools`
wait-router into the workflow engine before channels become the agent-facing
surface. The current Phase 1 bridge is PR #489 / `tf-xw0w`:

```text
wait_for(source/query)
  -> WaitForWorkflow
  -> Activity-internal match-or-timeout race
```

That bridge is intentionally pre-channel. It preserves the current
`RuntimeWaitSource` / scalar `whereFields` input shape while deleting the old
`WaitFor.match` wait-router path. Phase 2 then replaces the visible
`source/query` payload with:

```text
wait_for(channel, match?, timeoutMs?)
  -> Layer-provided channel binding
  -> WaitForWorkflow or engine-native streamWait / streamWaitAny
```

### What changed from the older Shape A plan

Older drafts of this SDD described two substrate wait shapes:

- static-source inline `Stream.runHead`;
- dynamic-source `WaitFor.match` + wait-router.

That framing is stale. The current cutover direction is:

- runtime-context body: explicit state-machine driver over materialized
  input/output events, with one coherent suspension point;
- agent-tool `wait_for`: `WaitForWorkflow`, currently implemented as a
  race-inside-Activity bridge;
- future channel surface: Layer-provided channel bindings over durable
  operators, workflow primitives, or engine-native waits.

Do not reintroduce `WaitFor.match`, wait-router rows, or durable-tools wait
store semantics as the Phase 2 channel implementation.

### Race-Inside-Activity bridge caveat

PR #489 uses the race-inside-Activity pattern because body-side
`DurableDeferred.raceAll([Stream.runHead, DurableClock.sleep])` does not fit the
workflow body's single-suspension-point model. The Activity is the single
suspension point; its internals can race the durable stream read against an
in-memory timeout.

The tradeoff is tracked as `tf-wunq`: timeout is per Activity attempt, not an
absolute durable deadline. If the host or engine recycles while a `wait_for`
timeout is in flight, the Activity retries and starts a fresh `Effect.sleep`.
This can extend the effective timeout across bounces. It is a bounded
liveness/SLA concession, not correctness corruption:

- matching rows still come from durable streams;
- replay is not poisoned by interrupted race deferreds;
- same-generation match and timeout behavior remain valid;
- repeated bounces can delay timeout until one generation stays alive long
  enough.

The final channel implementation should migrate this bridge to engine-native
`streamWait` / `streamWaitAny` with persisted absolute deadlines when that
primitive exists. Until then, the bridge is acceptable only if PRs and findings
cite the `tf-wunq` caveat explicitly.

### What this means for the body-plan migration's Slice A ordering

The migration plan below is sequenced after the Phase 1 one-substrate cutover
has landed far enough that `durable-tools` is no longer the backing wait
surface. Slice A should not build a new channel façade over the old wait-router.

The channel Layer classifies each provided binding by capability at composition
time:

- ingress channels backed by durable operators use typed projection streams
  such as `CollectionFacade<Row>.rows()`;
- call channels pair an egress request binding with an ingress response binding;
- eventual multi-source waits lower to engine-native `streamWaitAny`, not
  body-side concurrent stream combinators.

The agent never sees which substrate backs a channel. It calls
`wait_for(channel, match?, timeoutMs?)`; the Layer-provided binding chooses the
hidden transport.

## Migration Plan

The migration is staged so each slice is independently shippable and falsifiable.
Slice A is gated on the Phase 1 one-substrate cutover, especially PR #489's
`WaitForWorkflow` bridge. Slices B-D can land in parallel with Slice A once it
starts.

### Slice A — Opaque `ChannelTarget` for `wait_for`

**What changes:** `wait_for`'s tool input becomes `{channel: ChannelTarget, match?, timeoutMs?}` where `ChannelTarget` is an opaque token string. The host composes a **channel Layer** that provides named ingress/egress/call capabilities (current `source: {_tag: "CallerFact", stream}` becomes an internal binding, not an agent-visible arg shape).

**Affected files:**

- `packages/protocol/src/agent-tools/schema.ts` — `WaitForToolInput` schema rewrite (replace `source` / `waitQuery` exposure with `channel`, optional `match`, optional `timeoutMs`).
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` — resolve `ChannelTarget` through the Layer-provided channel binding, then call `WaitForWorkflow` or an engine-native wait primitive.
- host-side channel Layer / binding manifest — `name → IngressChannel | EgressChannel | CallableChannel`. Channels are provided at host startup through Effect Layer composition; only the MCP protocol edge needs a name lookup to decode tool input.
- `packages/host-sdk/src/agent-tools/bindings/tools.ts` — toolkit binding for `wait_for` updated to publish typed channel options.
- focused host-sdk/protocol tests — update fixtures to assert the agent-visible schema no longer contains `source`, `source._tag`, `stream`, or workflow/engine coordinates.

**Backwards compatibility:** the current `source: {_tag: "CallerFact", stream}` shape is internal only after this slice; agents never see it again. No external API is broken — only the agent-tool input shape changes, which Firegrid owns.

**Acceptance:** existing dark-factory and other sims pass after channel-layer migration; the agent's tool input schema (visible via MCP tools/list) shows `channel: string` and no longer shows `source._tag` discriminants.

### Slice B — Optional `match` + `timeoutMs: 0` discovery semantics

**What changes:** lift the empty-predicate rejection on `wait_for`. With `match: undefined` and `timeoutMs: 0`, the call returns the latest matching row on the channel (or `{matched: false, reason: "timeout"}` if the channel has no history). With `match: undefined` and a non-zero `timeoutMs`, the call returns the *next* row (snapshot OR live) on the channel.

**Affected files:**

- channel binding implementation for the affected ingress channel.
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` or the future engine-native wait primitive — implement immediate snapshot / latest-or-none semantics without reintroducing wait-router rows.

**Acceptance:** in dark-factory, `wait_for(channel: "factory.events")` with no match and `timeoutMs: 0` returns the seeded trigger fact's row (because the channel has history) — closing the discovery gap tonight's agent surfaced without any new verb.

### Slice C — Channel inventory expansion (per-channel beads)

Each of the substantive channel types from the table above is its own slice. Suggested order by leverage:

1. **`session.self.lifecycle` / `session.self.checkpoint`** (interoception) — highest unique-to-choreography value. Substrate exists; agent-facing channel wrapper is the new piece.
2. **`event(name)`** (peer pheromone) — the choreography thesis's strongest case. Reshape `CallerFact` into a typed event channel with explicit `name` + schema registration; both ingress and egress.
3. **`state.changes(collection)`** (proprioception) — wrap `DurableTable.rows()` as a typed channel; schema is the collection's row schema. Solves the discovery problem structurally — channel declaration carries its own type.
4. **`approval(handle)`** (call channel) — replaces the ad-hoc permission flow tonight's driver auto-approver covers. The host registers an `approval(...)` channel; ACP `session/request_permission` is routed through it; the agent sees `call(approval, {prompt, options})` as a verb-bound faculty.
5. **`dm` / `notification`** (human conversation) — the human-channel pair. Probably built first as a generic `{ingress dm + egress notification + call approval}` triad parameterized by handle.
6. **`session.log`** (own marker / memory consolidation) — cheapest add; lets the agent annotate its own history.
7. **`firegrid.verifiedWebhooks` / app webhook channels** — use the generic
   verified webhook fact channel for Firegrid-owned defaults; add app-owned
   convenience channels only when product semantics justify them.

Each slice is its own bead, ~one to two files per channel, plus a test fixture in `scenarios/firegrid/`.

### Slice D — `send` / `call` / `wait_for_any` verb additions

Once Slice A lands (channels are first-class typed handles), the new verbs are mechanical additions to `FiregridAgentToolkit`:

- `send` — append-fact-shaped, governed by per-channel append-allow policy on the binding. Direction-enforced at the type level (only `EgressChannel` accepted).
- `call` — composes `send` (request) + `wait_for` (response) under a paired-channel handle. Suspends durably; resumes when the response row appears on the call channel's response side. This is what tonight's `call(approval, ...)` would have looked like if it existed.
- `wait_for_any` — accepts an array of `IngressChannel` (or call-channel response-side) descriptors with optional per-channel `match`. Returns the first-firing channel's result + a discriminator (`{ winnerIndex, channel, result }`). Substrate: races N `wait_for`s and cancels the losers.

**Affected files:**

- `packages/host-sdk/src/agent-tools/bindings/tools.ts` — add `send`, `call`, `wait_for_any` toolkit entries.
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` — handler wiring (each composes existing substrate primitives).
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` — dispatch case adds.
- `packages/protocol/src/agent-tools/schema.ts` — `SendToolInputSchema`, `CallToolInputSchema`, `WaitForAnyToolInputSchema`.

**Acceptance:** the dark-factory sim can be re-driven with the driver's `forkAutoApprovePermissions` removed, because the agent now calls `call(approval(...), ...)` and the human-channel handler routes through the registered approval channel. Tonight's ~70 lines of driver glue dissolves into channel registration.

### Slice E — Canonical record names

Align with Fireline's `{operation}.suspended` / `{operation}.resumed` record contract. This is purely a renaming/aliasing exercise at the substrate emit layer; Firegrid's existing `durable_tools.wait_for.upsert_active` etc. either:

- (a) Get renamed to `fireline.agent.suspended` with `operation: "wait_for"` (breaking but spec-aligning), OR
- (b) Add the canonical names alongside existing names (additive; both are emitted).

Recommendation: defer this until after `durable-tools` deletion. The canonical
records should be emitted from the workflow/engine/channel boundary, not by
reviving wait-router emit sites.

## What this is NOT

- **Not a substrate redesign.** Every machinery primitive Firegrid has today (durable tables, awakeables, workflow checkpoints, claim-first execution, projection observation) stays as-is. Only the *agent-facing* presentation layer changes.
- **Not a tool-count expansion in the sense of "more product tools."** Forge has many product-shaped tools (`bash`, `memory.{...}`, `update_plan`, etc.) — Firegrid's tools at the substrate layer remain the 9 listed above. Product-shape tools (memory, finish, update_plan, bash) are for **consumers** of Firegrid to layer on top, not for Firegrid core to ship.
- **Not a breaking change to host-sdk consumers.** The channel Layer is additive; existing `runtime.config.mcpServers` style declarations get migrated to channel bindings by a one-to-one mapping. Consumer apps continue to declare what tools/channels are available to the agent the same way they do today (via host construction), with a shape change.
- **Not in scope: `memory.*` / `update_plan` / `finish` product tools.** These are Forge-shaped product affordances. They compose existing substrate (state, awakeable, append-fact) and could be added as a separate SDD if Firegrid wants to ship an opinionated agent product. This SDD covers the **substrate-neutral** body plan; product-shape composition is downstream.

## Acceptance criteria (full SDD-level)

1. Agent's MCP tools/list output shows: 9 verbs (`sleep`, `wait_for`, `wait_for_any`, `send`, `call`, `schedule_me`, `spawn`, `spawn_all`, `execute`) and the channel inventory registered by the host as opaque-named typed targets.
2. No agent-facing input schema mentions `source._tag` or any substrate-storage taxonomy.
3. Dark-factory sim re-runs cleanly with permission auto-approve removed from the driver — the agent calls `call(approval(...), ...)` directly.
4. Dark-factory sim demonstrates discovery via `wait_for(channel: "factory.events", timeoutMs: 0)` returning the seeded trigger fact's row.
5. A toy sim demonstrating two agents coordinating via `event("plan.ready")` — one sends, the other waits, no orchestrator.
6. Interoception demonstrated: a long-running sim where the agent `wait_for(session.self.lifecycle)` on `budget-exceeded` and self-modulates (summarizes + halts) before the runtime forcibly terminates it.
7. Spec alignment: Firegrid emits the canonical `fireline.agent.suspended` + `fireline.agent.resumed` record pair (additively or exclusively) for every verb suspension.
8. The `choreography-and-combinators.feature.yaml` ROUND_TRIP requirements (1-6) each map to a primitive + channel combination expressible in the post-migration tool surface.

## Open questions

1. **Channel composition is a host-startup concern.** Today's tiny-firegrid host (e.g., `dark-factory/host.ts`) declares MCP server URLs and seeds facts. Should channel Layer composition sit alongside that, or move into a separate host composition step? Recommend: it goes alongside, since channel inventory IS the body plan. The binding's substrate side should be a single Layer-provided configuration site, not a registry-plus-router split.
2. **How does `event(name)` schema get declared?** A typed channel needs a schema. Either: (a) channels are registered with an explicit Effect Schema; (b) channels are registered with a JSON Schema; (c) typed via the `DurableTable` row type when backed by a collection. Recommend (c) where possible, (a) for hand-declared events.
3. **`spawn` is "synaptic, not channel" per the doc.** Should `spawn` remain a verb that doesn't go through the channel layer, or should there be a `peer(name)` channel? Recommend: stays as a verb (matching the doc), but a `peer.lifecycle(child_id)` *ingress* channel exists so the parent can `wait_for_any([peer.lifecycle(c1), peer.lifecycle(c2)])` for fastest-child semantics.
4. **Permission-channel routing**: today the ACP permission gate triggers a runtime workflow that awaits a `PermissionResponse` row. After the migration, that wiring is "the substrate side of the `approval` channel." Confirm this aligns with `SDD_PERMISSION_CODEC_AUTHORITY.md`'s invariants.
5. **Wire format for `match` and `eventJson`**: Fireline's TS schema encodes match/event as string-encoded JSON (`matchJson`, `eventJson`); the Rust side carries parsed `Value`. Firegrid is TS-only currently — should we adopt the string-encoded form for spec parity, or use typed JSON Schema values directly? Recommend typed values internally with string-encoded only at the ACP wire boundary.
6. **Migration of existing `CallerFact` consumers**: dark-factory, the wait-pre-attach-roundtrip sim, and any in-flight consumers all need their channel declarations migrated. Is a single batch migration acceptable, or do we want a deprecation period?

## Cross-references

- PR #489 / `tf-xw0w` — current Phase 1 `wait_for(source/query) -> WaitForWorkflow` bridge. Pre-channel substrate cutover; carries the race-inside-Activity timeout caveat.
- `tf-wunq` — known P2 issue for PR #489's bridge: timeout restarts per Activity attempt across engine recycle until `streamWait` / `streamWaitAny` provides persisted absolute deadlines.
- `docs/research/workflow-body-single-suspension-rule.md` — authoring rule that explains why body-side concurrent stream/race combinators are not the channel implementation strategy.
- `SDD_CHOREOGRAPHY_FACADE.md` — overlapping scope; this SDD extends the choreography facade into the explicit body-plan / channels-as-nervous-system framing.
- `SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md` — the prior typed-wait-source work; this SDD subsumes it by replacing typed source taxonomy with channel Layer bindings.
- `SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md` — the agent-event pipeline this SDD's channels read from / write to.
- `SDD_PERMISSION_CODEC_AUTHORITY.md` — the permission flow this SDD's `approval` channel surfaces as a faculty.
- `SDD_FIREGRID_FIRELINE_READINESS.md` / `SDD_FIREGRID_FIREPIXEL_FOUNDATION.md` — the conformance work this SDD operates within.
- `docs/research/tf-h1gm-dark-factory-honest-halt.FINDING.md` — field evidence motivating the body-plan reframing.
- PR #446 (`tf-v7t-s6-codec-mcp-json-rationalize`) — the codec rationalization landed alongside this SDD.

## Out-of-scope follow-ups (separately ticketed)

- `tf-85bs` — `wait.forAgentOutput` hot loop in client-sdk. Orthogonal driver-side fix; not part of this body-plan migration.
- `tf-9cn` — `settingSources` scoping for sim runs. Sim-hygiene; orthogonal.
- §9g instrumentation lane — recommended **closed** in light of tonight's findings (all 5 candidate causes resolved or out-of-scope). See `tf-h1gm-dark-factory-honest-halt.FINDING.md` §"§9g instrumentation lane — UNNECESSARY."
- Product-shape agent tools (`memory.*`, `update_plan`, `finish`, `delegate` with budgets) — separate SDD if Firegrid wants an opinionated agent product surface.
