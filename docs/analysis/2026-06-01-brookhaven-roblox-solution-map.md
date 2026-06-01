# Brookhaven (Roblox in-game agent) → Firegrid substrate — solution map

**Task:** tf-r06u.31 · **Status:** read-only analysis (no production code; all code below is *illustrative*)
**Date:** 2026-06-01 · **Branch:** `codex/tf-r06u.31-brookhaven-solution-map`
**Source RFC:** `docs/rfc/external/brookhaven-roblox-in-game-agent.md`
**Companion platform RFC:** `docs/rfc/external/durable-stream-agent-plaform-rfc/`

---

## 0. Method & grounding

Every "mechanism TODAY" cell cites a real symbol in this worktree (verified by reading the
source, not inferred). The four anchor surfaces:

- **Client SDK public ops** — `packages/protocol/src/session-facade/operations.ts`
  (`FiregridClientOperations`) + `…/session-facade/schema.ts`.
- **Host composition** — `packages/runtime/src/unified/host.ts` (`FiregridHost`).
- **Channels** — `packages/protocol/src/channels/core.ts` (channel litmus, `ChannelTarget`,
  `ChannelRouteCompletion`, `EventOffset`) + `…/channels/host-control.ts` +
  `…/channels/session-agent-output.ts` + `…/channels/session-permission.ts`; runtime bindings in
  `packages/runtime/src/unified/channel-bindings.ts`.
- **Agent tools / MCP** — `packages/protocol/src/agent-tools/schema.ts`
  (`FiregridAgentToolOperations`), MCP wiring via `packages/protocol/src/launch/schema.ts`
  (`firegridRuntimeContextMcpName`, `RuntimeContextMcpMarkerSchema`, `McpServerDeclarationSchema`),
  dispatch in `packages/runtime/src/unified/subscribers/permission-and-tool.ts`
  (`ToolDispatchWorkflow`), codec in `packages/runtime/src/sources/codecs/acp/` +
  `…/unified/codec-adapter.ts` (`ProductionCodecAdapterLive`).
- **Durable read/append transport** — `packages/effect-durable-streams/`
  (`Reader.read/snapshotThenFollow`, `Writer.append/appendWithProducer`) and the wire contract in
  the durable-streams `PROTOCOL.md` (§5.2 append, §5.2.1 idempotent producers, §5.6 catch-up read,
  §5.7 long-poll, §12.1 auth-out-of-scope).

---

## 1. Executive verdict (read this first)

**The durable substrate is sufficient. The gap is an edge-auth surface, not a missing primitive.**

Brookhaven's entire loop — idempotent intent append, gap-free progress feed, terminal
discrimination, mid-run steering, restart-safe cursor resume, the publish side-effect, the ACP
agent — maps onto symbols that **already exist** in Firegrid + durable-streams. The poll-only
transport that the RFC treats as the scary part is the *easy* part: **durable-streams is already an
HTTP server with offset/cursor catch-up reads and producer-fenced idempotent appends.** It is the
single ingress. No new Firegrid gateway should be built.

After grounding against the durable-streams `PROTOCOL.md`, the gaps collapse to **three**, only one
of which is genuinely new work:

| Gap | Type | Verdict |
|---|---|---|
| **G1 — per-stream auth / capability-token scoping** | missing-token (edge) | **THE real new surface.** durable-streams puts auth/authz *explicitly out of scope* (§12.1) — there is no per-stream read scoping. This must be built as a thin token→opaque-handle layer in front of durable-streams. |
| **G2 — publish side-effect terminal** | missing-projection (minor) | Buildable today: model `publish` as an MCP tool → `ToolDispatchWorkflow` → durable tool-result terminal. The clean Firegrid-native answer to "claimed-work with its own terminal." A *dedicated* typed projection is optional polish. |
| **G3 — ACP adapter** | (none) | **Already exists.** `codec: "acp"` + `ProductionCodecAdapterLive` + `AcpSessionLive`; proven to run codex-acp and claude-agent-acp end-to-end and reach Firegrid MCP tools unmodified. |

**Everything else is already met:** idempotency (producer-fence §5.2.1 + `createOrLoad` externalKey
+ prompt `idempotencyKey`), the cursor-poll read contract (the §5.6 catch-up read **is** the
RFC-§6.3 `GET changes(projection, scopeKey, sinceCursor)`), the §10.4 no-gap/ordering guarantees
(offsets are monotonic, lexicographically ordered, gap-free within a stream, resume-by-persisted-
offset), terminal discrimination (typed `TurnComplete`/`Terminated`/`PermissionRequest`
agent-output events), steering (`wait.forPermissionRequest` + `permissions.respond` +
`promptScoped`), and multi-tenancy (host `namespace` + `externalKey` session scoping).

