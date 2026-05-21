# PROPOSAL — External MCP Attachment Path for Provider Tools (tf-x1jx)

Date: 2026-05-21
Status: DESIGN PROPOSAL (decision-grade input; NOT a final SDD)
Bead: tf-x1jx (P1, design)
Author: Lane 5 (opus) — audit-first proposal
Decision owner: Gurdas / gary (architecture tier)
Blocks: tf-30nu (outbound-effects); see PR #559 (wrong-shape evidence)

This is an **audit-first proposal**: inventory + options + recommendation +
open questions. It does not finalize an SDD and ships no production code. The
load-bearing decision (when a provider action is an MCP tool vs a Firegrid
durable channel) stays with Gurdas/gary.

## §0 TL;DR recommendation

1. **Do NOT add provider-specific outbound action channels to core Firegrid
   for private beta.** PR #559 demonstrated the wrong shape twice (product-named
   `linear.issue.comment.create` channel, then a neutral `external.effect.call`
   channel whose runtime adapter immediately became an opaque-effect-id
   provider-tool dispatcher). Provider actions are MCP tools first.
2. **Firegrid already HAS an external-MCP attachment primitive**:
   `RuntimeConfig.mcpServers` — a client-owned array of `{name, server:{type:"url",
   url, headers?}}` passed through to the agent's ACP/codec `newSession`. The
   agent connects to those MCP servers directly; Firegrid wraps the agent's tool
   use with durable sessions, waits, observation, permissioning, and replay.
3. **The gap vs Smithery/agent.pw is connection MANAGEMENT, not attachment**:
   OAuth setup/refresh, config-input collection, a connection registry/namespace,
   scoped service tokens, and tool-listing aggregation. Per Firegrid's substrate
   boundary, that management is a **consumer/external concern** (Smithery,
   agent.pw, or the app), not Firegrid substrate. Firegrid's job is to carry the
   connection coordinates and observe/permission the resulting tool use.
4. **Promote a provider action into a Firegrid channel ONLY on concrete
   durability pressure** around the side effect itself: claim-before-side-effect,
   durable action/evidence rows, retries, idempotent receipts, or waitable
   completion facts. Absent that pressure, it stays an MCP tool.
5. **One real near-term gap to close regardless**: external-MCP `headers`
   currently carry **literal** secret values into the durable plane, unlike the
   ref-only `RuntimeEnvBinding` discipline. This is the credential-boundary item
   worth fixing first (see §3).

## §1 Inventory — current Firegrid MCP launch/config path

### §1.1 Two MCP attachment kinds exist today

**(a) Client-owned external MCP servers — `RuntimeConfig.mcpServers`**

`packages/protocol/src/launch/schema.ts`:

```ts
McpServerUrlDeclarationSchema = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})
McpServerDeclarationSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  server: McpServerUrlDeclarationSchema,
})
RuntimeConfigSchema = Schema.Struct({
  argv, cwd?, agent?, envBindings?, agentProtocol?,
  mcpServers: Schema.optional(Schema.Array(McpServerDeclarationSchema)),  // ← client-owned external MCP
  runtimeContextMcp: Schema.optional(RuntimeContextMcpMarkerSchema),       // ← host-owned (b) below
})
```

Each entry is an MCP server URL + optional HTTP headers. The client authors them
end-to-end. They flow through `local.jsonl({ mcpServers })` →
`RuntimeConfig.mcpServers` → the ACP codec's `newSession({ mcpServers })`
(`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`,
`lowerMcpServerDeclaration`). The agent process (claude-acp / codex-acp) makes the
actual MCP connection and tool calls; Firegrid does not proxy the MCP transport.

This **IS** the generic external-MCP attachment primitive. A Smithery namespace
endpoint (`https://mcp.smithery.run/{namespace}`) or any hosted MCP server drops
straight into `mcpServers` as a `{ name, server: { type:"url", url, headers } }`
entry today, with no Firegrid change.

**(b) Host-owned Firegrid runtime-context MCP — `runtimeContextMcp` marker**

A URL-less client marker (`RuntimeContextMcpMarkerSchema { enabled: true }`)
expressing *that* the host-owned Firegrid agent toolkit should attach; the host
resolves and injects the concrete `contextId`-scoped URL post-materialization
(`firegridRuntimeContextMcpDeclaration`, `FiregridRuntimeContextMcpBaseUrl`). The
server itself is `packages/host-sdk/src/host/mcp-host.ts`: an `@effect/ai`
`McpServer.layerHttp` + `McpServer.registerToolkit(FiregridAgentToolkit)` mounted
at `/mcp/runtime-context/:contextId`, exposing the body-plan verbs
(`wait_for`/`send`/`call`/`sleep`/`spawn`/`session_*`/`execute`). The route param
is the request authority (not a tool arg). This is Firegrid exposing ITS OWN
substrate as MCP — the inverse direction from (a).

