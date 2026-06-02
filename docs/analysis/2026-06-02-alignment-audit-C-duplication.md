# Alignment Audit C — duplication / dead-code / boundary-violation sweep

**Bead:** tf-0awo.34.3 · **Date:** 2026-06-02 · **Shared main:** `da2d4104a`
**Target architecture:** §12 composition (`FiregridRuntime(spec, adapter)` + `DurableStreams` floor + protocol read-views + authority collapse) and the factory vision (`docs/vision/factory-vision.md`: 7 capabilities; choreography-not-orchestration; substrate stays GENERIC, consumers compose).
**Method:** source-verified — every "dead/duplicate" claim checked against actual call/usage (not mere existence), per the tf-0awo.28 discipline that most gaps collapse on a second look.

Finding format: **TITLE — EVIDENCE — CLASSIFICATION — DISPOSITION — SUGGESTED BEAD / tracked-by.**

---

## C1 — Duplicate webhook-fact ingest: `scheduled-webhook-peer.verifyAndIngestWebhook` duplicates the canonical `verified-webhook-ingest`, and the copy is dead

**EVIDENCE.** Two independent implementations both HMAC-verify raw bytes and write a "verified webhook fact" row, to **two different tables**:
- Canonical: `packages/runtime/src/verified-webhook-ingest/adapter.ts` — `hmacSha256Hex` (:134) + `table.verifiedWebhookFacts.insertOrGet` (:389) into `VerifiedWebhookFactTable` keyed `[source, externalEventKey]` (`table.ts:58-61`, `keys.ts:51-62`). Blessed by the factory vision as *the* runtime-owned verified-fact adapter (`docs/vision/factory-vision.md:255-280`), exercised via the generic `firegrid.verifiedWebhooks` channel (`channels/verified-webhook/{source-live,live}.ts`), tested (`test/verified-webhook-ingest/adapter.test.ts`, `test/channels/verified-webhook/source-live.test.ts`).
- Duplicate: `packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts` — `hmacSha256Hex` (:128) + `verifyAndIngestWebhook` (:204) writing `UnifiedTable.webhookFacts.insertOrGet` (:235).
- **The duplicate is dead:** `grep` across `packages/ features/ experiments/` finds **zero callers** of `verifyAndIngestWebhook` outside its own file; it is the **only** writer of `UnifiedTable.webhookFacts`, so that collection is never written; the `WebhookFactObserverWorkflow` registered into `FiregridRuntime` (`host.ts:353 buildWebhookFactObserverLayer()`) reads an always-empty table.

**CLASSIFICATION:** duplicate + dead (the webhook-fact arm of `scheduled-webhook-peer`). The subscriber re-implements ingest rather than reusing the canonical adapter.
**DISPOSITION:** off-path — `verified-webhook-ingest` is the §12/vision-aligned canonical ingest; the `UnifiedTable.webhookFacts` parallel model has no producer and no consumer-of-record.
**SUGGESTED BEAD:** *"Delete the webhook-fact ingest arm (`verifyAndIngestWebhook` + `WebhookFactObserverWorkflow` + `UnifiedTable.webhookFacts`) from scheduled-webhook-peer; the canonical verified-fact path is `verified-webhook-ingest` (consumer-composed)."* — **P2**. Confirm first that no out-of-tree consumer composes `verifyAndIngestWebhook` (it is on the `@firegrid/runtime/unified` barrel — public surface).

---

## C2 — `scheduled-webhook-peer` external-adapter + scheduled-prompt surface is registered into `FiregridRuntime` but has no reachable trigger

**EVIDENCE.** `host.ts:352-354` composes `buildScheduledPromptLayer()`, `buildWebhookFactObserverLayer()`, `buildPeerEventObserverLayer()` — all three register workflows. But the *triggers* are absent:
- `emitPeerEvent` — **zero callers** across `packages/ features/ experiments/` (only writer of `UnifiedTable.peerEvents`); `PeerEventObserverWorkflow` reads an always-empty table.
- `ScheduledPromptWorkflow` — **no external `.execute`/arm** found (checked `channel-bindings.ts`, `host.ts`). Its historical trigger was `schedule_me`, which was **removed** when the `wait.*` family unified (`wait_until` subsumed it; per the bindings handoff).
- `verifyAndIngestWebhook` — dead (C1).

So the whole "external adapters + scheduled prompt" subscriber is `register`ed-but-unreached: a `Layer` cost and a `Workflow.make` admission with no live producer.

