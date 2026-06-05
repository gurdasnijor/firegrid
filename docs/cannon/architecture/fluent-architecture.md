# Fluent Architecture

Doc-Class: internal-contract
Status: active
Date: 2026-06-05
Owner: Firegrid Architecture

This is the canonical high-level architecture reference for the fluent Firegrid
workstream. It defines package boundaries, process ownership, durable stream
read/write ownership, and schema ownership. The execution-focused design details
remain in `docs/sdds/fluent-firegrid-sdd.md`.

## Document Shape

This document follows the same structure as the Durable Streams layered consumer
spec introduced in durable-streams PR #346:

1. overview and system shape;
2. layer architecture;
3. core concepts and ownership;
4. interaction flows;
5. safety invariants and non-goals;
6. implementation gaps that must be proven.

The aim is to make every boundary falsifiable. A reader should be able to point
at an actor, a stream write, a wake, or a schema and know which package owns it.

## Summary

Firegrid is not the manager of the agent's reasoning loop. The external harness
owns the loop; Firegrid owns durable coordination around that loop.

The durable source of truth is a Durable Streams log. Multiple Firegrid-owned or
Firegrid-integrated actors read and write that log:

- the harness adapter records observed agent events;
- the fluent host records coordination events and resolves waits;
- clients append user/control intents through an authorized surface;
- workers append timer, child, and wake results;
- projections read the log to render or verify product state.

The raw agent process does not write to Durable Streams directly. A bridge or
adapter may write, but that bridge is part of the Firegrid integration boundary,
not the harness itself.

The choreography promise scales across harnesses because the contract is not
"run this one agent implementation." It is: adapt any Claude, Codex, ACP, stdio,
HTTP, cloud-hosted, or future agent harness into the same durable surface. Every
harness gets the same Firegrid durable tools and the same stream-derived
observation plane; differences stay inside the adapter.

This architecture intentionally supersedes the Restate-style session reading in
which a long-lived `gen`/`run` body parks on a durable promise for the session.
That model is still useful for pure coordination workflows, sagas, and authored
multi-step procedures. It is not the session model. A session is host-driven
harness coordination: the host reacts per wake, materializes facts, reconstructs
the harness resume artifact, and records coordination outcomes. The external
harness owns the model loop.

## System Shape

```text
AUTHORING LIBRARY
┌──────────────────────────────────────────────────────────────────────┐
│ packages/fluent-firegrid                                             │
│ Operation/Future engine, combinators, descriptors, typed clients      │
│ Process-free. Imported by handlers and by packages/fluent-runtime.    │
└──────────────────────────────────────────────────────────────────────┘

LIVE ACTORS / PROCESSES
Control and coordination:
┌────────────────────────────┐   intents / facts   ┌─────────────────────┐
│ clients, webhooks, peers   │────────────────────▶│ packages/          │
│ prompt, approval, cancel,  │                     │ fluent-runtime     │
│ state change, send/fork    │◀───────────────────▶│ fluent host        │
└────────────────────────────┘   responses / state │ reads + appends L2 │
                                                   └──────────┬──────────┘
                                                              │
                                                              ▼
                                                   ┌────────────────────┐
                                                   │ Durable Streams    │
                                                   │ session log        │
                                                   │ L2 coordination   │
                                                   └────────────────────┘

Harness observation:
┌────────────────────────────┐   drive/resume      ┌─────────────────────┐
│ packages/fluent-runtime    │────────────────────▶│ adapter / bridge    │
│ fluent host                │                     │ coding-agents shape │
└────────────────────────────┘                     └─────────┬───────────┘
                                                             │ native protocol
                                                             ▼
                                                   ┌────────────────────┐
                                                   │ external harness   │
                                                   │ Claude/Codex/ACP   │
                                                   │ owns model loop    │
                                                   └─────────┬──────────┘
                                                             │ native events
                                                             ▼
                                                   ┌────────────────────┐
                                                   │ adapter / bridge   │
                                                   │ appends L1         │
                                                   └─────────┬──────────┘
                                                             │
                                                             ▼
                                                   ┌────────────────────┐
                                                   │ Durable Streams    │
                                                   │ session log        │
                                                   │ L1 harness events │
                                                   └────────────────────┘

Read models:
┌────────────────────────────┐        read         ┌─────────────────────┐
│ Durable Streams session log│────────────────────▶│ projections / UI    │
│ L1 + L2                    │                     │ firelab acceptance  │
└────────────────────────────┘                     └─────────────────────┘
```

