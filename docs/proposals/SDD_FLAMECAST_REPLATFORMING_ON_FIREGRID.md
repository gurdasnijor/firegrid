# SDD: Flamecast Replatforming on Firegrid

Date: 2026-05-06

Status: Proposal, docs-only

Scope: Replatforming plan for moving Flamecast durable agent-runtime concerns
onto Firegrid as the durable operation, event, query, wait, subscriber, and
runtime substrate.

Non-scope: Implementing Flamecast provider/product semantics inside Firegrid
packages.

## Contents

1. Context and Principle
2. Ownership Boundary
3. Platform Capability Lanes
4. Execution Plan
5. Litmus Tests and Smokes
6. Decision Log
7. Guardrails and Review Criteria
8. Appendix: Source Evidence

## Part 1: Context and Principle

The Flamecast PRD targets a provider gateway for stateful agent sessions.
Flamecast already has much of the product shape, but durable mechanics are
spread across Postgres, R2, Durable Objects, adapter-local state, ClickHouse,
local tracing helpers, and ad hoc callback/event APIs.

Firegrid can become valuable by replacing those bespoke durable mechanics with
product-neutral platform primitives:

- typed durable operations;
- app-owned EventStreams and EventPlanes;
- durable waits and wakeups;
- queryable projections and controlled StreamDB-style read models;
- runtime composition and subscriber execution;
- trace context propagation through durable records and Effect spans;
- durable identity, runtime presence, and ownership handoff;
- execution-plane resource and secret-reference handoff patterns;
- durable scheduling and claimed-intent mechanics that agent runtimes can
  expose through their own tool/adaptor layers.

Principle:

```txt
Flamecast owns what a session/provider/capability/prompt means.
Firegrid owns how durable facts, waits, projections, claims, subscribers,
runtime execution, and replay/recovery are recorded, observed, and moved.
```

Source evidence is summarized here and enumerated in the appendix:

- Flamecast currently stores product state across Postgres, R2, Durable
  Objects, ClickHouse, runtime adapters, and bespoke web/API code.
- The Flamecast PRD defines product contracts: Sessions, Provider API,
  AgentSpec, capabilities, callbacks, provider checks, and SDK ergonomics.
- Firegrid public surfaces already cover operation lifecycle, runtime
  composition, EventStream descriptors, EventPlane descriptors, RunWait, and
  projection-match subscribers.
- Fireline and the external RFC provide reusable substrate lessons around
  runtime identity, local-to-cloud handoff, scheduling tools, durable webhooks,
  prompt intent rows, claims, replay, and conformance.

### Acai Artifact Model

This document is rationale and planning material. The authority for
implementation is Acai feature YAML under `features/<product>`.

The replatforming work should not create a second ID system for lane
requirements, invariants, or guardrails. Use ACIDs:

```txt
<feature-name>.<COMPONENT_OR_CONSTRAINT>.<requirement-id>
```

Examples:

```txt
firegrid-projection-query.QUERY_HANDLES.1
firegrid-runtime-presence.DESCRIPTOR.4
firegrid-platform-invariants.BOUNDARY.3
flamecast-product-contract.PROVIDER_MANIFEST.1
```

Prose docs should cite ACIDs rather than restating requirements. That keeps the
source of truth in feature specs while leaving this SDD to explain why the
work exists and how the pieces compose.

Recommended local artifact layout:

```text
docs/replatforming/
  README.md
  SDD.md
  OWNERSHIP.md
  DECISIONS.md
  RISKS.md
  GUARDRAILS.md
  litmus/
    LT-01-local-to-remote-shift.md
    harness.md

features/firegrid/
  firegrid-platform-invariants.feature.yaml
  firegrid-agent-runtime-substrate.feature.yaml
  firegrid-projection-query.feature.yaml
  firegrid-client-projection-api.feature.yaml
  firegrid-observability.feature.yaml
  firegrid-durable-identity.feature.yaml
  firegrid-execution-plane-resources.feature.yaml
  firegrid-durable-subscriber-webhooks.feature.yaml
  firegrid-runtime-presence.feature.yaml
  firegrid-runtime-ownership-transfer.feature.yaml
  firegrid-scheduling-tool-bindings.feature.yaml
  firegrid-claimed-intent-transport.feature.yaml

features/flamecast/
  flamecast-product-contract.feature.yaml
```

The current proposal files can stay in `docs/proposals/` while drafts are
active. Before implementation starts, move durable build guidance into the
artifact shape above or create equivalent Acai specs in place.

### Shared Platform Invariants

Create `features/firegrid/firegrid-platform-invariants.feature.yaml` before the
lane specs. It should hold cross-cutting constraints that currently live in
the RFC boundary sweep and guardrails:

- Firegrid owns durable mechanics, not product semantics.
- Browser/client surfaces do not import runtime, kernel, raw StreamDB
  collections, or Durable Streams State envelopes.
- Runtime locality remains split: `@firegrid/client` is browser/edge-safe and
  `@firegrid/runtime` is Node-tier.
- Trace metadata, presence metadata, and app metadata are not authorization.
- Runtime presence is observation/discovery, not a command bus or credential
  directory.