### §1.2 What Firegrid provides AROUND tool use (the durable wrapper)

Independent of which MCP servers attach, Firegrid supplies, per the
SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE model:

- durable session lifecycle (RuntimeContext create/start/cancel/close)
- agent-output observation + replay (`SessionAgentOutputChannel`, journaled rows)
- permissioning (`SessionPermissionChannel` / `HostPermissionRespondChannel`)
- waits over durable facts (`wait_for`)
- traces/OTel spans around every tool call
- the `execute`/sandbox tool seam for SandboxProvider-backed tools

Tool CALLS to external MCP servers happen agent-side; Firegrid observes them as
`ToolUse` agent-output events (it journals the call + result as durable
observation rows) and can gate them via permission requests. It does NOT today
own the external action's durability (no claim/receipt/retry around the provider
side effect — that is exactly what #559 tried to add prematurely).

### §1.3 Credential handling today (the boundary gap)

- `RuntimeEnvBinding { name, ref }` (env secrets): **ref-only**. The durable
  plane stores a *name + ref to a host env var*; the resolver reads the value at
  spawn and merges into `SandboxCommand.envVars`. "The durable plane never sees
  the value" (schema.ts comment, PHASE_2_SYNC_RUN.5).
- `McpServerUrlDeclaration.headers`: **literal `Record<string,string>`**. Provider
  auth headers (bearer tokens, API keys) for external MCP servers are carried as
  literal values, client → durable launch intent. This is inconsistent with the
  ref-only env discipline and means provider secrets can land in durable rows /
  traces unless the caller is careful. **This is the one concrete pre-beta gap
  this proposal flags as fix-first** (§3 / Option C).

## §2 The wrong-shape evidence (PR #559) — why not a channel yet

PR #559 (lane 2, tf-30nu) is the concrete naive shape. Two iterations, both
flagged wrong by review (Gurdas comments on #559):

- **Iteration 1**: a product-named `linear.issue.comment.create` callable channel
  in `@firegrid/protocol/channels` + a host-sdk Live Layer. Bakes provider
  semantics into the core protocol catalog.
- **Iteration 2 (neutral)**: `external.effect.call` callable channel with an
  opaque `{ effectId, payload } → { output }` request/response, backed by a
  runtime `ExternalEffectOutboundAdapter` (Linear GraphQL behind it).

Review pressure points (verbatim disposition, recorded as tf-x1jx input):

- The protocol stays neutral only by reducing the request to `effectId + payload`
  — which pushes provider typing/validation into runtime adapter code.
- The runtime adapter becomes a product-action dispatcher keyed by opaque effect
  ids — i.e. it *reinvents an external provider tool registry*.
- Provider auth, transport config, action discovery, and schema exposure do not
  belong in protocol channels.
- The binding called the provider directly inside `binding.call` (no
  claim-before-side-effect, no durable receipt) — closer to a test/demo binding
  than a production side-effect contract.

Net: a generic channel substrate is *possible*, but provider outbound actions are
better modeled as external MCP tool attachments (Smithery Connect-style) before
committing to durable outbound channels. **#559 should not land as written.**

## §3 Options for the external-MCP attachment path

Three options, increasing Firegrid involvement. They are not exclusive — C is a
fix regardless; the A-vs-B axis is the real decision.

### Option A — Status quo + document the paved road (minimal)

Treat `RuntimeConfig.mcpServers` as the external-MCP attachment primitive as-is.
A Smithery namespace endpoint or any hosted MCP server is attached by the
client/app as an `mcpServers` URL entry. Connection management (OAuth, config,
refresh, scoped tokens) lives entirely outside Firegrid (Smithery / agent.pw /
the app). Firegrid documents this as the paved road and adds nothing.

- **Pros**: zero new substrate; honors the Firegrid-stays-substrate boundary;
  ships today; provider semantics never enter the protocol catalog.
- **Cons**: the credential gap (§1.3) remains; no Firegrid-side connection
  metadata/discovery; the app owns all connection lifecycle.

### Option B — Thin "MCP connection resolver" capability (host-side, neutral)

Add a host-composition-time capability that resolves an *opaque connection
reference* into the concrete `mcpServers` entry at launch, instead of the client
embedding literal URL+headers. Shape (sketch, NOT final):

```
RuntimeConfig.mcpServers entry gains a ref form:
  { name, server: { type: "ref", connectionRef: "<opaque>" } }
A host-side McpConnectionResolver capability (Tag + Layer, like
RuntimeEnvResolverPolicy) maps connectionRef → { url, headers } at start,
reading from a consumer-supplied connection store (Smithery service token,
agent.pw vault, or app config). The durable plane stores only the ref.
```

This mirrors the `RuntimeEnvBinding` ref-only discipline for MCP connections:
the durable plane holds a *reference*, the host resolves the concrete coordinates
(incl. secrets/headers) at spawn from a consumer-owned store.

- **Pros**: closes the credential gap (§1.3) the right way (ref-only durable);
  lets Smithery/agent.pw be the connection store behind the resolver; still no
  provider semantics in protocol; symmetric with envBindings.
- **Cons**: new (small) host capability + a launch-schema ref variant; needs a
  resolver-policy contract; more than private-beta strictly requires if callers
  can keep secrets out of literal headers by discipline.

### Option C — Credential-boundary fix only (orthogonal, do regardless)

Independent of A/B: make external-MCP `headers` carry secrets by **ref**, not
literal, OR explicitly document + lint that literal header secrets are forbidden
in durable launch intent (mirror the env `LaunchSecretEnvCliValueSchema` rule:
"literal secret values are never accepted"). Smallest correctness win; removes
provider tokens from durable rows/traces.

- **Recommendation**: do C regardless of the A/B choice. It is the one concrete
  pre-beta correctness gap. B is C done structurally (ref resolver); A+C is C done
  by validation/discipline.

### Recommended path

- **Private beta**: **Option A + Option C**. Document `mcpServers` as the external
  MCP attachment paved road; close the literal-header-secret gap by
  ref/validation. No new channels, no provider semantics, no connection-manager
  rebuild. Smithery/agent.pw plug in as the connection store the app points at.
- **Post-beta (if pressure)**: **Option B** when multiple consumers need
  Firegrid-resolved connection refs (so the durable plane never holds URLs or
  secrets and connections are swappable). Promote to B only when that pressure is
  concrete, same discipline as channel promotion (§4).

## §4 The load-bearing distinction — MCP tool vs Firegrid durable channel

This is what #559 got wrong and what future provider-action work must apply.

**A provider action stays an MCP tool the agent calls when:**

- The action is request/response with no Firegrid-owned durability requirement
  beyond the existing agent-output observation (the call + result are journaled
  as `ToolUse` observation rows for replay/audit, which Firegrid already does).
- Idempotency/correlation can live in the provider's own API (or be the agent's
  concern), not Firegrid's substrate.