> **This answers the platform RFC's open §10.4 question** ("does poll-only require a subscription
> transport?"): **No.** The durable-streams catch-up offset read is *subscription-equivalent* for
> the no-gap / ordering / per-prompt-filtered guarantees. A poll-only client is a first-class
> profile, realized as **a per-session/per-prompt projection stream + an offset cursor**, with **no
> subscription transport required.**

---

## 2. Part A — Gap table

Sliced by the eight §6 asks, cross-referenced to the §4 pains (P1–P7) and the §7 1:1 mapping.
**Critical framing applied per row:** is this *fundamentally absent from the durable substrate*, or
does the substrate **have** it and we only need to **expose** it over the poll-only HTTP transport?

Gap-TYPE legend: `substrate-missing` · `missing-projection` · `missing-edge/transport` ·
`missing-token`.

| # | Capability | Brookhaven need (§4/§6/§7) | Firegrid mechanism TODAY (actual symbol) | Status | Gap TYPE | Disposition |
|---|---|---|---|---|---|---|
| **§6.1** | Idempotent prompt-intent append | Append a prompt idempotent by `(gameSessionId, playerId, requestId)`; P4 "double-tap spawns two sessions"; §7 `busyWithRequest`→first-claim-wins | `sessions.createOrLoad(externalKey)` (idempotent by `{source,id}`, `sessionContextIdForExternalKey` is a pure hash) + `sessions.promptScoped({idempotencyKey})` (`idempotencyKey` is **required**, min-length-1). Wire idempotency = durable-streams **producer-fence** (`Producer-Id`/`-Epoch`/`-Seq`; `seq ≤ lastSeq` → `204` dedup, §5.2.1). | **HAVE** (substrate) | — | Map `(gameSessionId,playerId)`→`externalKey`, `requestId`→prompt `idempotencyKey` *and* the producer `Producer-Seq`. Triple-keyed idempotency end-to-end. No new mechanism. |
| **§6.2** | Single HTTP ingress (append+read, one tunnel) | P2 "two tunnels / two endpoints"; §7 "two tunnels"→"one append/observe ingress" | durable-streams **is** the HTTP server: `POST {stream-url}` (append, §5.2) and `GET {stream-url}?offset=` (read, §5.6) on **one** base URL. `FiregridHost({durableStreamsBaseUrl})` already points the host at it. | **PARTIAL** | missing-token | Substrate transport is one URL already. The only missing piece is **G1** (scoping a single Bearer to the right streams). **Do NOT build a Firegrid gateway.** See Part C-1. |
| **§6.3** | Poll-friendly cursor read, subscription-equivalent | `GET changes(projection, scopeKey, sinceCursor)` for chunks/updates, prompt-terminal, permissions; P3 "relay tails an internal file"; §7 relay→`chunks` projection | durable-streams **catch-up read** `GET ?offset=<cursor>` → returns `Stream-Next-Offset` (§5.6). In-process the same shape exists as `wait.forAgentOutput({afterSequence,timeoutMs})` / `wait.forPermissionRequest(...)` and `sessionAgentOutputObservationRoute` (`seek: obs.sequence > afterSequence`). | **HAVE** (substrate) | — *(closed by existing catch-up read)* | The §6.3 ask **is literally the §5.6 catch-up read**: `offset`=cursor, `Stream-Next-Offset`=returned cursor, poll-loop=re-read with new offset. Not a new contract. **Recommend plain catch-up** for Roblox (long-poll §5.7 exists but RFC-flagged risky re `HttpService` timeouts; SSE §5.8 unusable from Roblox). |
| **§6.3-guarantee** | §10.4 no-gap / per-prompt-filtered / ordering over poll | Same correctness as subscribe, with only cursor reads | durable-streams offsets are **monotonic, lexicographically sortable, gap-free within a stream**, with **resume-by-persisted-offset** (`snapshotThenFollow` is "no-gap, no-duplicate"). Per-prompt filtering = a **per-prompt/per-session projection stream**. | **HAVE** (substrate) | — | No-gap+ordering are *native* to the offset model. "Per-prompt-filtered" = scope the projection to its own stream (one stream per session/prompt). **Caveat:** retention → `410 Gone` if read before the window; for minutes-long runs this is fine (note it in ops). |
| **§6.4** | Durable terminal incl. domain side-effect (publish) | P1 "false Done" (reload before publish); P7 "publish-done invisible"; §7 needs "the place was published", not "turn ended" | `ToolDispatchWorkflow` (`packages/runtime/src/unified/subscribers/permission-and-tool.ts`): `idempotencyKey:(p)=>p.toolUseId`, durable `ToolDispatchResult{toolUseId,resultJson}`, relays a `ToolResult` event back to the session. Tool-result is observable via the agent-output projection (`_tag:"ToolUse"` then result). | **HAVE** (substrate); **PARTIAL** (typed projection) | missing-projection | Model `publish` as an **MCP tool the agent calls** → its `ToolDispatchWorkflow` result **is** the durable "published" terminal, distinct from `prompt.completed`. This is the clean claimed-work answer. Optional polish: a dedicated `sideEffect.published` typed projection. See Part B-3 / C-3. |
| **§6.4-terminal** | First-terminal-wins; pause≠done | P1 distinguish "paused to ask publish?" from "done" | Agent-output is a **typed union**: `TurnComplete`, `Terminated`, `Error`, and crucially `PermissionRequest` are distinct `_tag`s (`RuntimeAgentOutputObservationSchema`). Channel completion has a first-class `terminal` vs `acknowledgement` contract (`ChannelRouteCompletion`, `RouteCompletionReceipt = Done|Rejected`). | **HAVE** (substrate) | — | The "false Done" was a *client heuristic* bug (`promptRunning` flicker). The substrate already emits a typed `PermissionRequest` event the client can see *instead of* inferring completion. No gap. |
| **§6.5** | Steering: observe + resolve required-actions over poll | §4 P6 "steering impossible"; §7 prompt-wrap hack→`permission.requested`/`resolved`; "async→session bridge" | `wait.forPermissionRequest` (returns `RuntimePermissionRequestObservation{permissionRequestId,options}`) + `permissions.respond({permissionRequestId,decision})` / `respondScoped`. Redirect = another `promptScoped` into the same session. Backed by `PermissionRoundtripWorkflow` + `SessionPermissionChannel`. | **HAVE** (substrate) | — *(delivery rides G1)* | Steering is the *same* append-intent + observe-projection shape. Observe via the permission projection stream; resolve via an append. No new mechanism; rides the §5.6/§5.2 transport + G1 token. |
| **§6.6** | Scoped, durable, revocable capability token (single Bearer) | §5 "single Bearer from `HttpService:GetSecret`"; today OpenACP master api-secret = full-admin (unacceptable) | durable-streams **§12.1: auth/authz EXPLICITLY OUT OF SCOPE** — "no inherent per-stream scoping for reads; access control is the implementer's responsibility." `Authorization: Bearer` is reserved by the protocol for callbacks/pull-wake but there is **no per-stream read/append scoping**. `FiregridHost` only threads `headers` host→durable-streams. | **GAP** | **missing-token** | **THE real new surface (G1).** Build a thin auth/scoping layer: token → set of allowed **opaque** stream-handles (append-to-session-X-intent + read-session-X-projections). See Part C-4. |
| **§6.7** | Multi-tenant isolation (many games) | §6.7 per-game scoped stream/session namespace | `FiregridHost({namespace})` prefixes every durable stream (`${namespace}.firegrid.*`). Session identity isolation via `externalKey{source,id}` → deterministic `ctx_ext_*` id. | **HAVE** (substrate, coarse) | (enforcement rides G1) | Namespace gives the stream-prefix boundary; *enforcement* of "game X can only touch game X" is the token's scope (G1). Substrate provides the partition; the token provides the guard. |
| **§6.8** | ACP adapter (OpenACP/Claude-via-ACP plugs in) | §6.8 / §7 "OpenACP daemon"→"ACP adapter under the runtime" | `FiregridHost({codec:"acp"})` → `ProductionCodecAdapterLive` → `AcpSessionLive`. MCP reach proven: codex-acp + claude-agent-acp both run a full turn and call a Firegrid `schedule_me` MCP tool through unmodified `AcpSessionLive` (`claudeAgentAcpMeta` `alwaysLoad` coax is the only per-dialect code). | **HAVE** | — | Keep OpenACP/Claude **as the ACP agent**; Firegrid's runtime replaces OpenACP's *daemon/relay* role. No gap. |