- Product credential, provider, capability, callback, and sandbox policy stays
  downstream.
- No Fireline/Firepixel/Flamecast vocabulary becomes Firegrid-native row
  families.

Each lane spec should then include a short `constraints.INVARIANTS` group that
cites the relevant invariant ACIDs rather than duplicating the full text.

Illustrative lane-spec shape:

```yaml
feature:
  name: firegrid-runtime-presence
  product: firegrid
  description: Durable runtime presence records for hosts in a Firegrid topology.

components:
  DESCRIPTOR:
    requirements:
      1: A presence record includes runtime id, host id, and node id.
      2: A presence record includes topology identity.
      3: A presence record includes advertised public ingress endpoints.

constraints:
  INVARIANTS:
    requirements:
      1: This feature upholds firegrid-platform-invariants.BOUNDARY.3.
      2: This feature upholds firegrid-platform-invariants.LOCALITY.2.
```

The real spec should use complete requirement text and stable numbering. The
example only shows how this SDD should map to Acai format.

## Part 2: Ownership Boundary

### Launch Contract

This is the canonical lowering table. Feature specs and implementation PRs
should reference this table instead of restating product/substrate ownership.
When a feature spec exists, replace prose references with ACID citations.

| Flamecast concept | Firegrid platform primitive |
| --- | --- |
| `SessionCreate` | Flamecast-owned `Operation.define` input schema. |
| Session lifecycle | Firegrid operation state and typed result/error. |
| Normalized events | Flamecast-owned `EventStream.define`. |
| Provider callback event | Flamecast-owned EventPlane row plus durable subscriber or producer. |
| Capability request/result | Flamecast-owned EventPlane rows plus `RunWait`/projection-match. |
| Permission required/resolved | Flamecast-owned EventPlane rows plus public Pending gate. |
| Provider compatibility failure | Typed operation error before runtime side effects. |
| Provider adapter execution | Flamecast runtime handler composed through `Firegrid.composeRuntime`. |
| Provider resources/secrets | Opaque resource/secret references and product-owned runtime layers. |
| Webhook callback delivery | Durable subscriber channel with product-owned signing/payload. |
| Runtime ingress endpoint | Firegrid runtime presence descriptor with product-owned routing policy. |
| Agent host shift | Firegrid ownership transfer, replay, materialization, and runtime presence; Flamecast provider reattach profile. |
| Durable scheduling tool | Firegrid neutral scheduling binding plus Flamecast-owned provider/tool adapter. |
| Prompt dispatch / agent-to-agent prompt | Flamecast-owned prompt intent rows plus Firegrid claimed-intent, projection, runtime presence, and terminalization mechanics. |

### Ownership Matrix

| Concern | Current Flamecast state | Firegrid owns | Flamecast owns | Lanes |
| --- | --- | --- | --- | --- |
| Persistence | Postgres agents/sessions, R2 resources, ClickHouse events, DO state. | Durable operations, app-owned rows, projection/query mechanics, identity/index helpers. | Org policy, naming, archive/delete, resource backend choice. | L2, L4, L5 |
| Observability | Product-local OpenTelemetry wrappers in `trace.ts`. | Effect tracing integration for operations, handlers, EventPlane/EventStream, waits, subscribers, terminalization. | Business span names, redaction, vendor trace correlation, export policy. | L1 |
| Discovery | Agent bundles in R2 and metadata in Postgres. | Durable identity projections for operation/run/runtime/resource facts. | Agent bundle schema, org visibility, templates, provider registry. | L4, L7 |
| Session query/transcript | WebSocket events, ClickHouse, snapshot JSONL transcript extraction. | EventStream replay, projection query, cursor/retention-gap behavior. | Normalized event union, transcript shape, route names, pagination. | L2, L3 |
| Client/web ergonomics | REST polling, raw live WebSocket URLs, local cursor merge loops. | Browser-safe projection/event handles, replay/reconnect, typed errors, optional thin framework adapters. | React UI, WorkOS/auth policy, product routes, provider taxonomy. | L3 |
| Execution resources/secrets | R2 sidecars for skills, MCP config, credentials, env vars, workspace files. | Resource/materialization facts, opaque secret references, materializer subscriber pattern. | Credential storage/rotation/injection, provider env rules, sandbox layout. | L5, L8 |
| Durable subscriber/webhook ingest | Ad hoc REST callback/provider-event ingest. | Selector, completion key, cursor, retry, conflict, dead-letter mechanics. | Signing, callback tokens, payload schemas, callbackEvents filtering. | L6, L7 |
| Runtime presence/ingress | Host/runtime details are implicit in product infra. | Durable runtime presence records, readiness, heartbeat, ingress endpoint descriptors. | DNS/TLS/auth, endpoint routing policy, provider callback registration. | L7 |
| Remote handoff | Local-to-remote story is target/native and product-specific. | Replay, projection rebuild, owner lease/fence/epoch, resource materialization, client continuity. | Provider reattach profiles, sandbox deployment, UX policy. | L5, L7, L8 |
| Scheduling tools | Firegrid has waits/scheduling primitives; Flamecast has provider tools. | Neutral scheduling bindings, descriptor publication, equivalent durable lowering. | Tool names/descriptions, provider/MCP/OpenAI/Anthropic conversion, policy. | L9 |
| Prompt transport | Fireline proves durable prompt intents and dispatcher claims; Flamecast uses product-specific prompt APIs. | Generic claimed-intent mechanics, idempotency, claims, first-terminal-wins, observation. | Prompt schemas, promptability, provider transport, reordering/steering, adapter errors. | L10 |
| Launch/provider contract | PRD names AgentSpec, ProviderManifest, capability checks, callbacks. | Carry typed inputs/errors and durable mechanics once product specs exist. | AgentSpec, ProviderManifest, CapabilitySpec, providerAuth/options, SDK semantics. | W-01 |