- Auth/transport/discovery/schema are provider/connection concerns (the MCP
  server advertises its own tools + schemas).

→ This is the **default**. Linear/GitHub/Slack "create comment / open PR / post
message" are MCP tools first.

**Promote a provider action to a Firegrid durable channel ONLY when there is
concrete pressure for Firegrid-OWNED durability semantics around the side effect
itself**, i.e. at least one of:

- **claim-before-side-effect**: the effect must be fenced (first-writer-wins)
  across hosts/replays so it fires exactly once.
- **durable action/evidence rows**: a durable request row + a durable
  receipt/failure fact that survive restart and are independently queryable.
- **retries with durable backoff**: Firegrid owns the retry policy + attempt
  rows, not the agent.
- **waitable completion facts**: other workflow steps `wait_for` the receipt of
  the side effect.

→ When these appear, the action is modeled as a `CallableChannel<Request,
Receipt>` over **durable action + evidence rows** (SDD Pattern 1: request-row +
completion-row), with the provider call performed by a runtime adapter behind the
durable claim. The channel is generic (request/receipt schemas), the provider
mapping stays in an app/integration/runtime adapter, and the product name never
enters `@firegrid/protocol/channels`.

**Decision test (one line):** *"If the agent process crashed mid-action, does
Firegrid need to own knowing whether the side effect happened?"* If no → MCP
tool. If yes → durable channel (claim + receipt).

This also reframes #559: a Linear issue comment has no Firegrid-owned durability
requirement today (the agent calls it, Firegrid journals the ToolUse). It is an
MCP tool. It becomes a channel only if/when a workflow must, e.g.,
`wait_for(comment-posted-receipt)` or guarantee exactly-once across host failover.

## §5 How Smithery / agent.pw map onto this (reference evaluation)

The references are the connection-MANAGEMENT layer Firegrid should NOT rebuild:

