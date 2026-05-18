# SDD: MCP Route + URL Lifecycle in the Client/Host Model

Status: draft - framing only, no production code
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