### §4 pains → disposition (one-glance)

| Pain | Disposition |
|---|---|
| **P1** false "Done!" | **Closed.** Typed `PermissionRequest` vs `TurnComplete`/`Terminated` events + `terminal` completion contract. Client stops inferring from `promptRunning`. |
| **P2** two tunnels | **Closed by transport + G1.** durable-streams is one URL for append+read. |
| **P3** relay tails internal file | **Closed.** The kid-friendly transcript is a **projection fold** over the agent-output stream (`text→💬`, `Edit→🔧`, `publish→🚀`). Rebuildable, not a file tail. Can live host-side (a declared projection) or client-side. |
| **P4** no idempotency | **Closed.** producer-fence §5.2.1 + `createOrLoad` + prompt `idempotencyKey`. |
| **P5** no restart safety | **Closed.** Durable streams + resume-by-persisted-offset (`Stream-Next-Offset`). |
| **P6** steering impossible | **Closed.** `wait.forPermissionRequest` + `permissions.respond` + `promptScoped`. |
| **P7** publish invisible | **Closed (buildable).** publish-as-MCP-tool → `ToolDispatchWorkflow` durable terminal (G2). |

---

## 3. Part B — Suggested implementations (buildable on the substrate TODAY)

The Brookhaven loop, end-to-end, using current SDK symbols. *All code is illustrative.*

