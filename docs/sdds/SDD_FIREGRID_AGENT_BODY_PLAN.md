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

This SDD reframes the agent tool surface as a **body plan**: a typed inventory of *senses* (afferent channels), *faculties* (efferent channels + the `call` paired req-resp pattern), and a small fixed verb count. Channels are opaque-to-the-agent typed handles registered by the host; substrate addressing happens entirely behind the channel boundary.

This is the same shape Fireline already implements at the substrate-neutral layer (`channel: ChannelTarget`), elevated by the channels-as-nervous-system framing in Fireline's vault, with concrete additions surfaced by tonight's dark-factory live run.

## Problem (substrate currently leaks into the agent)

Tonight's `dark-factory` live run (against a real `claude-agent-acp@0.36.1` planner, with PR #446's codec rationalization landed) made the leak concrete. From `tf-h1gm-dark-factory-honest-halt.FINDING.md`:

> *"The available Firegrid surface in this session offers `wait_for` over `CallerFact{stream: 'darkFactory.facts'}` only with a non-empty `whereFields` predicate set (empty predicates are rejected). There is no read-latest, list-stream, peek, or schema-introspection operation exposed on the runtime-context MCP toolset, and the seeded fact's schema is not declared in the task framing or recoverable from the tools available."*

The agent honestly halted (`DARK_FACTORY_FINDING` per the prompt's halt-honestly clause) — a successful introspective act, but a clear signal that the body plan was thin. Specifically:

1. **`wait_for` exposes substrate source taxonomy.** The agent sees `source._tag: "CallerFact"` and addresses by `stream` name — both are substrate storage concepts. The agent's mental model becomes "I am querying a substrate" instead of "I am sensing a channel."

2. **Channel discovery is forced into the predicate path.** Empty `whereFields` is rejected. There is no peek-without-predicate semantic. The agent therefore cannot observe a channel before knowing its schema.

3. **Schema is implicit.** A channel's row shape is known only to the host author. The agent has no body-plan-time declaration to read; tonight's agent guessed six predicate shapes (`_tag: Trigger / DarkFactoryTrigger / Seed / Start`, `kind: trigger`, `type: trigger`) and timed out on each.

4. **Permission flow is hidden as driver glue.** Tonight's run only progressed because the driver's `forkAutoApprovePermissions` handled `session.wait.forPermissionRequest`. The agent has no first-class `call(approval, ...)` verb that surfaces the request-response paired pattern; permission is a side channel the driver mediates, not a body-plan-visible faculty.

5. **No interoception.** The agent cannot perceive its own lifecycle, budget, or checkpoint state. It cannot self-modulate. (`session.self.*` is absent from the agent tool surface.)

6. **No peer-pheromone channel.** `event(name)` (named ad-hoc afferent + efferent on the durable log) is not exposed. Inter-agent indirect coordination — the choreography thesis's strongest case — requires either piggy-backing on `CallerFact` streams (substrate-leaky) or out-of-band orchestration (which the choreography model rejects).

7. **Wait-router and durable-tools record names are substrate-shaped, not body-plan-shaped.** Fireline's contract names the records `fireline.agent.suspended` and `fireline.agent.resumed`. Firegrid emits `durable_tools.wait_for.upsert_active` and `wait_router.complete_match`. Functionally analogous; semantically misaligned with the spec.

## Design Inputs

This SDD is the synthesis of three reference frames:

1. **Fireline's `choreography-and-combinators.fireline.md`** — substrate-neutral primitive set. Six canonical verbs (`sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, `execute`) with opaque `ChannelTarget` / `SandboxTarget` / `agent: String` addressing. Every primitive emits a canonical `suspended` + `resumed` record pair carrying the operation, channel, and result.

2. **Fireline's `channels-as-nervous-system.md`** — the mental model that elevates "what tools should the agent have?" into "what is the agent's body plan?" Channels are typed afferent (sensory) or efferent (motor) pathways. The agent reasons about senses and faculties, not tools. The substrate (the spinal cord) makes durable suspension possible without burning compute.

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
| `wait_for(channel: ChannelTarget, match?, timeoutMs?)` | afferent | yes | `WaitOutcome { matched, eventJson?, reason? }` |
| `wait_for_any([channelDescriptor...], timeoutMs?)` | afferent (multi) | yes | `{ winnerIndex, channel, result }` |
| `send(channel: WritableChannel, payload)` | efferent (fire-and-forget) | no | `{ ok }` (best-effort) |
| `call(channel: CallableChannel, request)` | efferent + paired afferent | yes | response payload |
| `schedule_me(when, prompt)` | efferent (time.schedule) | no (resumes via new session later) | `{ scheduledAt }` |
| `spawn(agent, prompt, opts?)` | (peer — not a channel; ACP-native) | yes | `SpawnResult` |
| `spawn_all([tasks])` | (peer multi) | yes | `SpawnResult[]` |
| `execute(sandbox, input)` | efferent (sandbox channel) | yes | `ExecuteResult` |

**Total: 9 verbs.** Strict superset of Fireline's 6 (adds `send`, `call`, `wait_for_any` as first-class verbs per the channels-as-nervous-system doc's sensory-integration and motor patterns).