The repeated Durable Streams boxes are the same session log, split by lane to
avoid crossing arrows. The arrows into Durable Streams are owned integration
boundaries. The raw agent harness speaks only its native protocol; the
adapter/bridge records Layer 1 events. `packages/fluent-runtime` records and
consumes Layer 2 coordination events.

## Substrate Layer Architecture

Durable Streams PR #346 introduces the substrate split this architecture should
lean on:
`https://github.com/durable-streams/durable-streams/pull/346`.
To avoid ambiguity with Firegrid's session-event layers, this document names the
substrate layers `DS-L0`, `DS-L1`, and `DS-L2`.

```text
┌──────────────────────────────────────────────────────────────────┐
│ DS-L2/A: Webhook wake          │ DS-L2/B: Pull-wake              │
│ server-initiated callback      │ wake stream + worker claim      │
│ retry, callback, done          │ shared worker fleet             │
├────────────────────────────────┴─────────────────────────────────┤
│ DS-L1: Named Consumer                                             │
│ stable consumer id, stream set, acknowledged offsets,             │
│ epoch fencing, bearer token, lease, ack, release                  │
├──────────────────────────────────────────────────────────────────┤
│ DS-L0: Durable Streams core                                       │
│ append, read, offsets, close, fork, producer fencing              │
└──────────────────────────────────────────────────────────────────┘
```

Firegrid maps onto that substrate as follows.

| Durable Streams layer | Fluent use | Firegrid-owned behavior |
|---|---|---|
| `DS-L0` core stream | Session log and source logs | Event schemas, session semantics, wait predicate meaning |
| `DS-L1` named consumer | One or more stable consumers per active session or worker role | What a claimed wake does after the consumer is acquired |
| `DS-L2/A` webhook wake | Serverless wake delivery to a fluent host endpoint | Verification, event ingestion, wait matching, redrive, ack timing |
| `DS-L2/B` pull-wake | Worker fleet consuming a wake stream and racing to acquire | Worker process implementation and host invocation |

The important split is: Durable Streams owns consumer cursors, epoch fencing,
leases, heartbeat/ack/release, retry, and wake delivery. `packages/fluent-runtime`
owns the product action after a wake is claimed: materialize the session stream,
match waits, redrive the harness, append Layer 2 facts, then ack only after the
durable outcome is recorded.

### What PR #346 Solves For Fluent

The layered consumer model removes several pieces of machinery fluent should not
rebuild:

- **No bespoke worker lease table.** `DS-L1` epoch acquisition and stale-epoch
  rejection fence concurrent redrivers.
- **No separate cursor store.** `DS-L1` acknowledged offsets are the durable
  "processed through here" cursor for session/source streams.
- **No hand-rolled webhook retry loop.** `DS-L2/A` handles wake delivery,
  callback, retry, and done/idling.
- **No custom pull queue.** `DS-L2/B` is a wake stream plus race-to-claim through
  `DS-L1`.
- **No lost-wakeup gap for subscribed streams.** A session or worker consumer can
  track a set of streams and wake when any has pending work.

The remaining Firegrid work is smaller and more specific: define the session
event schemas, bind CEL `wait_for` predicates to state-change facts, implement
the host's claimed-wake handler, and prove real harness resume without duplicate
side effects.

This mapping is conditional on Durable Streams shipping and us adopting the
`DS-L1`/`DS-L2` surface with conformance coverage. Until that is true,
fluent-runtime must not build bypass infrastructure that competes with the
substrate: no local lease table, cursor store, pull queue, webhook retry loop, or
task-claim lock. The correct interim state is "blocked on substrate adoption,"
not "rebuild the substrate inside fluent-runtime."

## RFC Delivery Shape