### B-1. Host composition — a Brookhaven `FiregridHost`

One host process per Brookhaven deployment, `codec:"acp"` so OpenACP/Claude plugs in as the ACP
agent, `namespace` per environment for tenant isolation, and a **real tool executor** so the
`publish` MCP tool does the Roblox Open Cloud publish.

```ts
// illustrative — packages/runtime/src/unified/host.ts shape
const BrookhavenHost = FiregridHost({
  durableStreamsBaseUrl: "https://durable-streams.brookhaven.internal",
  namespace: "brookhaven.prod",          // §6.7 tenant partition: brookhaven.prod.firegrid.*
  codec: "acp",                          // §6.8 → ProductionCodecAdapterLive → AcpSessionLive
  headers: { Authorization: `Bearer ${HOST_DS_TOKEN}` }, // host→durable-streams (NOT the kid token)
  // env policy authorizes the Roblox Open Cloud API key binding for the publish executor:
  envPolicy: RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["ROBLOX_OPEN_CLOUD_KEY", "HOST_ROBLOX_OPEN_CLOUD_KEY"]],
    lookupEnv: (n) => process.env[n],
  }),
  // real executor: handles the `publish` tool (Roblox Open Cloud) — see B-3:
  toolExecutor: BrookhavenToolExecutorLive,
})
```

What this gets for free (from `host.ts`): `RuntimeControlPlaneTable`, `RuntimeOutputTable`,
`SignalTable`, `UnifiedTable`, the six workflow Lives (incl. `ToolDispatchWorkflow`,
`PermissionRoundtripWorkflow`, `RuntimeContextSessionWorkflow`), the channel bindings
(`UnifiedChannelBindingsLive` + signaling overrides), and `JournalObserverLive`.

**Channels in play** (`host-control.ts` / `session-*.ts`): `host.prompt` / `session.prompt`
(intent in), `session.agent_output` (progress + tool-use/result out), permission
(`host.permissions.respond` / `session.permissions.respond`), and the **read-side** projection the
client polls. (Note: `host.context.snapshot` / `host.session.snapshot` / `session.lifecycle` are
declared but **stubbed** today — see §5 risk note; the agent-output projection is the live one.)

### B-2. Client-SDK verbs — the loop on the public surface

`FiregridClientOperations` (operations.ts) is the whole vocabulary. The in-game flow maps 1:1:

```ts
// illustrative — what a non-constrained client does in-process;
// the Roblox edge does the SAME semantics over HTTP (Part C-1/C-2).

// 1. Kid taps Build — idempotent create + idempotent prompt:
const handle = yield* sessions.createOrLoad({
  externalKey: { source: "brookhaven.game", id: `${gameSessionId}:${playerId}` },
  runtime: brookhavenAcpRuntime,         // agentProtocol:"acp", mcpServers incl. publish (B-3)
})
yield* sessions.promptScoped({           // idempotencyKey = requestId  → P4 closed
  payload: { text: "add a helipad" },
  idempotencyKey: requestId,
})

// 2. Live progress feed (P3) — cursor poll, gap-free:
let cursor = 0
while (running) {
  const r = yield* wait.forAgentOutput({ afterSequence: cursor, timeoutMs: 1500 })
  if (r.matched) { cursor = r.output.sequence; render(fold(r.output)) } // text→💬 Edit→🔧 publish→🚀
}

// 3. Steering (P6) — observe a question, answer it (same shape):
const q = yield* wait.forPermissionRequest({ afterSequence: cursor })
if (q.matched) yield* permissions.respond({
  permissionRequestId: q.request.permissionRequestId,
  decision: { _tag: "Allow", optionId: q.request.options[0].optionId },
})

// 4. Terminal discrimination (P1) — a typed PermissionRequest event is NOT a TurnComplete.
//    The client reloads on the PUBLISH terminal (B-3), not on a promptRunning flicker.
```