- `send` vs `call`: biological-style distinction. `send` is fire-and-forget into an efferent channel (broadcast, notification, log). `call` is the paired request-response pattern (approval, gated review, ask-permission). `call` suspends durably waiting on its paired response.
- `wait_for_any` is sensory integration — the agent waits on multiple channels concurrently, acts on whichever fires first. The brain doesn't dedicate one process per modality.

**No new verbs are needed beyond these nine.** Tonight's "discovery gap" (peek / list-streams / schema-introspection) dissolves at the verb layer: it becomes a property of how channels are *declared* (schema-carrying registration) and how `wait_for` is *invoked* (`match` is optional; `timeoutMs: 0` + no match returns latest-or-none).

## Channel Inventory

The channels are the body plan's typed inventory. Each channel is registered at the host layer with: a name (opaque to the agent), a direction (afferent / efferent / call), a typed payload schema, and a substrate-side binding (which durable-table / runtime-state / awakeable mechanism backs it).

Cross-referencing the channels-as-nervous-system doc against Firegrid today:

| Channel | Direction | Biological analogue | Firegrid substrate binding (existing) | Status |
|---|---|---|---|---|
| `time.elapsed(duration)` | afferent | circadian | `Effect.sleep` / `DurableClock` | wraps `sleep`; needs naming as a channel for `wait_for_any` composition |
| `time.at(instant)` | afferent | scheduled alarm | `DurableClock` | not exposed |
| `time.schedule(prompt, when)` | efferent | "I'll wake at dawn" | `schedule_me` substrate | exists as verb-bound; rename to channel-bound |
| `state.changes(collection)` | afferent | proprioception | `DurableTable.rows()` | substantive add — wrap rows-stream as channel; schema-carrying via collection type |
| `state.control` | afferent | vestibular reorientation | snapshot / reset substrate | substantive add |
| `session.self.lifecycle` | afferent | interoception | `firegrid.runtime_context.workflow.*` spans | **substantive add — high leverage** |
| `session.self.checkpoint` | afferent | interoception | workflow checkpoint substrate | substantive add |
| `webhook.intent(name)` | afferent | hearing | (no current binding; closest: `CallerFact` streams) | substantive add or rename of `CallerFact` |
| `event(name)` | afferent + efferent | pheromone | `CallerFact` streams reshaped | substantive add — high leverage for choreography |
| `dm(handle)` (human channel) | afferent | conversation | (no binding) | substantive add — human-loop sense |
| `notification(handle)` (human channel) | efferent | speech | (no binding) | substantive add — human-loop faculty |
| `approval(handle)` (human channel) | call (req+resp) | asking permission | `PermissionRequest`/`PermissionResponse` substrate | exists as substrate; not channel-shaped at agent surface |
| `sandbox.<name>` | efferent | skeletal motor | `executeSandboxTool` | exists as verb-bound (`execute`); align as channel |
| `session.log` | efferent | memory consolidation | runtime input intent / agent output rows | substantive add |