The original Fireline promise is choreography across many agent implementations:
the model chooses the schedule at runtime, and durability comes from the small
tool set every harness can call. Fluent delivers that by keeping harness
differences below the adapter boundary.

```text
Claude ACP      Codex ACP      cloud agent      stdio/HTTP agent
    │              │              │                  │
    ▼              ▼              ▼                  ▼
adapter A      adapter B      adapter C          adapter D
    │              │              │                  │
    └──────────────┴──────────────┴──────────────────┘
                           │
                           ▼
                Firegrid choreography tools
          wait_for · sleep · spawn · spawn_all · schedule_me · execute
                           │
                           ▼
                 same Durable Streams session model
              L1 harness facts + L2 coordination facts
                           │
                           ▼
             projections for humans, agents, firelab, audit
```

The schedule is not a DAG in Firegrid. One agent can `spawn` a child agent of a
different harness type, `wait_for` a webhook or peer result, call `execute`, then
schedule itself, all by appending and observing durable facts. That is the RFC's
"append durable facts, read durable facts, derive everything else" rule made
concrete.

Target-state round trip:

```text
client prompt
  -> fluent-runtime appends input fact
  -> Claude ACP harness receives prompt through adapter
  -> Claude calls wait_for("github.pr.merged && repo == self.repo")
  -> fluent-runtime appends L2 wait intent and parks the turn
  -> GitHub webhook arrives through external ingress
  -> fluent-runtime appends state-change fact, records wait_matched, redrives
  -> Claude calls spawn("codex", "verify the merge")
  -> fluent-runtime forks/creates child session and starts Codex adapter
  -> Codex calls execute("sandbox", "pnpm test")
  -> fluent-runtime records committed result and child terminal fact
  -> projections expose prompt, wait, webhook, child, test result, terminal state
```

No authored DAG coordinates that sequence. The model chose the calls; Firegrid
made each call durable, observable, and recoverable through stream facts.
This is the architecture's north-star acceptance story, not the first milestone.
It requires a composite proof before it can be treated as a shipped capability:
parent harness A spawns child harness B, the child reaches terminal state, the
parent is woken by the child terminal fact, and both harnesses survive kill/resume
without duplicated Layer 1 side effects.

## Component Ownership

| Component | Owns | Does not own |
|---|---|---|
| `packages/fluent-firegrid` | Composable authoring API: `Operation`, `Future`, `gen`, `run`, `sleep`, combinators, descriptors, typed clients | Processes, HTTP servers, MCP servers, Durable Streams workers, agent loop ownership |
| `packages/fluent-runtime` | Fluent host: store, ingress, sources, workers, future HTTP/MCP surfaces, wake/redrive semantics, Durable Streams reads/writes | The agent's model loop, UI read-model schema, raw ACP protocol details |
| `coding-agents` bridge/adapter | Spawning the ACP/native agent process, bidirectional protocol forwarding, raw/normalized harness event capture, native resume artifact reconstruction | Firegrid coordination semantics such as wait matching, timer firing, child lifecycle ownership |
| External harness | The model loop and native protocol behavior | Direct Durable Streams writes, durable coordination, redrive decisions |
| Durable Streams | Append-only log, stream closure, fork, producer fencing, subscriptions/wake delivery substrate | Product semantics, schema projection decisions, wait predicate meaning |
| Client/control plane | Authorized user intent, prompt, approval, cancel, send, fork/tag/schedule requests | Bypassing fluent-runtime coordination or directly mutating coordination state |
| Firelab / acceptance | Product-observable verification over streams and projections | Production implementation behavior |

## Durable Stream Layers

Each session stream carries two logical layers.

These are Firegrid session-event layers, not the Durable Streams substrate
layers described above. When discussing substrate behavior, use `DS-L0` /
`DS-L1` / `DS-L2`; when discussing facts inside a session stream, use Layer 1
and Layer 2.

**Layer 1: harness observation.** These are facts observed from the external
agent harness: assistant text, reasoning, tool calls, tool results, permission
requests, file changes, and turn completion. The adapter/normalizer owns the
translation from native protocol to normalized event shape.

