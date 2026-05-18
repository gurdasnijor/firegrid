# SDD: MCP Route + URL Lifecycle in the Client/Host Model

Status: RATIFIED 2026-05-18 (Gurdas/coordinator: Reading 2, Option A).
Implementation design appended as Amendment 1. Framing body (§0–§6)
is preserved as the decision record; the binding implementation
contract is Amendment 1.
Created: 2026-05-18
Owner: Firegrid Client SDK / Host SDK boundary
Scope: extends `SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY_IMPLEMENTATION.md`
(the #332 implementation transaction). This is the resolution of that
SDD's open MCP-lifecycle question (Framing Question 4 / TFIND-038
`mcpServers` carriage), not a separate workstream. Tracks TFIND-048.

---

## §0 — The load-bearing question (read this first)

The #332 implementation SDD says `PublicLaunchRuntimeIntentSchema`
already carries `mcpServers`, and that the host must "preserve those
fields through `RuntimeContextRequestRow` and into
`normalizeRuntimeIntent()`". It does **not** say **who builds the
concrete `contextId`-scoped MCP URL, and when**. That hole is the whole
of TFIND-048. It surfaced because the option-3 Codex ACP migration
(`surface:33`) hit it, did not paper it, and paused.

**The binary Gurdas decides at signoff:**

- **Reading 1 — helper-missing (cat-2, small fix).** The client-SDK
  simply lacks a public export. Re-export `sessionContextIdForExternalKey`
  from `@firegrid/client-sdk`; the consumer derives `contextId`
  pre-`createOrLoad`, builds the concrete
  `/mcp/runtime-context/:contextId` URL itself, and embeds it in the
  intent. Mirrors what the CLI already does internally. Smallest diff;
  unblocks Codex ACP immediately.

- **Reading 2 — design-smell (architectural).** A client baking a
  concrete `contextId`-scoped MCP URL into the intent *before*
  `createOrLoad` is the consumer predicting `createOrLoad`'s output
  **and** the host's listener topology. The **host owns the MCP server**
  (the listener address and the `/mcp/runtime-context/:contextId`
  route); the host should **derive and deliver** the concrete URL
  *after* it materializes the context, at start time, when it spawns
  the agent. Re-exporting the helper would canonize the backwards
  lifecycle and is the wrong abstraction. The client should express
  "this runtime needs the Firegrid runtime-context MCP server" *without*
  a concrete URL or a final `contextId`.

**Coordinator recommendation: Reading 2.** The evidence below
(§2) shows the client in the #332 model structurally cannot know the
host's MCP listener address — re-export solves only the id half, never
the address half, and locks in a lifecycle where the client predicts
host-owned facts. Reading 1 is presented fairly in §3/§4; **Gurdas owns
the decision at the framing signoff. The coordinator only recommends.**

**The deeper question this SDD must answer (the real §0):**

> In the #332 model — client writes a durable
> `RuntimeContextRequestRow`; a host-side reconciler materializes and
> starts the context later, possibly in a different process — **how
> does the client express "this runtime needs MCP" without a concrete
> URL or final `contextId`, and how/when does the host derive the
> concrete `contextId`-scoped MCP URL post-materialization and deliver
> it to the agent process?**

§4 lays out concrete options for that question (host-provisioned URL
delivered post-materialization vs. client URL-pattern + host
resolution vs. other), their tradeoffs, and the recommendation.

**Not in question.** `sessionContextIdForExternalKey`
(`packages/protocol/src/session-facade/schema.ts:482`) is a sound
deterministic primitive: canonical-JSON of `[source, id]` →
`ctx_ext_<base64url>`, pure, total. Its determinism exists so client
and host can *independently reconcile on the same id*. The smell is the
**URL lifecycle**, not the id derivation. No option here impugns or
changes that primitive.

---

## §1 — Why this is a #332 extension, not a new workstream

#332 (`SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY_IMPLEMENTATION.md`)
established:

- Client `sessions.createOrLoad()` computes `contextId` with
  `sessionContextIdForExternalKey`, writes a `RuntimeContextRequestRow`
  carrying the full `PublicLaunchRuntimeIntent` (incl. `mcpServers`),
  and **drops `CurrentHostSession`** — the client no longer materializes
  or binds the context.
- A host-side reconciler (`control-request-reconciler.ts`) materializes
  the bound context later, then `startRuntime({ contextId })` runs it.
  Materialization and start are **host-owned and time-separated from the
  client write**, possibly in a different process.

#332 Framing Question 4 explicitly defers: *"confirm the public runtime
intent shape that must fit inside `RuntimeContextRequestRow` for
ACP/MCP configurations."* For non-MCP runtimes the carried intent is
self-contained. For MCP it is **not**: the agent needs a concrete URL
whose authority (listener host/port) is created by the host *after* the
client write. TFIND-048 is that unresolved sub-question. Its resolution
is a section of / amendment to the #332 transaction, sequenced into the
same protocol/host/client/tiny-firegrid changes — not a parallel SDD
with its own merge.

---

## §2 — Verified root (Explore, file:line on origin/main 4c4899352)

**The host owns a context-agnostic MCP server; the route param is the
authority, resolved at tool-call time.**

- `packages/host-sdk/src/host/mcp-host.ts:1-26` — one host-owned
  loopback listener mounts Effect AI's MCP HTTP protocol at
  `/mcp/runtime-context/:contextId`. The route parameter "is the
  request authority; it is not an env var and not a tool argument."
- `mcp-host.ts:106-135` — `FiregridMcpRouteContextLayer.resolve` reads
  `HttpRouter.params` **per request** and calls
  `requireLocalContext(contextId)` at tool-call time. There is **no
  per-context provisioning** and no pre-registration: one listener
  serves any `contextId` the route carries. The concrete URL is purely
  `(host MCP listener address) + /runtime-context/ + <contextId>`.
- `FiregridMcpServerListenerConfig` (`mcp-host.ts:~70-95`) defaults
  `FIREGRID_MCP_PORT=0` — an **OS-chosen port**. The listener address
  is not knowable until the host has bound the socket.

**The production CLI derives `contextId` pre-`createOrLoad` and bakes a
concrete URL — but only because the CLI is itself the host.**

- `cli/src/bin/run.ts:208-219` — comment: "contextId is derived
  deterministically from the externalKey … which the caller needs
  up-front for MCP URL injection." `cliContextId` =
  `sessionContextIdForExternalKey`.
- `run.ts:341-348` `mcpUrl(address, path, contextId)` and
  `run.ts:379-382` `injectLaunchMcpDeclaration(config.runConfig,
  firegridRuntimeContextMcpDeclaration(mcpUrl(address, …, contextId)))`
  — the concrete URL is injected into the runConfig *before* the agent
  spawns.
- **Crucially** `run.ts:404-440` `hostMcpLayer` mounts
  `FiregridMcpServerLayer(...)` **in the CLI process** and only then
  reads `HttpServer.addressFormattedWith(...)` to learn `address`. The
  CLI can bake the URL pre-`createOrLoad` **only because it is a
  co-located host+client and owns the listener address**. `address` is
  a host-owned fact the CLI has *because it is the host*, not because a
  client can compute it.

**The Codex ACP fixture is uniquely test-fixture-shaped.**

- `tiny-firegrid/src/configurations/codex-acp-tool-call-pipeline.ts:22-36`
  — `codexAcpToolCallMcpUrl({host, port, path, contextId})` builds the
  concrete URL from caller-supplied host/port.
- `test/codex-acp-tool-call-pipeline.test.ts:374-392` — the test
  reserves the port itself (`reserveLoopbackPort()`), derives
  `contextId = sessionContextIdForExternalKey(externalKey)`, builds the
  URL, and embeds it — all **before** the context exists, with the test
  orchestrator playing **both** host and client and pre-allocating the
  port the host will bind. No other tiny-firegrid configuration
  (durable-streams, stdio-jsonl, output-journal) uses MCP or pre-derives
  a context-scoped URL. Codex ACP is the only one.