**CLASSIFICATION:** dead / untracked (registered-but-unreached). **Calibration:** I verified absence of direct callers and of signal-arming in `channel-bindings.ts`/`host.ts`; I did NOT exhaustively rule out an MCP-tool or recovery-catalog arm. Treat as *likely-dead, confirm-before-delete*, not asserted-dead.
**DISPOSITION:** off-path — these predate the §12 cutover; the choreography surface today is `wait.*` + the channels, not these bespoke observers.
**SUGGESTED BEAD:** *"Confirm no signal/MCP-tool/recovery arm triggers ScheduledPromptWorkflow / Peer+WebhookFact observers; if none, drop the three build*Layer registrations from FiregridRuntime (and the module) — they are registered-but-unreached post-wait.* unification."* — **P2**.

---

## C3 — `verified-webhook-ingest` is NOT dead despite zero runtime-host inbound edges (gap that collapses)

**EVIDENCE.** `channels/verified-webhook/source-live.ts` is not composed into `FiregridRuntime`/`host.ts`/any bin, and a naive zero-inbound sweep would flag `verified-webhook-ingest` + the `verifiedWebhooks` channel as dead. But the factory vision (`factory-vision.md:255-280`) states it is **consumer-composed** substrate: *"Firegrid does not own HTTP routes … the product owns the HTTP route … and composes the adapter"* (`verified-webhook-ingest/README.md`). It is tested and referenced by `ARCHITECTURE.md` / package READMEs. "Not wired into the host" is **by design** (substrate stays generic; consumers wire it).

**CLASSIFICATION:** aligned. **DISPOSITION:** supports the target (consumer-composed generic substrate — the §-vision boundary). **tracked-by:** n/a — recorded so a future dead-code sweep does not mistake consumer-composed substrate for orphaned code. (This is the C1/C2 contrast: same "zero host-inbound" signal, opposite verdict — the vision/README is the discriminator.)

---

## C4 — Boundary/airgap rules do not yet encode the §12 target boundaries

**EVIDENCE.** `.dependency-cruiser.cjs` enforces the package-tier boundaries well: `client-sdk-no-runtime` (:332), `runtime-no-client-sdk-or-cli` (:346), `runtime-no-host-sdk` (:365), the `host-sdk-*` composition-surface rules (:373-414), `protocol-no-client-or-runtime` (:443), and the intra-runtime tier-layering rules (:88-256). These match the pre-§12 graph and remain correct.
But there is **no rule encoding §12's new structure**: `grep` for `durablestreams|read.?view|views|contextId.*stream|floor` in the dep-cruiser config finds nothing relevant. Specifically unenforced:
- nothing prevents a new **per-context output stream builder** from reappearing (the §3.1 deletion + §12 Seam 1 rely on "a per-context output stream is not constructible" — that is currently a deletion, not a guarded invariant);
- nothing enforces that the **client read path consumes protocol read-views over the `DurableStreams` floor** rather than host-composed channel Tags (§12 Seam 1b).

**CLASSIFICATION:** gap (enforcement lags the target). **DISPOSITION:** off-path-prevention missing — the §12 invariants hold by current code shape but are not ratcheted, so they can silently regress.
**SUGGESTED BEAD:** *"Add dep-cruiser/eslint guards for the §12 floor: forbid a per-context output stream-URL builder (the deleted `runtimeContextOutputStreamUrl` shape) from re-entering; assert client-sdk reads go through the protocol read-views, not channel Tags."* — **P2** (do as the §12 read-views land, so the rule targets the real symbols).

---

## Coverage & limits (calibrated)

- **Depth-first on the confirmed lead** (C1/C2 webhook duplication) with full caller/writer verification; **C3/C4** are breadth observations verified against source but not exhaustive.
- This is **not** a complete whole-tree dead-module enumeration. A systematic zero-inbound pass over the committed `docs/dependency-graph*.mmd` (or a `dependency-cruiser --output-type err` orphan run) is the right follow-up to catch other orphans; I followed the dispatched lead + targeted greps rather than enumerate all modules within budget.
- Every "dead" claim here is **caller/writer-verified**, but two (C2's trigger-absence, C1's out-of-tree-consumer) carry an explicit *confirm-before-delete* because the symbols are on the public `@firegrid/runtime/unified` barrel — a consumer could compose them out-of-tree.

## Beads-convertible summary

| # | Title | Class | Disposition | Priority |
|---|---|---|---|---|
| C1 | Delete duplicate webhook-fact ingest arm in scheduled-webhook-peer; canonical = verified-webhook-ingest | duplicate+dead | off-path | P2 |
| C2 | Confirm + drop registered-but-unreached scheduled-prompt/peer/webhook observer arms | dead/untracked | off-path | P2 |
| C3 | verified-webhook-ingest is consumer-composed canonical (record; do not flag as dead) | aligned | supports | — |
| C4 | Add §12-floor enforcement (no per-context output stream builder; client reads via read-views) | gap | prevention | P2 |