**Layer 2: Firegrid coordination.** These are facts Firegrid owns: wait intents,
wait matches, timers, child session lifecycle, committed tool results, approvals,
terminal turn records, and other wake/redrive facts.

Some user-visible concepts appear in both layers with different meanings. For
example, a permission request in Layer 1 is what the harness asked for; an
approval wait/match in Layer 2 is what Firegrid durably waited on and resolved.

The L1-to-L2 lift is the legitimate reconciliation seam. For example, a harness
emits a Firegrid tool call in Layer 1; the fluent host validates and commits its
durable result in Layer 2; the adapter feeds that result back to the harness.
The one-log design removes cross-store reconciliation, not this intra-log lift.

## Read/Write Boundaries

| Actor | Writes to Durable Streams | Reads from Durable Streams |
|---|---|---|
| Raw agent process | Nothing directly | Nothing directly |
| Adapter / bridge | Layer 1 raw or normalized harness events; bridge lifecycle records | Existing history for native resume |
| Client / control plane | User intents, prompt/cancel/approval responses, addressed sends | Projections and current session state |
| Fluent host | Layer 2 coordination events, durable tool results, terminal records | Session/turn state before wake handling and redrive |
| Event ingress | Fenced external state-change facts | Pending waits through fluent-runtime sources |
| Timer/child workers | Timer-fired, child-complete, wake-result records | Pending scheduled timers, child status, wake claims |
| Projection/UI | Nothing authoritative | Layer 1 and Layer 2 logs projected into read models |
| Firelab | Usually nothing authoritative except scenario setup | Product-observable stream facts and projections |

## Harness Adapter Contract

An adapter lets a harness participate without making Firegrid own that harness's
model loop. Each adapter must:

1. drive or resume the harness in its native protocol;
2. observe native events and append faithful Layer 1 records;
3. translate Firegrid durable tool calls into host-owned Layer 2 coordination;
4. feed host-committed results back to the harness;
5. reconstruct native resume state, or provide replay suppression for every
   already-observed Layer 1 side effect;
6. preserve native permission, approval, cancel, and interrupt semantics.

The fifth item is the safety condition that lets choreography scale across
Claude ACP, Codex, cloud agents, stdio agents, HTTP agents, and future harnesses.
Adapter differences are allowed; duplicate side effects on resume are not.

### Harness Observation Contract

The adapter/bridge is the only component that translates harness-native protocol
traffic into Layer 1. It must not behave like the old runtime `sources` layer,
where observation, delivery, projection, and coordination could blur together.

Required interaction:

```text
external harness
  emits native protocol event
      │
      ▼
adapter / bridge
  classify event: text, reasoning, tool_call, tool_result,
  permission_request, file_change, turn_complete, status
      │
      ├─ append faithful L1 event to the session stream
      │
      └─ if event is a Firegrid tool call:
           call fluent-runtime tool binding
           wait for host result or park signal
           send native tool response back to harness
```

Layer 1 is observation, not authority. The adapter may normalize and materialize
for query, but it does not decide wait matches, timer fires, child completion, or
durable tool results. Those are Layer 2 decisions owned by `fluent-runtime`.

For resume, the adapter uses the L1 stream to reconstruct the native artifact or
to suppress replay of already-observed side effects. A renderer or materializer
may change without rewriting history; the raw/normalized L1 facts remain the
evidence.

## MCP Host And Tool Binding

The MCP host is a tool edge, not the runtime core. It exposes Firegrid's
choreography and session-plane tools to harnesses that can call MCP tools.
Handlers are thin bindings into `packages/fluent-runtime`; they do not own
durable state themselves.

```text
harness tool call
  wait_for / sleep / spawn / spawn_all / schedule_me / execute
      │
      ▼
adapter observes native tool_call and appends L1
      │
      ▼
Firegrid MCP host
  schema + auth + tool dispatch only
      │
      ▼
fluent-runtime tool service
  append L2 intent/result/terminal facts on session stream
  park or return host-committed result
      │
      ▼
adapter sends native tool_result back to harness
```

Two tool families share the edge:

- **Choreography tools** change durable coordination: `wait_for`, `sleep`,
  `spawn`, `spawn_all`, `schedule_me`, and `execute`.