**Net of "substantive add" items:** seven new channels to introduce, three existing channels to rename/realign. The verb layer above doesn't change shape — each new channel is consumable by existing `wait_for` / `send` / `call`.

### Channel direction is type-enforced

The doc's typed-verb constraint must be carried into Firegrid's type system. The proposed types:

```ts
type ChannelDirection = "afferent" | "efferent" | "call"

interface AfferentChannel<Schema> {
  readonly direction: "afferent"
  readonly id: string                 // opaque to agent; host-registered
  readonly schema: SchemaTag<Schema>  // declared at body-plan time
}

interface EfferentChannel<Schema> {
  readonly direction: "efferent"
  readonly id: string
  readonly schema: SchemaTag<Schema>  // payload type the agent emits
}

interface CallableChannel<Req, Resp> {
  readonly direction: "call"
  readonly id: string
  readonly requestSchema: SchemaTag<Req>
  readonly responseSchema: SchemaTag<Resp>
}

type ChannelTarget =
  | AfferentChannel<any>
  | EfferentChannel<any>
  | CallableChannel<any, any>

// The verb signatures enforce direction:
declare function wait_for<Schema>(
  channel: AfferentChannel<Schema>,
  options?: { match?: Partial<Schema>; timeoutMs?: number },
): Effect<WaitOutcome<Schema>>

declare function send<Schema>(
  channel: EfferentChannel<Schema>,
  payload: Schema,
): Effect<{ ok: true }>

declare function call<Req, Resp>(
  channel: CallableChannel<Req, Resp>,
  request: Req,
): Effect<Resp>
```