- **Smithery Connect**: namespaces group connections; `mcp.smithery.run/{namespace}`
  bundles all of a namespace's connections behind ONE MCP endpoint with
  connectionId-prefixed tool names (`notion-personal.search`). OAuth + config are
  handled by hosted setup pages; scoped service tokens
  (`{ namespaces, resources, operations, metadata:{userId}, ttl }`) gate
  client-side use. → In Firegrid terms: a Smithery namespace endpoint is a SINGLE
  `mcpServers` entry (url = the namespace endpoint, headers = a scoped service
  token). Firegrid attaches it; Smithery owns connections/OAuth/refresh/tokens.
- **agent.pw** (Smithery's auth layer, open source): credential kinds OAuth vs
  Headers; `connect.prepare → {ready|input_required|options}`, `startOAuth /
  completeOAuth / setHeaders / resolveHeaders`; scope-based `credential.use`
  authorization. → This is precisely the connection store + resolver that sits
  BEHIND Option B's `McpConnectionResolver`, or that the app calls directly under
  Option A. Firegrid does not implement OAuth flows; it consumes resolved headers
  (B) or a static scoped token (A).

Key takeaway: both references confirm connection management is a substantial,
already-solved external concern. Firegrid rebuilding it would violate the
substrate boundary and duplicate Smithery/agent.pw. Firegrid's differentiated
value is the durable agent runtime AROUND tool use, not the connection plumbing.

## §6 Backlog recommendations (proposed beads, ordered)

1. **tf-x1jx-followup-A (docs, P2)** — Document `RuntimeConfig.mcpServers` as the
   external-MCP attachment paved road in the client/host READMEs + a short note in
   SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES (provider-evidence paved road),
   including the Smithery-namespace-as-one-entry pattern. No code.
2. **tf-x1jx-followup-C (P1, correctness)** — Close the literal-header-secret gap:
   either forbid literal secrets in `McpServerUrlDeclaration.headers` at the
   schema/lint boundary (mirror `LaunchSecretEnvCliValueSchema`) OR add a
   header-ref form resolved at spawn. Smallest real fix; do first.
3. **tf-30nu — REDIRECT, do not land #559 as a channel.** Re-scope to: "provider
   actions are MCP tools; add a demo/integration showing a Linear MCP tool used by
   a Firegrid agent with durable observation/permission/replay around it." Keep
   the Linear GraphQL mapping in an app/integration/demo package, not protocol.
4. **tf-x1jx-followup-B (P3, post-beta, GATED)** — Only if multiple consumers need
   Firegrid-resolved connection refs: add `McpConnectionResolver` host capability
   + `mcpServers` ref variant (Option B). Gated on concrete pressure.
5. **Durable-action-channel pattern (P3, GATED)** — A generic
   `CallableChannel<Request, Receipt>` factory over durable action+evidence rows
   (SDD Pattern 1), to be used ONLY when a provider action hits the §4 promotion
   test. Authored when the first real claim-before-side-effect / waitable-receipt
   requirement appears — NOT speculatively.

## §7 Open questions for Gurdas / gary

1. **A vs B for private beta**: is documenting `mcpServers` as the paved road
   (Option A) sufficient, or do you want the ref-resolver (Option B) now so the
   durable plane never holds external MCP URLs/secrets?
2. **Credential gap severity**: is the literal-header-secret gap (§1.3) a
   pre-beta blocker (forbid literal secrets in headers) or a documented caveat?
3. **Smithery as first-class**: should Firegrid ship a documented Smithery
   recipe (namespace endpoint + scoped service token in `mcpServers`) as the
   canonical external-tool story, or stay transport-agnostic (any MCP URL)?
4. **#559 disposition**: confirm tf-30nu redirects to an MCP-tool demo (not a
   channel), and that the neutral `external.effect.call` channel is shelved until
   the §4 promotion test is met by a concrete requirement.
5. **Observation of external tool calls**: today Firegrid journals external MCP
   `ToolUse` as agent-output observations. Is that the agreed durability surface
   for provider actions in beta (replay/audit via observation rows), with
   claim/receipt reserved for §4 promotions? Confirm so docs can state it.

## §8 Cross-references

- `packages/protocol/src/launch/schema.ts` — `McpServerDeclarationSchema`,
  `RuntimeContextMcpMarkerSchema`, `RuntimeEnvBinding` (ref-only secret model)
- `packages/host-sdk/src/host/mcp-host.ts` — host-owned runtime-context MCP server
- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts` —
  `lowerMcpServerDeclaration` (mcpServers → ACP newSession)
- PR #559 (tf-30nu) + review comments — wrong-shape evidence
- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` — external-effect adapter
  carveout; channel promotion criteria
- `docs/sdds/SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES.md` — provider-evidence
  paved road
- Smithery Connect — https://smithery.ai/docs/use/connect
- agent.pw reference — https://github.com/smithery-ai/agent.pw/blob/main/docs/reference.md