**The boundary SDDs are silent on the seam.**

- `SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md:49-95` ("client writes
  intent, host materializes") names no owner for the concrete
  `contextId`-scoped MCP URL.
- `SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY_IMPLEMENTATION.md` carries
  `mcpServers` through the row but never resolves the URL authority.

**Net:** the determinism primitive solves the *`contextId`* half. It
does nothing for the *listener-address* half, which is host-owned and
(with `port: 0`) not even knowable until the host binds. A distributed
#332 client is **not** the host and cannot stand in for the CLI's
co-located shortcut.

---

## §3 — Reading 1 in full (presented fairly)

**Mechanism.** Add `sessionContextIdForExternalKey` (and a small URL
helper) to the public `@firegrid/client-sdk` surface. The MCP consumer:
derives `contextId` from its `externalKey`; builds
`http://<mcpHost>:<mcpPort>/mcp/runtime-context/<contextId>`; injects it
into `mcpServers` / the runtime-context MCP declaration in the intent;
calls `createOrLoad`. The host materializes and starts; the baked URL
rides through unchanged.

**Honest strengths.**

- Smallest possible diff; one re-export plus a URL builder.
- Unblocks Codex ACP immediately with no protocol or reconciler change.
- It is *exactly* what the production CLI does internally today, so
  there is a working precedent in-tree.
- The primitive is genuinely sound and genuinely deterministic — the
  client *can* compute the `contextId` correctly.

**Why the coordinator recommends against it.**

- It only solves the `contextId` half. The consumer must still supply
  `<mcpHost>:<mcpPort>` — host-owned listener facts. With the default
  `FIREGRID_MCP_PORT=0` the port does not exist until the host binds.
  The CLI escapes this *only* because it is the host and reads its own
  bound address; a separated #332 client cannot.
- It canonizes the client predicting two host-owned outputs
  (`createOrLoad`'s materialization *and* the host's listener
  topology), then having the host honor the prediction. That is the
  backwards lifecycle TFIND-048 names. The "missing helper" framing
  hides an architectural commitment behind a one-line export.
- It makes every MCP consumer hard-code or out-of-band-discover the
  host MCP address, re-deriving the fragile fixture shape in product
  code and forcing fixed ports (losing `port: 0`).
- Re-export is irreversible API surface: once public, the predicted-URL
  lifecycle is the supported contract.

Reading 1 is the right call **only if** Gurdas decides the client is
always co-located with (and authoritative over) the host MCP listener —
i.e. the CLI's co-located shortcut is the *intended general model*, not
an exception. That is a product/architecture decision, not a helper
gap, and is exactly what the §0 binary asks Gurdas to rule on.

---

## §4 — Options for the deeper §0 question (Reading 2 space)

All options keep the client write abstract: the client expresses "this
runtime needs the Firegrid runtime-context MCP server" in the intent
**without** a concrete URL and **without needing the final `contextId`
baked into a URL**. They differ in how/when the host produces and
delivers the concrete URL post-materialization.

### Option A — Host-provisioned URL, delivered at start (recommended)

- **Client intent.** `mcpServers` (or a dedicated marker, e.g.
  `firegrid-runtime-context`) carries a *declaration without a URL*:
  "mount the Firegrid runtime-context MCP server for this context."
  No host, no port, no `contextId` interpolation client-side.
- **Host.** When the reconciler materializes the context and
  `startRuntime` spawns the agent, the host *already knows* its own MCP
  listener address (it owns it) and the now-final `contextId`. The host
  resolves the concrete URL with the existing
  `runtimeContextMcpPath` / `mcpUrl` logic and injects it into the
  agent launch via the existing `injectLaunchMcpDeclaration` /
  `firegridRuntimeContextMcpDeclaration` path — the same code the CLI
  uses, moved to the host start surface.
- **Lifecycle.** Client says *what*; host fills *where* at the moment it
  has authority over both halves. The route param remains the
  per-tool-call authority (`mcp-host.ts` unchanged).

Tradeoffs: requires a host start-path change (move URL injection from
CLI-internal to the host `startRuntime` / reconciler boundary) and a
small protocol change (a URL-less MCP marker in the intent). Largest
correctness win: the client never predicts a host-owned fact; `port: 0`
keeps working; Codex ACP and CLI converge on one host-owned mechanism.
Naturally co-sequences into the #332 host-SDK step.

### Option B — Client URL *pattern*, host resolves placeholders

- **Client intent.** Carries a URL *template* with host-owned
  placeholders, e.g.
  `mcp://firegrid-runtime-context/{contextId}` or
  `${FIREGRID_MCP_BASE}/runtime-context/{contextId}`.
- **Host.** At start, substitutes `{contextId}` and the listener base
  from host-owned values.

Tradeoffs: keeps a client-authored shape (familiar to anyone porting
the fixture) while removing the predicted concrete authority. But it
invents a placeholder mini-language and a substitution contract the
host must honor forever; the client still "almost" owns the URL. Weaker
than A — it relocates the smell rather than removing it, and two
templating dialects (env-style vs. brace-style) invite drift.

### Option C — Re-export the helper (this is Reading 1)

Listed here for completeness as the do-the-minimum point in the option
space. Mechanics and tradeoffs in §3. Resolves the `contextId` half
only; leaves the listener-address half to the consumer; canonizes the
predicted-URL lifecycle.

### Option D — Out-of-band host MCP discovery surface

- The host exposes its MCP base address as a durable/queryable fact
  (e.g. a host-info row); MCP consumers read it post-materialization,
  then build the URL with the (sound) deterministic `contextId`.

Tradeoffs: keeps URL assembly consumer-side but removes the prediction
(the address is read, not guessed, and read *after* it exists). Adds a
new public host-info surface and a two-step client dance (write intent →
discover address → ???). The agent still needs the URL at spawn, which
is host-side anyway — so D mostly reduces to A with extra surface area.
Only attractive if non-agent, non-host clients independently need the
MCP base; no evidence today that they do.

### Recommendation

**Option A.** It is the only option where the client never expresses or
predicts a host-owned fact, it preserves `port: 0`, it reuses the
exact CLI URL/injection helpers (moved to the host start boundary), and
it co-sequences cleanly into the #332 host-SDK reconciler/`startRuntime`
step. B and D relocate or partially remove the smell; C (Reading 1)
canonizes it. The deterministic `contextId` primitive remains the
host's reconciliation key — unchanged and uncontested.

---

## §5 — Framing questions for Gurdas (signoff)

1. **The §0 binary.** Reading 1 (client predicts URL; re-export helper)
   or Reading 2 (host derives + delivers URL post-materialization)?
2. If Reading 2: Option **A** (host-provisioned URL at start), **B**
   (client URL-pattern + host placeholder resolution), or **D**
   (out-of-band host MCP discovery)? Coordinator recommends **A**.
3. Confirm the URL-less client intent shape: a field on the existing
   `mcpServers` entry vs. a dedicated `firegrid-runtime-context` marker
   in `PublicLaunchRuntimeIntent`. (Mechanism detail; only the existence
   of a URL-less form is load-bearing for the binary.)
4. Confirm this folds into the #332 implementation transaction
   (protocol intent shape + host start-path injection) rather than
   shipping as an independent PR.

---

## §6 — Open items needing code/experiment (declared, not silent)

These do **not** block the framing decision but are flagged per
"if a §0 sub-question needs code/experiment, say so — that's a finding":

- **F-1 (Option A wiring point).** Confirm whether
  `injectLaunchMcpDeclaration` can be invoked at the host
  `startRuntime` / reconciler boundary with the bound `contextId` and
  the host's own MCP listener address in the #332 process topology
  (CLI co-located vs. separated reconciler host). Architectural intent
  is clear (host owns both halves at start); the exact host-SDK call
  site is an implementation-time verification, owned by the #332
  host-SDK step, not this framing.
- **F-2 (port: 0 in a separated host).** The CLI learns its OS-chosen
  port via in-process `HttpServer.addressFormattedWith`. A standalone
  reconciler host that runs `FiregridMcpServerLayer` must expose its
  bound address to its own start path. Confirm this is intrinsic to the
  host process (it is, under Option A) and not a new cross-process
  channel. Implementation-time, owned by #332 host-SDK.

Neither is a reason to defer §0; both are downstream of choosing
Reading 2 / Option A and belong to the #332 host-SDK implementation
step.

---

## Non-Goals

- No production code in this PR before Gurdas signoff.
- No change to `sessionContextIdForExternalKey` — it is sound and
  uncontested; this SDD does not touch the id derivation.
- No findings-ledger edit in this PR unless the coordinator explicitly
  requests the SDD-only ledger update.
- No independent merge: resolution lands inside the #332 transaction.
- Codex ACP stays paused/unmigrated (no `it.skip`, no escape hatch, no
  protocol reach-past) until this framing is decided and implemented;
  the resumed Codex ACP migration is then the validation. stdio-jsonl
  (no MCP) proceeds independently (#343).

---

# Amendment 1 — RATIFIED implementation contract (Reading 2, Option A)

Ratified 2026-05-18. Binding decision: **Reading 2, Option A —
host-provisioned MCP URL, delivered at start time.** Reading 1
(re-export) is rejected: a separated #332 client structurally cannot
know the host MCP listener address (`FIREGRID_MCP_PORT=0` ⇒ address
does not exist pre-`createOrLoad`); re-export canonizes the backwards
lifecycle. This is a completion of the #332 model (which has since
**landed** at origin/main `4bdc81a838`: `control-request-reconciler.ts`
+ live request rows exist), so this is the TFIND-048 follow-on PR
within the #332 architectural transaction, not a standalone scope.

**Architectural principle (applies to every decision below):** the
public surface MUST NOT let a client express *or predict* a host-owned
fact, even when a co-located path makes it work. The CLI co-located
shortcut is the EXCEPTION, not the model. Where schema/types can
prevent expressing host-owned facts at the client boundary, they
should.

## A1.1 — Condition 1: explicit F-2 answer (co-location)

**Question.** Does the #332 reconciler ALWAYS run co-located in the
same host process that owns the `FiregridMcpServerLayer` listener?

**Answer — two parts; the second is a wrinkle the framing body did not
cover, now specified per Condition 1.**

**(a) Process co-location IS structurally guaranteed for any topology
that mounts an MCP listener.** The only in-tree compositions that mount
`FiregridMcpServerLayer` do so by `Layer.provideMerge`-ing it with the
runtime host that builds the reconciler daemon:

- `packages/cli/src/bin/host.ts:30-43` —
  `FiregridMcpServerLayer({...}).pipe(Layer.provideMerge(runtimeHost))`
  where `runtimeHost = FiregridLocalHostLive(...)` →
  `FiregridRuntimeHostLive` includes
  `RuntimeControlRequestReconcilerDaemonLive`
  (`packages/host-sdk/src/host/layers.ts:251-254`).
- Same pattern: `packages/cli/src/bin/run.ts:423` and
  `packages/tiny-firegrid/src/configurations/codex-acp-tool-call-pipeline.ts:74`.

There is **no** in-tree topology that runs the reconciler in a process
that does not also build the MCP listener. The MCP listener is opt-in
(`FIREGRID_MCP_ENABLED`, default `false`; `host.ts: if (!mcp.enabled)
return runtimeHost`). A host with MCP disabled simply **cannot satisfy
an MCP-requiring context** — that is a legitimate, explicit start
failure (the host cannot honor the URL-less marker), not an Option A
gap. This is the architectural principle in action: the client said
"needs MCP"; a host with no MCP listener fails loudly rather than
fabricate a URL.

**(b) Process co-location ≠ Effect service-environment visibility —
the wrinkle.** In `FiregridMcpServerLayer(A).pipe(Layer.provideMerge(
runtimeHost B))`, `B` (which builds the reconciler daemon) is provided
*to* `A`. `A`'s `HttpServer` (the bound MCP listener address, incl. the
OS-chosen port when `port:0`) is in the **merged output**, but it is
**not** in the reconciler daemon's construction environment — the
reconciler is built inside `B`, which is composed *below* `A`.
`FiregridMcpServerLayer` deliberately `provideMerge`s
`NodeHttpServer.layer` so the bound address is resolvable
(`mcp-host.ts:213-218` comment: "keeps the bound `HttpServer` service
in the output Layer so the host can log its address (or tests can
resolve the OS-chosen port when `port: 0`)") — but only to a consumer
composed *above* it, which the reconciler/`startRuntime` path is not.
So the start path **cannot today require** an MCP-address service; one
must be threaded in. The framing body's Option A assumed "host owns
both halves at start" without specifying this composition gap; F-1/F-2
flagged it; here is the specified resolution.

**Specified mechanism (how the reconciler/start path obtains the bound
address):** introduce a dedicated host-scope service
`FiregridRuntimeContextMcpBaseUrl` (Option-typed — MCP is opt-in),
carrying the resolved MCP base (`scheme://host:boundPort` + base path)
derived from the MCP layer's `HttpServer` at bind time. Publication is
via a host-owned synchronization primitive (`Deferred` /
`SubscriptionRef`) created at the **top binary composition** — the one
point that sees both the MCP layer and the runtime host;
`FiregridMcpServerLayer` fills it on bind, the host start path reads
it. The start path requires it **Option-ally**; absent ⇒ a URL-less
runtime-context-MCP marker in the intent is an **explicit start
failure**, never a silent skip. Co-location remains the only supported
topology and is now *enforced by composition*: the marker is
unsatisfiable unless the address service is in the reconciler's scope,
which only the merged host+MCP composition provides. No cross-process
address discovery is introduced (and none is needed — there is no
split-process topology).

**This wrinkle changes host-SDK layer composition (publication
primitive + start-path dependency + binary wiring). It is
architecturally sensitive and OWNERSHIP-relevant; per the no-self-merge
correctness-bar gate it is surfaced to surface:153 for coordinator
review BEFORE the cross-package production edit — not silently
implemented.**

## A1.2 — Condition 2: Q3 URL-less intent mechanism (chosen)

**Choice: a DEDICATED, URL-less runtime-context-MCP marker on the
runtime intent — NOT a field/sentinel on a generic `mcpServers`
entry.**

Rationale (schema-level enforcement of the architectural principle):

- `McpServerDeclarationSchema`
  (`packages/protocol/src/launch/schema.ts:129-137`) is
  `{ name, server: { type:"url", url: Schema.String, ... } }`. Its
  `url` is **required**. Every `mcpServers` entry is, by type, a
  client-authored concrete URL — `mcpServers` is **client-owned
  end-to-end**.
- The Firegrid runtime-context MCP server's URL authority is
  **host-owned**. Putting a sentinel/optional-url on an `mcpServers`
  entry would make a client-owned schema member carry a host-owned
  fact — invisible at the type level and re-inviting the smell.
- Therefore add a **distinct schema member** to `RuntimeConfigSchema`
  (`schema.ts:160-169`) / `PublicLaunchRuntimeIntent` — e.g.
  `runtimeContextMcp?: { enabled: true }` (final shape an impl
  detail). It has **no `url` slot**: the client type *literally cannot
  carry a URL*, so a client structurally cannot express or predict the
  host-owned fact. "The host owns this one" is visible at the schema
  level, not hidden behind a sentinel.
- `firegridRuntimeContextMcpName` / `firegridRuntimeContextMcpDeclaration`
  / `injectLaunchMcpDeclaration` (`schema.ts:139-150,360-372`) are
  **retained as the host-side concrete-injection helpers**: at start
  the host resolves the concrete URL from
  `FiregridRuntimeContextMcpBaseUrl` + the bound `contextId` and
  produces the concrete `firegrid-runtime-context` `McpServerDeclaration`
  for the spawned agent. The client-side declaration form is removed
  from the client path.

## A1.3 — Condition 3: single injection site (no dual path)

`injectLaunchMcpDeclaration` moves to the **host start path** and is
applied exactly once, host-side, keyed on the URL-less marker, after
the context is materialized and the bound `contextId` + MCP base are
known. The CLI pre-`createOrLoad` injection at
`packages/cli/src/bin/run.ts:379-382` (and the sibling normalized path
at `run.ts:479`, plus the now-dead pre-derived `cliContextId`/`mcpUrl`
plumbing at `run.ts:208-219,341-348` used only for that injection)
**MUST be deleted in the same transaction** — no backwards-compat dual
path. The CLI is just a host program; it receives the concrete URL via
the identical host-side mechanism as every other consumer.

## A1.4 — Condition 4: validation gate (Codex ACP stays paused)

The host-SDK + protocol work is necessary but **not sufficient**. The
implementation is NOT validated until the paused Codex ACP migration
resumes cleanly using **only** the URL-less marker + host-provisioned
URL path, with **no `it.skip`, no `as unknown as`, no protocol
reach-past**. The resumed Codex ACP config+test landing is the
load-bearing proof and lands in the same transaction.

## A1.5 — Implementation plan (folds into the #332 model; PR #344)

1. **Protocol** (`packages/protocol`): add the URL-less
   `runtimeContextMcp` marker to `RuntimeConfigSchema` /
   `PublicLaunchRuntimeIntent`; keep the `firegrid-runtime-context`
   concrete declaration + `injectLaunchMcpDeclaration` as host-side
   helpers; schema/constructor tests.
2. **Host-SDK** (`packages/host-sdk`): add `FiregridRuntimeContextMcpBaseUrl`
   service + the bind-time publication primitive; `FiregridMcpServerLayer`
   fills it from `HttpServer` on bind; move declaration injection into
   the host start path (`startRuntime` / `claimAndRunRuntimeContextWorkflow`
   or the reconciler's start/materialization step) keyed on the marker;
   absent base ⇒ explicit, typed start failure; adjust the binary
   composition so the address service reaches the reconciler scope.
3. **CLI** (`packages/cli`): delete `run.ts:379-382` + `:479`
   pre-`createOrLoad` injection and the dead pre-derivation plumbing;
   CLI emits only the URL-less marker.
4. **tiny-firegrid**: resume the paused Codex ACP config + test on the
   URL-less marker + host-provisioned URL only (Condition 4).
5. **Findings/Beads**: status is `br`-owned; coordinator updates the
   ledger. No hand-edit in this PR.
6. **CI gate**: full gate set (lint + lint:dead + lint:dup + lint:deps,
   typecheck, per-package test, check:specs/docs, verify,
   lint:effect-quality). Coordinator reviews at the correctness bar; no
   self-merge.

## A1.6 — Status of this PR (#344)

This commit delivers the **ratified implementation contract + the
explicit F-2 answer + the Q3 choice** only. The cross-package
production edit (A1.5 steps 1–4) is gated on coordinator review of the
A1.1(b) composition wrinkle at the correctness bar — per Condition 1
("answer F-2 explicitly before you write the impl"; if a wrinkle
exists, "specify how the reconciler obtains the bound address") and the
no-self-merge gate. Implementing the host-layer recomposition before
that review would be silent scope on an unreviewed architectural
change.