- **Session-plane tools** query or address durable session state: observe/read
  projections, append input, send to another entity, tag, fork, and schedule.

Both families are backed by the same session-stream rules. The MCP host may be
built with Effect's `Tool`, `Toolkit`, and `McpServer` shapes, but those are edge
composition helpers. The durable semantics live in fluent-runtime services and
Durable Streams facts.

## Schema Ownership

| Schema family | Owner | Notes |
|---|---|---|
| ACP/raw harness envelopes | `coding-agents` bridge/adapter | Protocol fidelity boundary. |
| `NormalizedEvent` taxonomy | adapter/projection layer, currently `coding-agents` | Shared read-model input for harness events. |
| Agent DB rows: messages, turns, tool calls, permission requests, participants | projection/read-model layer, currently `coding-agents/src/agent-db-schema.ts` | UI/query schema over Layer 1. Not fluent-runtime coordination state. |
| Firegrid coordination rows: waits, timers, child lifecycle, committed tool results, terminal records | `packages/fluent-runtime` | Layer 2 durable coordination facts. |
| Authoring types: `Operation`, `Future`, descriptors, typed clients | `packages/fluent-firegrid` | Library surface; no process or worker ownership. |
| Durable Streams protocol: append/read/close/fork/subscription/fencing | Durable Streams packages | Substrate, not product semantics. |

## External Producers

An external producer is any actor outside the parked harness turn that appends a
candidate wake fact. Examples include webhook ingress, approval UIs, tool
callbacks, timer workers, child-session workers, or peer sessions.

External producers do not decide the session outcome. They append fenced facts.
The fluent host evaluates waits, records matches, and redrives the session.

Producer fencing and wake-claim fencing are separate. External producers append
under Durable Streams producer fencing so retries are idempotent. The fluent
host's Layer 2 writes for a wake, such as wait matches and redrive outcomes, are
serialized by the wake claim/generation fence so there is one active
decision-writer per session wake. Redrive serves the recorded match; it does not
re-evaluate a moving world after the fact.

Durable waits, timers, and external promise-like resolutions are session-stream
facts. Implementing them over a second journal, such as `DurableDeferred` or a
workflow table beside the stream, reintroduces the impedance this architecture is
removing. The primitive shape is: record intent on the session stream before
parking, receive wake via the Durable Streams subscription/claim mechanism, append
the match/resolution to the same stream, then redrive from that recorded fact.

## External Ingress And Webhooks

Webhook ingress is a specialized external producer. The legacy
`packages/runtime/src/verified-webhook-ingest` path verifies a product-owned HTTP
request and writes a `VerifiedWebhookFactTable` row. In fluent, the equivalent
verified fact is a session-stream state-change event; no side DurableTable is the
authoritative store.

```text
product HTTP route / Worker / webhook subscription callback
  owns route, raw body capture, auth token, provider secret, response policy
      │
      ▼
source verifier
  verify signature, decode payload, derive delivery id and event key
      │
      ▼
fluent-runtime EventIngress
  append fenced State Protocol change message to the session stream
  producer id = source + delivery id
      │
      ├─ duplicate delivery -> Durable Streams producer dedup; no redrive
      │
      └─ new fact -> match pending wait_for predicates
                    append L2 wait_matched fact
                    wake/redrive session under claim fencing
```

The event is queryable because it is now a durable stream fact. Read models fold
the session stream into provider-specific or generic collections; they do not own
the webhook truth. `wait_for` predicates evaluate against the State Protocol
change message shape (`event` plus the waiting session's `self` correlation
data), so the same fact that wakes the session is the fact humans and agents can
query.

`self` is not a live mutable projection read at match time. It is the session's
recorded correlation context for that wait: either embedded in the `WaitIntent`
or referenced by an immutable stream offset captured before park. When a match is
recorded, the Layer 2 match fact records the predicate, the matched event, and
the `self` snapshot or immutable reference used for evaluation. Replay serves
that recorded match; it does not rebuild `self` from a newer projection.