### RFC Boundary Sweep

These invariants apply across all lanes:

- Firegrid owns durable log, projection, operator mechanics, waits,
  completions, claims, subscribers, client observation, and runtime composition.
- Flamecast owns live runtime semantics for sessions, prompts, providers,
  tools, sandboxes, capabilities, callbacks, auth, UI, and product APIs.
- Firegrid standardizes product-neutral envelope mechanics only: record type,
  key/subject, value, headers, schema id, producer identity, correlation,
  causation, append cursor, and optional trace context.
- Flamecast owns row payload schemas for session, prompt, provider, tool,
  permission, capability, sandbox, transcript, and SDK shapes.
- Projection mechanics are Firegrid-owned; projection families and policy are
  product-owned.
- Adapter protocols such as ACP, stdio, HTTP, gRPC, vendor APIs, MCP-capable
  agents, and in-process agents stay downstream.
- Provider handles, filesystem roots, containers, browser workers, vendor
  sessions, and process handles are live resources, not durable truth.
- Visible tool descriptors must be frozen before session initialization unless
  a new explicit durable topology/session event changes them.
- Approval/required-action semantics stay Flamecast-owned; Firegrid supplies
  wait, timeout, first-terminal, and projection mechanics.
- Do not add a mailbox abstraction unless canonical rows plus projection waits
  prove insufficient.
- Firegrid exposes security metadata/hooks; Flamecast owns tenant membership,
  WorkOS/API-key auth, provider credentials, BYOK, OAuth, and access policy.
- Firegrid provides idempotency mechanics and conflict surfaces; Flamecast owns
  keyspaces and payload equivalence rules.
- Firegrid owns replay/live-boundary mechanics and no-side-effects-during-replay
  guarantees; Flamecast owns adapter reattach actions.
- All extensions must leave application-observable facts in durable records.

The authoritative version of these invariants should move into
`firegrid-platform-invariants.feature.yaml`. This SDD keeps the list for
planning readability only.

## Part 3: Platform Capability Lanes

Lane entries are spec briefs. Each lane must become a real Acai feature spec
before implementation. The "Required ACIDs" bullets below are seed material,
not the final acceptance criteria.

### L1: Firegrid Observability Layer

Goal: Add product-neutral tracing affordances for Firegrid data-plane
execution.

Owning feature spec: `features/firegrid/firegrid-observability.feature.yaml`

Required ACIDs:

- Effect tracing spans for operation send, runtime handler execution,
  EventPlane emit, EventStream append/materialization, RunWait suspend/resume,
  subscriber attempt, and terminalization.
- Trace context propagation through app-owned row metadata.
- Stable substrate span attributes for operation/run/descriptor/row/cursor/
  subscriber/attempt/terminal status.
- Error recording and terminal status correlation.
- No product-specific span names or provider semantics.

Dependencies: none.

Anti-scope: no Flamecast span names, provider telemetry policy, trace backend,
or secret-bearing trace metadata.

Decision refs: D-14.

### L2: Controlled Query and StreamDB Facade

Goal: Let products query app-owned EventPlane/EventStream projections without
exposing raw kernel rows or write authority.

Owning feature spec: `features/firegrid/firegrid-projection-query.feature.yaml`

Required ACIDs:

- Schema-scoped read/query handles.
- Snapshot/preload and since-cursor replay.
- Live query subscription over app-owned row families.
- Typed decode, stream-missing, malformed-cursor, and retention-gap errors.
- Transaction acknowledgement where appends are exposed.
- No raw Durable Streams State envelope or kernel import exposure.

Dependencies: none.

Anti-scope: no raw StreamDB collection mutation APIs in browser/client code.

Decision refs: D-02, D-03, D-05, D-18.

### L3: Client Projection and Web Ergonomics

Goal: Evolve `@firegrid/client` so browser apps can consume durable state
without rebuilding REST polling, WebSocket replay, cursor merge, and projection
logic in each product.

Owning feature spec:
`features/firegrid/firegrid-client-projection-api.feature.yaml`

Required ACIDs:

- Browser-safe projection handles over app-owned descriptors.
- EventStream and projection replay from explicit cursor tokens.
- Live subscription reconnect semantics and retention-gap errors.
- Transaction acknowledgement for optimistic UI.
- Product-supplied auth/header hooks without Firegrid auth policy.
- Optional framework adapters as thin wrappers over the Effect-native client.
- No runtime process configuration, raw StreamDB collections, raw envelopes,
  kernel imports, or terminal authority in browser code.

Dependencies: L2.

Anti-scope: no `@firegrid/runtime` or `@firegrid/substrate/kernel` in web apps;
no Firegrid-owned React semantics before a second real call site proves the
shape.

Decision refs: D-02, D-03, D-04, D-05, D-18.

### L4: Durable Identity and Discovery

Goal: Expose operation/run/resource identity in a way higher layers can use for
agent discovery.

Owning feature spec: `features/firegrid/firegrid-durable-identity.feature.yaml`

Required ACIDs:

- Queryable operation and run identity projections.
- Descriptor-name and app-metadata filters.
- Runtime ownership visibility.
- Active/pending/terminal state filters.
- Runtime-side discovery Layer composed through public runtime APIs.
- No product agent registry semantics in Firegrid core.

Dependencies: L2.

Anti-scope: no AgentSpec, agent templates, provider registry, org visibility,
or skill/MCP semantics in Firegrid.

Decision refs: D-17, D-18.

### L5: Execution-Plane Resource and Secret Reference Handoff

Goal: Model local-to-remote execution plane movement as durable resource and
materialization facts.

Owning feature spec:
`features/firegrid/firegrid-execution-plane-resources.feature.yaml`

Required ACIDs:

- App-owned resource identity, version, checksum, and materialization status.
- Opaque secret-reference rows with redaction and audit fields.
- Runtime materializer subscriber pattern.
- Local-to-remote replay and projection rebuild guidance.
- No secret storage, provider auth policy, or sandbox lifecycle in Firegrid.

Dependencies: L2, then L7/L8 for full handoff.

Anti-scope: no WorkOS, OAuth, BYOK, Smithery, GitHub, MCP credential semantics,
provider auth policy, or sandbox image/build/deploy policy in Firegrid.

Decision refs: D-15, D-21.

### L6: Durable Subscriber and Webhook Ingest

Goal: Reuse durable subscriber mechanics for callback-driven provider event
ingest and outbound delivery.

Owning feature spec:
`features/firegrid/firegrid-durable-subscriber-webhooks.feature.yaml`

Required ACIDs:

- Selector, completion key, cursor acknowledgement, retry, conflict, and
  dead-letter mechanics.
- Deterministic replay/live-tail subscriber behavior.
- First-terminal-wins delivery completion.
- Runtime presence integration for selecting public ingress where needed.
- Product-owned payload, signing, auth, and callback policy.

Dependencies: L2, L7 for ingress selection.

Anti-scope: no Standard Webhooks signing helpers, callback URL minting,
callbackEvents filtering, provider callback tokens, or payload schemas in
Firegrid core.

Decision refs: D-06, D-07.

### L7: Runtime Presence and Ingress Discovery

Goal: Let Firegrid hosts in a durable topology publish queryable runtime
presence without creating a host-to-host transport side channel.

Owning feature spec: `features/firegrid/firegrid-runtime-presence.feature.yaml`

Required ACIDs:

- Runtime presence descriptor with runtime id, host id, node id, provider kind,
  topology identity, advertised ingress endpoints, readiness status,
  timestamps, and public metadata.
- Startup, heartbeat, readiness update, and retirement records as durable
  facts.
- Projection/query selection by capability, readiness, freshness, topology,
  and app-owned scope.
- Ingress endpoint selection for durable subscribers and external callback
  registration.
- Exclusion of private host transport credentials, internal-only addresses,
  provider secrets, and host-to-host command routing.

Dependencies: L2.

Anti-scope: no host mesh, command bus, private endpoint registry, or transport
credential storage.

Decision refs: D-06, D-07, D-23.

### L8: Runtime Ownership Transfer and Reattach Conformance

Goal: Support local-to-remote agent shift without pretending Firegrid can move
provider processes that do not expose a reattach contract.

Owning feature spec:
`features/firegrid/firegrid-runtime-ownership-transfer.feature.yaml`

Required ACIDs:

- Runtime owner lease, heartbeat, fence, and epoch records.
- Ownership transfer only after release, drain, or stale-owner evidence.
- Projection rebuild and live-boundary proof before the new owner performs
  externally visible side effects.
- Product-owned reattach classification attached to app/provider rows.
- Duplicate side-effect prevention across old and new owners.
- Client-observable continuity through existing handles and query surfaces.
- Same-topology host shift and cross-topology export/import treated separately.

Dependencies: L2, L5, L7.

Anti-scope: no live process migration claims without provider conformance; no
old/new owner duplicate side effects.

Decision refs: D-08, D-09, D-19, D-23.

### L9: Durable Scheduling Tool Bindings

Goal: Make Firegrid sleep, wait, scheduled work, and awakeable primitives
cleanly exposable by agent runtimes without making agent tool transports
substrate concepts.

Owning feature spec:
`features/firegrid/firegrid-scheduling-tool-bindings.feature.yaml`

Required ACIDs:

