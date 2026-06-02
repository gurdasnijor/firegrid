# Architecture Health-Check / Alignment Audit — compiled

- **Date:** 2026-06-02
- **Main audited:** `origin/main` (composition cutover era; HEAD `bcdf0ba01`+)
- **Inputs:** 4 read-only audit lanes, each reviewed at source by the coordinator
  (lane reports are hypotheses until re-verified): `alignment-audit-A-composition.md`
  (SDD↔code↔bead), `-B-capabilities.md` (factory vision + Brookhaven), `-C-duplication.md`
  (duplicate/dead/boundary), `-D-doc-hygiene.md` (doc/SDD ledger).
- **Method:** every "done/dead/stale/gap" claim cross-checked vs `main` (`file:line` /
  merged-PR / bead). Most candidate gaps collapse on re-check (`tf-0awo.28`); only
  source-verified findings became beads.

---

## 0. Verdict

**The work is relevant and aligned.** The §12 composition target is implemented
(`FiregridRuntime(spec,adapter)` + DurableStreams floor + protocol read-views +
authority collapse), the factory loop is proven end-to-end through delegation
(#834/#835), and 5/7 §7 capabilities are proven through the public surface. The
audit surfaced **no new architecture-invalidating gap** — it surfaced one P0 code
gap already half-known, a real client-boundary violation, a confirmed dead
duplicate, and a large doc-hygiene debt. The substrate stays generic (Brookhaven
needs no consumer-specific bridge). Net: converge the open code gaps, then sweep
the doc debt.

## 1. Code findings (prioritized, beads filed)

| Pri | Bead | Finding | Source |
|---|---|---|---|
| **P0** | `tf-r06u.36`/`tf-ll90.5` | **Terminal-completion relay / process leak** — `observers.ts:57-90` has no `Terminated`/`TurnComplete` case; the session body parks on a terminal signal nothing emits; `deregister` never fires. Gates production cutover. | A/B/D confirm |
| **P0** | `tf-0awo.36` | **Unified MCP executor advertises but does not lower `execute`/`send`/`call`/`spawn`** (fall through to "not yet ported", `tool-dispatch.ts`); gates cap-6 actions + channel-action tools + spawn delegation. Decision per tool: lower or stop advertising. | A + B (F-07) |
| **P1** | `tf-0awo.35` | **Client parallel `wait.*` surface** — top-level `firegrid.wait.{for,until,any}` mirrors the agent durable-choreography family; `wait.until` is a non-durable `Clock.sleep` synthesizing a host-owned `{waited,firedAt}` (`firegrid.ts:858-866`). §7 plane-confusion + client-predicts-host-fact. | user + C (C5) |
| **P1** | `tf-0awo.6` | **Client read-path still resolves durable-table facades** (`firegrid.ts:17/18/932/933/1531/1548`); §12 views exist but aren't the client read source. Unblocked (its blocker §12 cutover merged); real remaining work. | A confirms |
| **P1** | `tf-r06u.49` | **Brookhaven G1: scoped opaque-handle/per-stream auth** over durable-streams append/read — the ONE generic edge primitive the Roblox in-game-agent use-case needs. Reprioritized P2→P1 (gates the external-consumer use-case). | B (F-10) |
| **P2** | `tf-0awo.37` | **Delete DEAD duplicate webhook ingest** in `scheduled-webhook-peer` (`verifyAndIngestWebhook` + `WebhookFactObserverWorkflow` + `UnifiedTable.webhookFacts` — writes a table nothing reads). Canonical = `verified-webhook-ingest`. Confirm no out-of-tree consumer (public barrel) first. | C (C1) |
| **P2** | `tf-0awo.38` | **Drop registered-but-unreached** scheduled-prompt/peer/webhook observers from `FiregridRuntime` (`host.ts:352-354`) — no live trigger post-`wait.*` unification. | C (C2) |
| **P2** | `tf-0awo.39` | **Ratchet §12 floor invariants** (dep-cruiser/eslint): forbid a per-context output stream-URL builder re-entering; assert client reads go via protocol read-views. Invariants hold by code-shape but aren't guarded. | C (C4) |
| **P3** | `tf-0awo.40` | `createOrLoad` failure path client-derives the host contextId (`sessionContextIdForExternalKey`, `firegrid.ts:1416`) — carry the externalKey, not the host's derived id. | C (C6) |

**Closed by this audit (verified):** `tf-ll90.11.1` (backdoors already removed — no recorder/fake-codec/fake-sandbox in prod) + the earlier groom closes.

## 2. Doc-hygiene findings (the large debt)

| Pri | Bead | Finding |
|---|---|---|
| **P1** | `tf-0awo.41` | **Canonical-current docs not on `main`**: `2026-06-02-night-drive-handoff.md` + the §12 `Firegrid Composition-Type-Driven-Greenfield-SDD.md` exist only in the primary checkout → `main`'s newest committed handoff is the *superseded* bindings-cli. **(Fixed in this commit.)** |
| P2 | `tf-0awo.42` | Dedupe 4 `cannon/sdds` ↔ `docs/sdds` twins → pointer to cannon canonical. |
| P2 | `tf-0awo.43` | Stamp HISTORICAL on ~30 SDDs referencing #765-deleted paths (navigation hazard). |
| P2 | `tf-0awo.44` | Refresh `handoffs/README.md` (advertises a closed pre-#765 wave) + `tooling-ci-handoff` (Semgrep/ast-grep retired #814). |
| P3 | `tf-0awo.45` | Triage `SDD_FIREGRID_AGENT_COORDINATION_PATTERNS` (untracked, no code) → fold into `tf-wf43` or shelve. |
| note | `tf-vfq9` | (F5) Its STOP doc cites #765-deleted paths; re-scope evidence vs `unified/` before resuming. |

**Canonical reading set for a new agent:** `docs/cannon/README.md` (the dispatch
allowlist, 16 entries — accurate vs `main`), **plus** the night-drive handoff +
`COORDINATOR_HANDOFF_s6_dark_factory.md` (lesson-bearing). Do not navigate by the
62-file `docs/sdds/` tree (~70% historical).

## 3. Alignment confirmed (no action — recorded so a sweep doesn't mis-flag)

- §12 cutover implemented (`host.ts:328`); §3.1 deletions clean; views browser-safe.
- Factory loop proven end-to-end through delegation; 5/7 caps proven through the public surface.
- **`verified-webhook-ingest` is consumer-composed substrate, NOT dead** despite zero host-inbound edges (C3) — the vision/README is the discriminator vs the C1 dead duplicate.
- Brookhaven: the **generic substrate suffices**; a Firegrid HTTP gateway / intent-translator is the anti-pattern (`tf-qne2`). Only the G1 edge-auth (`tf-r06u.49`) + the cap-6 publish (= `tf-0awo.36`) are needed.
- Client-minted `ctx_`/`input_` ids are client-originated correlation (fine), NOT predicted host facts (C6 calibration).

## 4. PO decisions still waiting (not the coordinator's to make)
- `tf-0awo.17` — daemon embedded-default **A/B**.
- `tf-0awo.33` — default `afterSequence` to `-1`.
- `tf-r06u.48` — `spawn` contract: await-terminal vs handle-shaped.
- `tf-0awo.36` cap-6 sub-decision — port `execute` vs remove it + add a consumer publish MCP tool.

---
*Compiled from the 4 alignment-audit docs in this directory. Each finding cites
source; beads `tf-0awo.35–.45`, `tf-r06u.36/.49`, `tf-ll90.5` carry the work.*