### B-3. The publish side-effect as an MCP tool with its own durable terminal (G2 / §6.4)

This is **the clean Firegrid-native answer to "a claimed-work side effect with its own terminal."**
Don't infer "published" from a chunk — make the agent *call a tool*, and let the tool's durable
result be the terminal the client observes.

1. **Declare** `publish` like any agent tool (`agent-tools/schema.ts` pattern, `firegridProjection`
   annotation), bound via the host-owned runtime-context MCP server
   (`firegridRuntimeContextMcpName` + `RuntimeContextMcpMarkerSchema` — the URL-less marker the
   host fills in; `mcpServers` stays client-owned end-to-end).

```ts
// illustrative
export const PublishToolInputSchema = Schema.Struct({
  placeId: Schema.String, versionNote: Schema.optional(Schema.String),
}).annotations({ identifier: "brookhaven.agentTool.publish.input",
  ...firegridProjection({ operationId: "publish", toolName: "publish" }) })
export const PublishToolOutputSchema = Schema.Struct({
  published: Schema.Literal(true), publishedVersion: Schema.Number, buildSha: Schema.String,
})
```

2. **Agent calls `publish`** → `ProductionCodecAdapterLive` routes the ACP `ToolUse` →
   `ToolDispatchWorkflow` (idempotencyKey = `toolUseId`, so the Open Cloud publish is **at-most-once
   across restarts**) → `BrookhavenToolExecutorLive.execute` runs the Roblox Open Cloud publish →
   returns `{published:true, publishedVersion, buildSha}`.

3. **Durable terminal** = the `ToolDispatchResult`, relayed as a `ToolResult` agent-output event.
   The client sees, in its existing agent-output poll, a `ToolUse(name:"publish")` followed by its
   result carrying `buildSha` — and reloads players **at that instant**, comparing `buildSha` to the
   stamp on the server they land on (the RFC's existing re-hop mechanic, now driven by a *durable*
   terminal instead of a heuristic). P1 + P7 closed.

> Why an MCP tool and not a chunk: `ToolDispatchWorkflow` gives **idempotency
> (`idempotencyKey=toolUseId`)** and a **durable, replayable result**, so a host restart mid-publish
> doesn't double-publish and doesn't lose the terminal. A custom chunk has neither.

### B-4. The thin edge for the constrained client — durable-streams-direct (no gateway)

The Roblox server (`HttpService:RequestAsync`, poll-only, one Bearer) talks **directly to
durable-streams**, which is already the HTTP append+cursor-read server. The host observes the
intent stream and writes the projection streams; the client never touches a channel router, the
ACP transport, or a substrate table by name.

```
Roblox server  ──POST {append-handle}  (prompt intent; Producer-Id/-Seq = idempotency)──►  durable-streams
   (one Bearer)                                                                              │
               ◄──GET {progress-handle}?offset=<cursor>  → Stream-Next-Offset────────────────┘
   poll loop:  GET {progress-handle} / {permission-handle} / {terminal-handle} with persisted offsets

   [ thin auth/scoping layer validates the Bearer and resolves opaque handles → scoped DS stream URLs ]
        ▲ this is the ONLY new surface (G1 / Part C-4) — it is NOT a gateway, it is an auth proxy
```

Host side needs one small **additive observer** (sibling to `JournalObserverLive` /
`buildWebhookFactObserverLayer`): tail each session's intent stream and translate appends →
`SessionPromptChannel` / `session.permissions.respond` dispatch. That bridges the poll-only append
to the existing in-process channel. Additive, not substrate surgery.

---

## 4. Part C — Proposed APIs with alternatives (decision-grade)

Constraints applied to **every** proposal:
- **Channel litmus** (core.ts): edge-crossing + indirection + a direction/completion contract.
- **Airgap** (§11.2): the client addresses **opaque channel-target / stream handles only** — never
  raw substrate table or stream names; no enumeration; no substrate leak.
- **Misuse-resistance** (`[[project_misuse_resistance_proof]]` / tf-r06u.27 §9): illegal states
  unrepresentable; substrate symbols stay off the client surface. *(Known live gap to respect:
  `FiregridChannelsClient.send/call/waitFor` are `(target:string, payload:unknown)` — direction/
  payload not type-enforced. New edge contracts must not widen that hole.)*
- Framed as **additive projection/edge over the existing substrate** wherever possible. Any
  proposal needing a **new substrate primitive** is flagged loudly. *(None do.)*

### C-1. Poll-HTTP ingress — **durable-streams IS the ingress (no gateway)**

**Recommendation: (a) durable-streams-direct + scoped token + opaque handles.**