- Public neutral tool-binding shape with name, Effect Schema input, handler,
  and neutral result/suspension output.
- Identical durable lowering between runtime API calls and tool binding calls.
- Durable descriptor publication for mounted substrate scheduling tools.
- Descriptor/handler validation before runtime attachment.
- CurrentWorkContext or equivalent durable identity for suspending tools.
- Minimal-layer execution for non-suspending scheduling tools.
- Agent-readable observation recipes over app-owned EventPlane/EventStream rows.
- Exclusion of MCP, provider schemas, prompt text, permission policy, sandbox
  execution, and Flamecast tool names from Firegrid core.

Dependencies: existing wait/scheduling specs; L2 for observation; L1 optional.

Anti-scope: no MCP/OpenAI/Anthropic/Flamecast tool schemas, provider tool
names, sandbox execution, or policy gates in Firegrid.

Decision refs: D-10, D-11, D-12, D-13, D-20.

### L10: Claimed Intent Transport

Goal: Make durable intent rows ergonomic enough to support prompt transport,
scheduled self-prompt, external callback intent, and other app-owned dispatch
flows without introducing product mailbox semantics into Firegrid.

Owning feature spec:
`features/firegrid/firegrid-claimed-intent-transport.feature.yaml`

Required ACIDs:

- Descriptor-scoped intent row definitions with app-owned payload schemas.
- Stable idempotency keys and duplicate-payload conflict behavior.
- Snapshot-first claim eligibility over app-owned projections.
- Claim-before-dispatch with owner id, attempt id, epoch/fence, and
  replay-to-live-boundary proof.
- First-terminal-wins result/error rows and typed terminal observation.
- Client/query handles that observe intent state without raw StreamDB
  collection authority.
- Runtime presence integration for selecting eligible dispatch owners.
- Observability metadata for append, claim, dispatch, side effect, and
  terminalization.
- Exclusion of prompt/session/provider/MCP/ACP/WebSocket semantics from
  Firegrid core.

Dependencies: L2, L7; L8 for host-shift-safe dispatch; L1 optional.

Anti-scope: no Firegrid `PromptRequestRow`, mailbox API, ACP transport,
WebSocket URL, MCP prompt API, or browser-authored terminal/claim rows.

Decision refs: D-22.

## Part 4: Execution Plan

### Dependency Graph

| Work | Depends on | Parallel notes |
| --- | --- | --- |
| W-00 Firegrid platform invariants spec | none | First spec. Other Firegrid specs cite its boundary/locality/security ACIDs. |
| W-01 Flamecast product contract spec | none | Can run before Firegrid implementation; cites product PRD. |
| W-02 Firegrid agent-runtime substrate spec | W-00 | Establishes long-lived operation/reconnect/runtime locality. |
| W-03 Projection query spec | W-00 | Unblocks client, discovery, resources, presence, intent observation. |
| W-04 Client projection API spec | W-03 | Can run while runtime lanes are still spec-only. |
| W-05 Observability spec | W-00 | Can run in parallel; smokes can adopt later. |
| W-06 Runtime presence spec | W-03 | Unblocks webhooks, handoff, claimed intent owner selection. |
| W-07 Resource/materialization spec | W-03 | Unblocks handoff. |
| W-08 Ownership transfer spec | W-03, W-06, W-07 | Needed for local-to-remote shift. |
| W-09 Durable subscriber/webhook spec | W-03, W-06 | Can run after presence shape is pinned. |
| W-10 Scheduling tool binding spec | existing wait/scheduling specs | Can run independently of handoff. |
| W-11 Claimed intent transport spec | W-03, W-06 | Needed for prompt transport. |
| W-12 Flamecast cleanup lane | W-01 draft | Runs in `flamecast-agents` branch, not Firegrid. |
| W-13 Minimal replatform smoke | W-01, W-02, W-03 | First cross-repo proof. |
| W-14 Local-to-remote shift smoke | W-06, W-07, W-08, W-13 | Proves handoff. |
| W-15 Scheduling tool smoke | W-10, W-13 | Proves tool-layer lowering. |
| W-16 Durable prompt transport smoke | W-11, W-13 | Proves human/agent prompt intent. |
| W-17 Incremental replacement | W-13 plus relevant lane | Replace product infra one slice at a time. |

### Work Item Index