Durable Streams subscription delivery supplies the transport mechanisms:
webhook delivery/callback can deliver a wake to an HTTP endpoint, and pull-wake
claim/ack/release with generation fencing/leases can drive worker redrive. The
Firegrid-specific mechanism above is what the callback or claimed worker does
with that delivery: verify if needed, append the session fact, match waits,
redrive, then ack only after the durable result is recorded.

Two webhook meanings must stay separate:

- **Provider webhook**: GitHub, Stripe, Linear, or another outside product calls
  a Firegrid-owned/product-owned HTTP route. Firegrid verifies it and appends a
  state-change fact.
- **Durable Streams webhook wake**: the Durable Streams server notifies a fluent
  host endpoint that a named consumer has pending work. The host then reads the
  stream and acks/dones through the substrate callback.

They can compose in one request path, but they are not the same protocol event.

## Runtime Wake Loop

The production wake path is:

1. A durable wake source arrives: input append, state change, timer, child result,
   approval, or webhook.
2. The fluent host claims or receives the wake through the Durable Streams
   substrate.
3. `handleSession(wake)` materializes the session stream.
4. The host reconstructs the resume/native artifact through the adapter.
5. The host drives the external harness, not `agent.run`.
6. If the harness calls a Firegrid durable tool, the host records Layer 2 intent.
7. If the tool parks, the host ends the turn and waits for another wake.
8. On a matching external fact, the host records the match and redrives.

Step 4 is the highest-risk integration contract. Because the model loop is not
replayed as the durable mechanism, resume must reconstruct the harness-native
state from the stream without re-executing already-observed Layer 1 side effects.
Firegrid-mediated durable tools are the easy subset: their observed L1 tool calls
must be paired with recorded Layer 2 results and fed back rather than executed
again. Harness-native side effects, such as shell commands, file edits, tests, or
agent-owned tools that Firegrid did not mediate, need native resume or explicit
replay suppression. This must be proven with a real harness, not a fake codec.

## Safety Invariants

These invariants are the review handles for fluent implementation work.

| ID | Invariant | Why it matters |
|---|---|---|
| F-S1 | The raw agent process never writes to Durable Streams directly. | Keeps harness behavior adapter-mediated and auditable. |
| F-S2 | Every parking tool records intent on the session stream before the harness turn ends. | Prevents lost wakeups. |
| F-S3 | A claimed wake has one Layer 2 decision-writer, fenced by the substrate consumer epoch. | Prevents duplicate wait matches or double redrive. |
| F-S4 | Redrive serves the recorded match/result; it does not re-evaluate a moving world after the fact. | Makes resume deterministic. |
| F-S5 | The fluent host acks/dones a substrate wake only after the durable Layer 2 outcome is recorded. | Prevents acknowledged-but-lost progress. |
| F-S6 | Resume must not re-execute any already-observed Layer 1 side effect. | Prevents duplicate shell/file/tool effects. |
| F-S7 | External facts that can wake a wait are also queryable as stream facts. | Keeps ingress, wake, UI, audit, and Firelab on the same truth. |
| F-S8 | Durable waits, timers, and promises do not use a second authoritative journal beside the session stream. | Preserves the one-log architecture. |
| F-S9 | Cancel during a parked wait and interrupt during an active turn leave a durable terminal or continuation fact before process teardown. | Prevents corrupt sessions and duplicate effects on the next redrive. |

## Implementation Gaps To Prove

The architecture document is a contract, not proof that the contract is already
implemented. The first load-bearing proofs are:

| Gap | Required proof |
|---|---|
| DS-native durable wait | `wait_for` appends intent before park, wakes through a named consumer, records the matched fact, and redrives. |
| DS-native durable timer | A scheduled source appends or wakes through the substrate without process-local sleep. |
| Real harness resume | Killing and resuming a real Claude/Codex/ACP harness does not duplicate already-observed side effects. |
| Provider webhook ingress | A verified external delivery becomes a queryable session-stream fact and can wake a CEL predicate. |
| MCP/tool binding | Harness tool calls are observed in Layer 1, resolved by fluent-runtime as Layer 2 facts, and returned through the adapter. |
| Cancel/interrupt safety | Cancel during a parked wait and interrupt during an active harness turn do not corrupt the session, drop owed native responses, or duplicate side effects on subsequent redrive. |
| Cross-harness spawn | A parent session running harness A spawns a child session running harness B; the child terminal fact wakes the parent; both adapters resume safely after kill/restart. |