| Option | What | Trade-offs |
|---|---|---|
| **(a) durable-streams-direct + scoped-token + opaque-handles** ✅ | Client appends/reads **directly** against durable-streams' existing `POST`/`GET ?offset=` API; a thin auth layer (C-4) maps the Bearer → allowed opaque handles. | **+** Substrate stays the one read/append authority; zero new request/response surface; no extra hop; offsets+producer-fence reused verbatim. **+** Fewest edges = smallest airgap surface. **−** Requires the C-4 scoping layer (which we need regardless). |
| **(b) thin Firegrid HTTP gateway** ⛔ | A new Firegrid edge that re-projects channels to HTTP. | **−** Proliferates edges; **duplicates** durable-streams' offset/idempotency semantics; **more** airgap surface to police; another stateful hop to make restart-safe. **Steer away.** |
| **(c) extend client-sdk with an HTTP transport** | Teach `@firegrid/client-sdk` to speak HTTP so the same verbs work remotely. | **−** client-sdk is Effect/in-process today; an HTTP transport is a large surface and still needs C-4 auth. Useful *later* for non-Roblox edge clients, but overkill for a poll-only game server. |

**Airgap resolution (the load-bearing question): does reading durable-streams directly leak the
substrate?** *No — if and only if handles are opaque and token-scoped.* The client is handed
`{append: "h_op4...", progress: "h_7gz...", permission: "h_k2q...", terminal: "h_9wd..."}` — capability
handles, **not** `…/v1/stream/brookhaven.prod.firegrid.runtimeOutput`. It cannot enumerate, cannot
derive sibling streams, cannot reach the control plane. **§11.2 "no direct agent transport" still
holds**: durable-streams is the durable **log**, not the agent (ACP/stdio) transport — the agent
stays behind the host. The log is the *public projection*; the transport is *private*. Resolution
holds ⇒ **durable-streams is the single ingress; build no gateway.** Only if opaque-handle scoping
proved impossible would (b) re-enter consideration.

**Litmus check (a):** edge-crossing (Roblox cloud → durable-streams over a tunnel) ✓; indirection
(opaque handle → scoped stream URL, resolved by the auth layer) ✓; direction/completion (append =
acknowledgement via `Stream-Next-Offset`; terminal = the publish tool-result row) ✓.

### C-2. Cursor-poll projection read contract — **already exists; use §5.6 catch-up**

**Recommendation: (a) the existing durable-streams catch-up read, one projection stream per
session/prompt. No new contract.**

The RFC-§6.3 ask `GET changes(projection, scopeKey, sinceCursor)` **is** the durable-streams §5.6
catch-up read: `offset`=`sinceCursor`, the per-session/per-prompt **stream**=`projection`+`scopeKey`,
`Stream-Next-Offset`=the next cursor. The §10.4 guarantees are native (monotonic + lexicographically
ordered + gap-free within a stream + resume-by-persisted-offset).

| Option | What | Trade-offs |
|---|---|---|
| **(a) plain catch-up `GET ?offset=`** ✅ | Discrete request/response; client persists `Stream-Next-Offset` and re-polls. | **+** Exactly Roblox's model (short request/response, no long-lived connection). **+** No-gap/ordering free. **+** Subscription-equivalent. **−** Polling latency (fine: RFC tolerance is "seconds"). |
| **(b) long-poll `?live=long-poll` (§5.7)** | Server holds the request until data or timeout (`200`/`204`). | **−** RFC explicitly flagged long-poll risky vs `HttpService` request timeouts. Use only if catch-up latency proves too high; even then, short server timeouts. |
| **(c) SSE `?live=sse` (§5.8)** ⛔ | Streaming `text/event-stream`. | **−** Roblox **cannot** consume SSE. Unusable. |

**Per-prompt filtering** = give each session (or each prompt, if finer) its **own** projection
stream, so "filtered" is structural (you read *that* stream), not a query predicate. Three handles
suffice: progress (chunks/tool-use), permission (required-actions), terminal (prompt-completed +
publish). **Caveat to document:** durable-streams retention → `410 Gone` if a client reads before the
retention window; for ~1–5 min runs this is a non-issue, but the edge must treat `410` as "resync
from a fresh snapshot/handle," not a hard error.

**This closes the platform RFC §10.4 open question:** poll-only does **not** require a subscription
transport — catch-up offset reads are subscription-equivalent for no-gap + ordering.

**Litmus check (a):** edge-crossing ✓; indirection (opaque progress-handle → scoped stream) ✓;
direction (ingress/read) + completion (the terminal-handle stream carries the `Done`-shaped publish
terminal) ✓.

### C-3. Domain side-effect terminal (publish) — **MCP-tool-with-durable-result**