| ID | Title | Lane | Status | Acceptance reference |
| --- | --- | --- | --- | --- |
| W-00 | Firegrid platform invariants spec | Cross-cutting | Proposed | `firegrid-platform-invariants.*` ACIDs. |
| W-01 | Flamecast AgentSpec/ProviderManifest/Capability/Callback spec | Product | Proposed | Product ACIDs in `features/flamecast`. |
| W-02 | Firegrid agent-runtime substrate spec | Foundation | Proposed | Long-lived operations, replay, runtime locality, product-owned control rows. |
| W-03 | Projection query spec | L2 | Proposed | L2 ACIDs. |
| W-04 | Client projection API spec | L3 | Proposed | L3 ACIDs. |
| W-05 | Observability spec | L1 | Proposed | L1 ACIDs. |
| W-06 | Runtime presence spec | L7 | Proposed | L7 ACIDs. |
| W-07 | Execution-plane resources spec | L5 | Proposed | L5 ACIDs. |
| W-08 | Runtime ownership transfer spec | L8 | Proposed | L8 ACIDs. |
| W-09 | Durable subscriber/webhook spec | L6 | Proposed | L6 ACIDs plus webhook proposal. |
| W-10 | Scheduling tool binding spec | L9 | Proposed | L9 ACIDs. |
| W-11 | Claimed intent transport spec | L10 | Proposed | L10 ACIDs. |
| W-12 | Flamecast cleanup lane | Product | Proposed | Infra removed/quarantined only where Firegrid replacement exists or gap is reported. |
| W-13 | Minimal replatforming smoke | Cross-repo | Proposed | Packed Firegrid packages; no kernel/private paths; typed terminalization. |
| W-14 | Local-to-remote shift smoke | Cross-repo | Proposed | Litmus test passes with no duplicate side effects. |
| W-15 | Durable scheduling tool smoke | Cross-repo | Proposed | Tool call lowers to same durable records as runtime API. |
| W-16 | Durable prompt transport smoke | Cross-repo | Proposed | Human and agent prompt intents share durable path. |
| W-17 | Incremental replacement | Product | Proposed | Replace REST/WebSocket/polling/SQL/R2/ClickHouse slices only after relevant smoke. |

## Part 5: Litmus Tests and Smokes

### LT-01: Local-to-Remote Agent Shift

Target story:

1. A developer runs Flamecast completely locally against Firegrid.
2. A Flamecast agent backed by a provider adapter such as Claude Code is
   provisioned and starts producing durable session facts.
3. A second Flamecast/Firegrid host joins the same durable stream topology, or a
   selected session scope is exported/imported into another topology.
4. The developer shifts the agent to the second host.
5. The new host materializes the execution plane, advertises required ingress,
   resumes or reprovisions the provider adapter according to its declared
   profile, and continues the durable session without the client switching to
   raw durable-state APIs.

Version 1 does not require live process migration. It does require a clean,
durable handoff that can reprovision a functionally equivalent agent from
Firegrid durable facts and Flamecast provider/resource semantics.

LT-01 is a scenario, not a substitute for specs. Before the smoke implementation
lands, add an Acai scenario spec such as
`features/firegrid/litmus-lt-01-local-to-remote-shift.feature.yaml` or an
equivalent product-owned Flamecast litmus spec. That file should express the
steps as requirements and cite the lane ACIDs they verify.

Example requirement shape:

```yaml
components:
  HANDOFF:
    requirements:
      1: The new host satisfies runtime ownership transfer fence ACIDs before
         any externally visible side effect.
      2: Materialization completes before provider reattach.
      3: Client observation continuity is verified through projection/query
         ACIDs rather than raw durable-state reads.
```

### S-01: Minimal Replatforming Smoke

Proves session create, event append, provider callback row, `RunWait` wake,
typed terminalization, query replay, and trace continuity using packed Firegrid
packages only.

### S-02: Local-to-Remote Shift Smoke

Starts one host, publishes runtime presence, releases/fences ownership,
rebuilds projections and materializes resources on a second host, continues the
session through a product-owned provider reattach profile, and asserts stable
client observation plus no duplicate side effects.

### S-03: Durable Scheduling Tool Smoke

Defines a Flamecast-owned provider/tool adapter around Firegrid neutral
scheduling bindings. Proves sleep, wait, scheduled self-prompt, and awakeable
tools write the same durable completion/run shape as runtime APIs.

### S-04: Durable Prompt Transport Smoke

Defines Flamecast-owned prompt intent, chunk, and terminal schemas. A human path
and an agent-to-agent path append the same durable prompt intent shape. A test
agent harness claims and dispatches after replay-to-live-boundary. Duplicate
identical submissions return the existing handle; duplicate conflicting
submissions fail. Cancellation and not-live failures terminalize through
app-owned rows. Client code never knows ACP, MCP, WebSocket, provider session,
or runtime transport details.

### First Validation Harness

Use a small purpose-built test agent first, not Think or Claude Code. The
harness can be ACP-shaped or another minimal runtime as long as it is easy to
run locally, deterministic in CI, and proves platform mechanics before
provider-specific process behavior.

## Part 6: Decision Log

Decision IDs are stable cross-references for lanes, specs, and reviews.