## Difference From `packages/runtime`

The fluent architecture is not a reshaped copy of `packages/runtime`. The main
difference is durable topology: which facts live on the session stream, and
which still require side machinery.

| Concern | `packages/runtime` | Fluent architecture |
|---|---|---|
| Agent loop ownership | Post-cutover runtime already trends toward a per-event adapter-forwarding shape where the harness owns the loop. | Same principle, made explicit as the package/process contract. |
| Durable topology | Runtime keeps key coordination durability in workflow tables/context/channel machinery beside the event stream. | Durable Streams session log is the single durable boundary; Layer 1 and Layer 2 are explicit stream facts. |
| Primary runtime unit | Runtime context, channel router, workflow-engine bodies, subscribers, and edge adapters. | `handleSession(wake)` over a materialized stream, plus bridge/adapter-driven harness resume. |
| Public authoring layer | Historically coupled to runtime execution and protocol projections. | `packages/fluent-firegrid` is process-free: Operation/Future engine, descriptors, and typed clients only. |
| Process/host layer | Large runtime package owns edge routing, workflows, substrate adapters, and session machinery together. | `packages/fluent-runtime` is the fluent host: store, ingress, wake/redrive, workers, and future HTTP/MCP surfaces. |
| Agent events | Runtime-specific observation/projection paths. | Adapter/bridge records Layer 1 harness events; projection/read-model schemas stay outside fluent-runtime. |
| Coordination events | Spread across runtime workflows, channels, context state, and subscribers. | Fluent host owns Layer 2 facts: waits, timers, children, committed tool results, approvals, terminal records. |
| Schema ownership | Multiple surfaces historically projected through runtime/client/protocol edges. | Schema families have explicit owners: bridge/projection for agent DB; fluent-runtime for coordination; fluent-firegrid for authoring types. |
| Extensibility | Adding surfaces tends to add runtime-specific adapters or route plumbing. | New harnesses plug in through adapter/bridge contracts; new coordination behavior lands as Layer 2 facts plus fluent host handling. |
| Verification target | Often requires understanding internal runtime workflows and traces. | Firelab/acceptance verifies product-observable stream facts and projections; traces are diagnostic. |

The replacement goal is architectural reduction: keep the composable authoring
API small, keep the host boundary explicit, and make Durable Streams facts the
reviewable runtime state. Anything that pushes model-loop ownership, UI
projection schemas, or harness protocol details back into `packages/fluent-runtime`
is drift toward the old runtime shape.

This does not mean legacy runtime knowledge is useless. `packages/runtime` is not
the durability architecture reference, but its edge-case inventory is valuable:
permission timeout behavior, adapter quirks, packaged-agent environment allow
lists, tool-use modes, streaming tool-call shape drift, and other integration
lessons should be mined and revalidated against the fluent architecture.

## Import And Dependency Rules

- `fluent-runtime` may depend on `fluent-firegrid`.
- `fluent-firegrid` must not depend on `fluent-runtime`, Durable Streams workers,
  MCP servers, HTTP servers, or process/sandbox launchers.
- Product code must not import vendored references under `repos/`.
- Projection packages may consume stream logs and normalized events, but must not
  own coordination semantics.
- Bridge packages may spawn and resume harnesses, but must not implement
  Firegrid wait/timer/child semantics.
- Legacy `packages/runtime` is not a durability design reference for fluent
  architecture. It may be read for integration edge cases that must be tested
  through the fluent bridge and host.

## Non-Goals

- Do not replay the model loop as the durable mechanism.
- Do not implement a session as a long-lived `fluent-firegrid` generator body
  parked on durable promises; use generators for coordination workflows, not the
  external agent loop.
- Do not make the raw agent process a Durable Streams writer.
- Do not collapse UI/projection schemas into fluent-runtime coordination state.
- Do not rebuild the legacy runtime with renamed packages.
- Do not use Firelab-only mocks as proof of product architecture.