**Recommendation: (a) publish-as-MCP-tool → `ToolDispatchWorkflow` durable terminal** (detailed in
B-3).

| Option | What | Trade-offs |
|---|---|---|
| **(a) MCP tool → `ToolDispatchWorkflow` terminal** ✅ | Agent *calls* `publish`; the durable tool-result is the terminal, observed in the agent-output projection. | **+** Reuses an existing durable, idempotent (`idempotencyKey=toolUseId`) workflow. **+** Side-effect is *agent-driven and replay-safe* (no double-publish on restart). **+** Distinct from `prompt.completed` by construction. **−** Client must read tool-result events (already in the progress poll). |
| **(b) dedicated `sideEffect.published` channel** | A new typed channel/projection for publish terminals. | **+** Cleanest typed client surface (a single dedicated handle). **−** New channel + binding + observer to maintain; only justified if many distinct side-effects need first-class terminals. Reasonable **polish** on top of (a): a projection that folds publish tool-results into a typed `published` stream. |
| **(c) peer-event / webhook fact** | Open Cloud publish completion arrives as a verified webhook fact (`buildWebhookFactObserverLayer`). | **−** Inverts ownership: the side-effect is the agent's claimed work, not an external event; routing it back through a webhook adds latency + a second trust boundary. Use only if publish is performed by an *external* system Firegrid doesn't drive. |

**Why (a) over (b)/(c):** the publish is *claimed work the agent performs*; `ToolDispatchWorkflow`
already gives the claim + idempotency + durable terminal. (b) is additive polish; (c) is the wrong
ownership shape. **No new substrate primitive** — (a) is pure reuse.

**Litmus check (a):** edge-crossing (host → Roblox Open Cloud) ✓; indirection (agent → MCP tool →
dispatch workflow → executor) ✓; **completion = `terminal`** (`ToolDispatchResult` is the
`Done`-shaped receipt) ✓. **Misuse-resistance:** the publish key is an `envBinding` resolved by
`RuntimeEnvResolverPolicy` (deny-by-default), never on the client surface.

### C-4. Scoped/revocable capability token — **THE real new surface (G1)**

durable-streams §12.1 leaves auth/authz to the implementer: transport + ordering are free, **per-
stream scoping is genuinely missing.** This is the one thing to build. Propose a **thin auth/scoping
layer** that maps a single Bearer → a set of **allowed opaque stream-handles** + verbs, sitting in
front of durable-streams reads/appends. **Not a gateway** (no business logic, no re-projection) —
an authorizing reverse-proxy / handle resolver.

**Token/role model (recommended):** a Firegrid-issued, signed, expiring capability token whose
claims are a closed set of `(opaque-handle, verb)` grants:

```jsonc
// illustrative token claims — scoped to ONE game session
{
  "iss": "firegrid.brookhaven.prod",
  "sub": "game:<gameSessionId>:player:<playerId>",
  "exp": 1735690000,                      // short-lived; revocable by rotation/denylist
  "grants": [
    { "handle": "h_op4...", "verb": "append" },   // → session-X prompt-intent stream
    { "handle": "h_k2q...", "verb": "append" },    // → session-X permission-response stream
    { "handle": "h_7gz...", "verb": "read" },      // → session-X progress projection
    { "handle": "h_pr1...", "verb": "read" },      // → session-X permission projection
    { "handle": "h_9wd...", "verb": "read" }        // → session-X terminal projection
  ]
}
// handles are OPAQUE: the layer maps handle→{namespace}.firegrid.* stream URL server-side.
// the client cannot enumerate, cannot reach the control plane, cannot derive siblings.
```