| ID | Decision |
| --- | --- |
| D-01 | Flamecast product specs live under `features/flamecast`; Firegrid product-neutral specs live under `features/firegrid`. |
| D-02 | V1 browser/app query surfaces are read-oriented. Queryable EventPlane rows are written through typed producers, subscribers, server/edge code, or operation/EventStream APIs, not raw browser StreamDB mutation. |
| D-03 | The minimum query facade is descriptor-scoped `snapshot`, `stream`, `until`, and `events` with typed decode and retention-gap errors; no raw collections/envelopes/kernel. |
| D-04 | Implement framework-neutral `@firegrid/client` projection/query affordances first; shared React helpers are thin optional adapters after a second call site proves the shape. |
| D-05 | Use Durable Streams protocol offsets and `Stream-Next-Offset` as durable resume primitives; map `410 Gone`, `400`, `404`, `Stream-Up-To-Date`, and `Stream-Closed` to typed client behavior. |
| D-06 | Runtime presence descriptor minimally includes runtime id, host id, node id, provider kind, topology identity, public ingress endpoints, readiness, timestamps, and public metadata. |
| D-07 | Runtime presence schemas/projections belong in curated substrate/EventPlane surfaces; publisher/heartbeat Layer belongs in `@firegrid/runtime`; browser reads go through projection/query facade. |
| D-08 | A shifted host may continue work only after lease/epoch evidence, old-owner release/drain/stale proof, new-owner fence/claim, projection rebuild, materialization, and provider reattach classification. |
| D-09 | Flamecast provider reattach profiles start as `no_reattach`, `reprovision_from_history`, `load_via_protocol`, and `supervised_live_process`. |
| D-10 | Neutral scheduling binding type belongs with durable scheduling substrate; runtime publication/attachment helpers belong in `@firegrid/runtime`; provider wire adapters stay downstream. |
| D-11 | Mounted scheduling tool descriptors are durable app-owned facts/events with source, topology, stable name, schema ref/hash, handler key, ordering, policy summary, credential/transport refs, runtime id, and timestamps. |
| D-12 | Do not make child operation/fan-in a first Firegrid primitive. Prove spawn/fanout with app-owned operations, rows, and waits first. |
| D-13 | Firegrid records generic scheduled work; Flamecast lowers scheduled self-prompt and owns promptability at firing time. |
| D-14 | Trace context in durable rows is optional but standardized; correctness and authorization must not depend on trace metadata. |
| D-15 | Start resource/materialization as documented EventPlane patterns and descriptor helpers; promote package APIs only after handoff smoke proves repeated mechanics. |
| D-16 | V1 cancellation remains app-owned control rows plus handler `Effect.fail`; any future `client.cancel` helper must lower to the same semantics and expose no kernel authority. |
| D-17 | Move read-only listing/status views first; keep destructive policy, billing, and secret/resource access checks product-owned until specs define durable facts and access rules. |
| D-18 | Split projection/query, client projection API, runtime presence, ownership transfer, resources, scheduling tools, and claimed intent into separate feature specs with one-way dependencies. |
| D-19 | Use a small deterministic test agent for the first reattach/handoff harness; real provider adapters come after platform mechanics pass. |
| D-20 | First scheduling tool smoke lives in `flamecast-agents` on the `firegrid-foundation` branch and consumes packed Firegrid artifacts. |
| D-21 | Flamecast cleanup work happens in `flamecast-agents` only, preserving product semantics and reporting gaps where Firegrid replacements do not exist. |
| D-22 | Prompt transport is an app-owned durable intent pattern over Firegrid mechanics; Firegrid may provide generic claimed-intent helpers but no prompt/mailbox/product transport core. |
| D-23 | Runtime locality: `@firegrid/runtime` is Node-tier today; `@firegrid/client` is browser/edge-safe. Integrators must split topology accordingly. |

## Part 7: Guardrails and Review Criteria

### Hard Guardrails

Do not implement any of the following in Firegrid core:

- Flamecast provider names, AgentSpec semantics, capabilities, providerAuth, or
  providerOptions.
- WorkOS, OAuth, BYOK, Smithery, GitHub, MCP, or provider credential policy.
- Sandbox lifecycle for Daytona, Modal, Sprites, Firebox, Cloudflare
  Containers, or ComputeSDK.
- Standard Webhooks signing or callback fanout policy.
- Flamecast normalized event row family as a Firegrid-native row family.
- Fireline/Firepixel/Flamecast session, prompt, permission, tool, conductor,
  middleware, provider, or capability schemas in Firegrid packages.
- Direct durable row authoring, kernel imports, dev launcher resurrection, or
  dynamic runtime module loading.
- Runtime presence used as a command bus, host mesh, private transport
  registry, or secret-bearing endpoint directory.
- Claims that Firegrid can live-migrate provider processes without a
  product-owned provider reattach profile and conformance proof.
- Ownership transfer that allows both old and new hosts to perform the same
  externally visible provider side effect.
- Agent-facing MCP, Anthropic, OpenAI, provider, permission, prompt, sandbox,
  or Flamecast tool vocabulary added to Firegrid packages.
- Scheduling tool bindings that expose raw completions, raw run rows, stream
  URLs, kernel imports, or Durable Streams State envelopes to agent code.
- Prompt/mailbox abstractions in Firegrid packages that bypass app-owned rows,
  projection waits, claims, and typed terminal observation.

### Review Criteria

An implementation following this SDD is acceptable only if:

- Every new behavior has Acai ACIDs before code changes.
- Feature specs use the ownership split in Part 2 and lane briefs in Part 3.
- Work items cite ACIDs directly. Do not introduce parallel requirement IDs
  when an Acai feature spec can carry the requirement.