The compile-time enforcement means `send(state.changes(...), ...)` is rejected at the type level (state writes go through the dedicated `memory()` middleware path per the doc); `wait_for(notification, ...)` is rejected (notifications are efferent-only); `call(time.elapsed, ...)` is rejected (time isn't callable).

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
  CallerFact streams ─→ event(name) afferent+efferent channel
```

The agent never sees the bottom layer. The substrate is **how channels stay durable**, not what the agent reasons about.

## Migration Plan

The migration is staged so each slice is independently shippable and falsifiable.

### Slice A — Substrate refactor: opaque `ChannelTarget` for `wait_for`

**What changes:** `wait_for`'s tool input becomes `{channel: ChannelTarget, match?, timeoutMs?}` where `ChannelTarget` is an opaque token string. The host runtime maintains a **channel registry** mapping registered names → substrate sources (current `source: {_tag: "CallerFact", stream}` becomes a registry entry, not an agent-visible arg shape).

**Affected files:**

- `packages/runtime/src/durable-tools/internal/types.ts` — `WaitForToolInput` schema rewrite (replace `source: SourceSchema` with `channel: ChannelTargetSchema`).
- `packages/runtime/src/durable-tools/internal/wait-for.ts` — translate `ChannelTarget` → substrate source at handler entry; rest of the file is unchanged.
- `packages/host-sdk/src/host/channel-registry.ts` (NEW) — host-side registry of `name → AfferentChannel | EfferentChannel | CallableChannel`. Channels registered at host startup; the registry is what `resolveEffectiveMcpServers`-style logic consults.
- `packages/host-sdk/src/host/agent-tools/bindings/tools.ts` — toolkit binding for `wait_for` updated to publish typed channel options based on registered inventory.
- `packages/runtime/test/durable-tools/...` — update test fixtures.

**Backwards compatibility:** the current `source: {_tag: "CallerFact", stream}` shape is internal only after this slice; agents never see it again. No external API is broken — only the agent-tool input shape changes, which Firegrid owns.

**Acceptance:** existing dark-factory and other sims pass after channel-registry migration; the agent's tool input schema (visible via MCP tools/list) shows `channel: string` and no longer shows `source._tag` discriminants.

### Slice B — Optional `match` + `timeoutMs: 0` discovery semantics

**What changes:** lift the empty-predicate rejection on `wait_for`. With `match: undefined` and `timeoutMs: 0`, the call returns the latest matching row on the channel (or `{matched: false, reason: "timeout"}` if the channel has no history). With `match: undefined` and a non-zero `timeoutMs`, the call returns the *next* row (snapshot OR live) on the channel.

**Affected files:**

- `packages/runtime/src/durable-tools/internal/wait-for.ts` — remove empty-predicate guard; document semantic.
- `packages/runtime/src/durable-tools/internal/wait-router.ts` — confirm `includeInitialState: true` already covers snapshot-first semantics (it does, per `wait-router.ts:6-8`); annotate accordingly.

**Acceptance:** in dark-factory, `wait_for(channel: "factory.events")` with no match and `timeoutMs: 0` returns the seeded trigger fact's row (because the channel has history) — closing the discovery gap tonight's agent surfaced without any new verb.

### Slice C — Channel inventory expansion (per-channel beads)

Each of the substantive channel types from the table above is its own slice. Suggested order by leverage:

1. **`session.self.lifecycle` / `session.self.checkpoint`** (interoception) — highest unique-to-choreography value. Substrate exists; agent-facing channel wrapper is the new piece.
2. **`event(name)`** (peer pheromone) — the choreography thesis's strongest case. Reshape `CallerFact` into a typed event channel with explicit `name` + schema registration; both afferent and efferent.
3. **`state.changes(collection)`** (proprioception) — wrap `DurableTable.rows()` as a typed channel; schema is the collection's row schema. Solves the discovery problem structurally — channel declaration carries its own type.
4. **`approval(handle)`** (call channel) — replaces the ad-hoc permission flow tonight's driver auto-approver covers. The host registers an `approval(...)` channel; ACP `session/request_permission` is routed through it; the agent sees `call(approval, {prompt, options})` as a verb-bound faculty.
5. **`dm` / `notification`** (human conversation) — the human-channel pair. Probably built first as a generic `{afferent dm + efferent notification + call approval}` triad parameterized by handle.
6. **`session.log`** (own marker / memory consolidation) — cheapest add; lets the agent annotate its own history.
7. **`webhook.intent(name)`** — rename or augment the existing `CallerFact` semantic for the external-HTTP-event case.

Each slice is its own bead, ~one to two files per channel, plus a test fixture in `scenarios/firegrid/`.

### Slice D — `send` / `call` / `wait_for_any` verb additions

Once Slice A lands (channels are first-class typed handles), the new verbs are mechanical additions to `FiregridAgentToolkit`:

- `send` — append-fact-shaped, governed by per-channel append-allow policy on the registry. Direction-enforced at the type level (only `EfferentChannel` accepted).
- `call` — composes `send` (request) + `wait_for` (response) under a paired-channel handle. Suspends durably; resumes when the response row appears on the call channel's response side. This is what tonight's `call(approval, ...)` would have looked like if it existed.
- `wait_for_any` — accepts an array of `AfferentChannel` (or call-channel response-side) descriptors with optional per-channel `match`. Returns the first-firing channel's result + a discriminator (`{ winnerIndex, channel, result }`). Substrate: races N `wait_for`s and cancels the losers.

**Affected files:**

- `packages/host-sdk/src/agent-tools/bindings/tools.ts` — add `send`, `call`, `wait_for_any` toolkit entries.
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` — handler wiring (each composes existing substrate primitives).
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` — dispatch case adds.
- `packages/protocol/src/durable-tools/schema.ts` — `SendToolInputSchema`, `CallToolInputSchema`, `WaitForAnyToolInputSchema`.

**Acceptance:** the dark-factory sim can be re-driven with the driver's `forkAutoApprovePermissions` removed, because the agent now calls `call(approval(...), ...)` and the human-channel handler routes through the registered approval channel. Tonight's ~70 lines of driver glue dissolves into channel registration.

### Slice E — Canonical record names

Align with Fireline's `{operation}.suspended` / `{operation}.resumed` record contract. This is purely a renaming/aliasing exercise at the substrate emit layer; Firegrid's existing `durable_tools.wait_for.upsert_active` etc. either:

- (a) Get renamed to `fireline.agent.suspended` with `operation: "wait_for"` (breaking but spec-aligning), OR
- (b) Add the canonical names alongside existing names (additive; both are emitted).

Recommendation: (b) initially for migration safety; (a) once consumers are migrated. Both options are mechanical seam-level edits in `wait-router.ts` + `wait-for.ts`.

## What this is NOT

- **Not a substrate redesign.** Every machinery primitive Firegrid has today (durable tables, awakeables, workflow checkpoints, claim-first execution, projection observation) stays as-is. Only the *agent-facing* presentation layer changes.
- **Not a tool-count expansion in the sense of "more product tools."** Forge has many product-shaped tools (`bash`, `memory.{...}`, `update_plan`, etc.) — Firegrid's tools at the substrate layer remain the 9 listed above. Product-shape tools (memory, finish, update_plan, bash) are for **consumers** of Firegrid to layer on top, not for Firegrid core to ship.
- **Not a breaking change to host-sdk consumers.** The channel registry is additive; existing `runtime.config.mcpServers` style declarations get migrated to channel-registry entries by a one-to-one mapping. Consumer apps continue to declare what tools/channels are available to the agent the same way they do today (via host construction), with a shape change.
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

1. **Channel registration is a host-startup concern.** Today's tiny-firegrid host (e.g., `dark-factory/host.ts`) declares MCP server URLs and seeds facts. Should channel registration sit alongside that, or move into a separate host composition step? Recommend: it goes alongside, since channel inventory IS the body plan.
2. **How does `event(name)` schema get declared?** A typed channel needs a schema. Either: (a) channels are registered with an explicit Effect Schema; (b) channels are registered with a JSON Schema; (c) typed via the `DurableTable` row type when backed by a collection. Recommend (c) where possible, (a) for hand-declared events.
3. **`spawn` is "synaptic, not channel" per the doc.** Should `spawn` remain a verb that doesn't go through the channel layer, or should there be a `peer(name)` channel? Recommend: stays as a verb (matching the doc), but a `peer.lifecycle(child_id)` *afferent* channel exists so the parent can `wait_for_any([peer.lifecycle(c1), peer.lifecycle(c2)])` for fastest-child semantics.
4. **Permission-channel routing**: today the ACP permission gate triggers a runtime workflow that awaits a `PermissionResponse` row. After the migration, that wiring is "the substrate side of the `approval` channel." Confirm this aligns with `SDD_PERMISSION_CODEC_AUTHORITY.md`'s invariants.
5. **Wire format for `match` and `eventJson`**: Fireline's TS schema encodes match/event as string-encoded JSON (`matchJson`, `eventJson`); the Rust side carries parsed `Value`. Firegrid is TS-only currently — should we adopt the string-encoded form for spec parity, or use typed JSON Schema values directly? Recommend typed values internally with string-encoded only at the ACP wire boundary.
6. **Migration of existing `CallerFact` consumers**: dark-factory, the wait-pre-attach-roundtrip sim, and any in-flight consumers all need their channel declarations migrated. Is a single batch migration acceptable, or do we want a deprecation period?

## Cross-references

- `SDD_CHOREOGRAPHY_FACADE.md` — overlapping scope; this SDD extends the choreography facade into the explicit body-plan / channels-as-nervous-system framing.
- `SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md` — the prior typed-wait-source work; this SDD subsumes it by replacing typed source taxonomy with the channel registry.
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