| Option | What | Trade-offs |
|---|---|---|
| **(a) Firegrid-issued scoped stream tokens + thin auth-proxy that validates+scopes** ✅ | Firegrid mints the token + handle map; a thin proxy validates the Bearer, resolves opaque handles → scoped DS URLs, forwards. | **+** Keeps durable-streams unmodified (respects §12.1's "implementer's responsibility"). **+** Centralizes revocation/rotation. **+** Opaque handles = airgap by construction. **−** One small new service to run + secure. |
| **(b) durable-streams gains pluggable per-stream auth** | Push scoping *into* durable-streams via an auth plugin. | **+** No extra hop. **−** Requires changing the substrate dependency; couples Firegrid's authz to durable-streams' release cycle; §12.1 deliberately keeps it out. Pursue only if upstream wants it. |
| **(c) capability-bearing signed stream-handle** | The handle itself is a signed token (handle = capability); no separate Bearer. | **+** Elegant; stateless validation; per-handle revocation = per-capability. **−** Revoking *all* of a session's access = revoke N handles; harder bulk-revoke than (a)'s single `sub`. Good as the *handle encoding* **under** (a). |

**Recommendation:** (a) as the layer, optionally encoding handles per (c). Reject (b) for v1 (don't
fork the substrate's deliberate scope boundary).

**Misuse-resistance (tf-r06u.27 §9):** illegal states unrepresentable — a token literally cannot
express "read game Y" because Y's handles aren't in its closed `grants` set; there is no admin/
wildcard grant shape; verbs are a closed `append|read` enum (no "delete"/"close" exposed). The
client surface stays handles+verbs; **no substrate symbol, no raw stream name, no channel-router
Tag** ever crosses to the edge. This *narrows* the existing `(string,unknown)` channel-facade hole
rather than widening it: the edge contract is `(opaqueHandle, verb)`, both from closed sets.

**Litmus check (a):** edge-crossing (untrusted Roblox client → trusted substrate) ✓; indirection
(opaque handle → scoped stream URL, the whole point) ✓; direction/completion (per-verb: append→ack,
read→cursored projection) ✓.

**Substrate-primitive flag:** **None required.** Namespace partitioning + per-session streams
already exist; this is an *authorization projection* over them. The only genuinely new *code* is the
auth-proxy + token issuance — an edge component, not a durable-substrate primitive.

---

## 5. Substrate-sufficiency verdict + risks

**Verdict: the durable substrate is sufficient for Brookhaven. The work is concentrated at the
edge-auth layer, plus two small additive host pieces — no new substrate primitive.**

What is **substrate-sufficient today** (no change): idempotent append (producer-fence + createOrLoad
+ prompt idempotencyKey), cursor-poll reads (§5.6 catch-up = §6.3 ask), §10.4 no-gap/ordering
(native to offsets), terminal discrimination (typed agent-output union + completion contract),
steering (permission wait/respond + promptScoped), restart-safety (durable streams + offset resume),
multi-tenancy partition (namespace + externalKey), ACP agent (codec:"acp", proven).

What must be **built** (all additive, edge/host — none touch substrate primitives):
1. **G1 — the auth/scoping token + thin auth-proxy + opaque handle resolution** (Part C-4). *The
   real new surface.* durable-streams §12.1 leaves this to us.
2. **A host-side intent-stream observer** (Part B-4) bridging poll-only appends → existing
   `SessionPromptChannel` / permission channels. Sibling to `JournalObserverLive`.
3. **The `publish` MCP tool + a real `ToolExecutor`** (Part B-3 / C-3). Reuses
   `ToolDispatchWorkflow`; optional `sideEffect.published` projection as polish.

**Risks / caveats to surface loudly:**
- **Stubbed read-side channels.** `host.context.snapshot`, `host.session.snapshot`, and
  `session.lifecycle` are **declared but stubbed** in `channel-bindings.ts` (return empty arrays /
  `Stream.empty`); `makeHostControlSnapshot` logic exists but is **not wired**. Brookhaven's live
  feed should ride the **agent-output projection** (which is real), not the snapshot channels, until
  those are wired. *This is a `missing-projection` to track — but it's projection-wiring over an
  existing `RuntimeOutputTable`, not a substrate gap.*
- **Retention → `410 Gone`** (§5.6): the edge must treat `410` as "resync from a fresh handle," not
  a fatal error. Fine for minutes-long runs; document it.
- **Channel-facade direction-typing hole** (tf-r06u.27): `send/call/waitFor` are `(string,unknown)`.
  The C-1/C-4 edge contracts use closed `(opaqueHandle, verb)` sets — do not regress to stringly-
  typed payloads at the edge.
- **Long-poll (§5.7) is a trap for Roblox** re `HttpService` timeouts; **SSE (§5.8) is unusable.**
  Recommend plain catch-up reads only.

---

## 6. Alignment notes

- **Answers platform RFC §10.4** (open question): poll-only is a **first-class profile**; the
  canonical cursor-poll read contract is the durable-streams **§5.6 catch-up read** over a
  per-session/per-prompt projection stream — subscription-equivalent, no subscription transport
  required.
- **Consumer-shape alignment:** Brookhaven is another constrained-consumer shape alongside the
  Fireline/Flamecast consumers in the platform RFC internals — same substrate-as-read-authority
  pattern (the durable log is the single source of truth; edges are thin auth/transport adapters,
  not stateful proxies). The lesson generalizes: **scope, don't gateway.**
- **§11.2 preserved:** the client reads the durable **log** (public projection), never the agent
  **transport** (private ACP/stdio behind the host). Opaque handles + scoped token keep the airgap
  intact while still giving the kid a single Bearer and one tunnel.