- Package-consumption smokes use packed public Firegrid artifacts only.
- Runtime examples use `Firegrid.composeRuntime` and public package roots.
- Browser examples use `@firegrid/client` only, never `@firegrid/runtime`,
  `@firegrid/substrate/kernel`, raw StreamDB collections, or Durable Streams
  State envelopes.
- External wait/write flows observe deterministic request/Pending state before
  appending decisions or results.
- Scheduling tool examples prove neutral Firegrid bindings lower to the same
  durable records as runtime APIs and keep provider/MCP conversion outside
  Firegrid packages.
- Prompt transport examples prove app-owned prompt rows over claimed-intent
  mechanics and keep provider transport out of Firegrid packages.
- No forbidden tokens or kernel/control-plane imports appear in app/downstream
  smoke code.

## Appendix: Source Evidence

### Flamecast

- `web/src/api.ts` hand-writes SPA-to-worker REST helpers for agents, hives,
  sessions, workspace files, message sends, and live WebSocket event URLs.
- `web/src/App.tsx` polls session/agent lists, opens a raw session WebSocket
  with `?since=<seq>`, merges events by sequence, derives header/status/tokens
  locally, and refetches workspace state after event bursts.
- `src/effect/services/agents-db.ts` owns Postgres reads and writes for agent
  ownership, listing, lazy claim, rename, and archive.
- `src/effect/services/sessions-db.ts` owns Postgres reads and writes for
  session ownership, status, listing, lazy claim, and deletion.
- `src/db/schema.ts` stores mutable agent/session org gates in Postgres while
  leaving events in ClickHouse and resources in R2.
- `src/agent-resources.ts` stores reusable agent bundles in R2 under
  `agents/<id>/...`.
- `src/session-resources.ts` stores per-session skills, MCPs, Smithery creds,
  GitHub integration sidecars, env vars, and system prompts in R2.
- `src/transcript.ts` lazily extracts SDK JSONL transcripts from workspace
  snapshot tarballs in R2 and normalizes them into public transcript events.
- `src/observability/trace.ts` wraps OpenTelemetry APIs with helpers such as
  `withSpan`, `recordError`, `addSpanEvent`, and `getTraceContext`.
- `docs/prds/PRD_FLAMECAST.md` defines Sessions API, Provider API, AgentSpec,
  capabilities, callbacks, provider metadata, and provider checks.

### Firegrid / Durable Streams

- `packages/client/src/index.ts`, `packages/client/src/operations.ts`, and
  `packages/client/README.md` define the current browser/app surface:
  `send`, `result`, `call`, `observe`, `emit`, and `events`.
- `@firegrid/runtime` exposes `Firegrid.composeRuntime`, handlers, event
  streams, subscribers, and `run`.
- `@firegrid/substrate` exposes descriptors, EventStream/Operation types,
  RunWait, trigger matchers, and EventPlane support.
- Durable Streams `stream-db.md` describes `createStateSchema`,
  `createStreamDB`, typed collections, reactive queries, optimistic actions,
  transaction IDs, `awaitTxId`, and lifecycle discipline.
- Durable Streams `PROTOCOL.md` defines offsets, `Stream-Next-Offset`,
  `Stream-Cursor`, `Stream-Up-To-Date`, `Stream-Closed`, and `410 Gone`
  retention behavior.
- `docs/proposals/SDD_DURABLE_WEBHOOK_SUBSCRIBERS.md` proposes a neutral
  durable subscriber/webhook channel layer.

### Fireline / RFC

- `fireline/vault/retired/superseded/guides/tutorials/fireline/local-to-cloud.md`
  frames local-to-cloud as a stable app endpoint plus target-owned durable
  storage and target-native deployment.
- `fireline/src/runtime/identity.rs` builds host/runtime descriptors from
  runtime identity, node id, provider kind, advertised endpoints, readiness
  metadata, and timestamps.
- `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/choreography-and-combinators.md`
  frames sleep, wait, spawn, fanout, scheduled self-prompt, and execution as
  durable substrate operations plus product-owned combinators.
- `fireline/crates/fireline-substrate/src/tools/publish.rs` separates
  topology-local tool declarations, descriptor validation, optional durable
  descriptor emission, and live MCP server attachment.
- `fireline/src/bin/testy_mcp_passthrough.rs` forwards MCP list/call requests
  without baking tool transports into the durable substrate.
- `fireline/packages/client/src/prompt-intent.ts` models prompts as idempotent
  durable intent rows keyed by session/request.
- `fireline/packages/client/src/prompt-handle.ts` and
  `fireline/packages/client/src/prompt-result.ts` separate prompt submission,
  update streaming, cancellation, timeout, and terminal result interpretation.
- `fireline/crates/fireline-runtime/src/launch/prompt_dispatcher.rs` owns
  replay, durable claims, dispatch eligibility, liveness decisions, terminal
  prompt rows, and dead-runtime handling while leaving ACP/WebSocket transport
  to the session/conductor layer.
- Fireline PR #875 local merge commit `ae2f00b8` reset the client read/prompt
  boundary into smaller prompt intent, handle, state, materialization, and
  schema surfaces.
