# Alignment Audit D — Doc / Handoff / Finding / SDD Hygiene

- **Bead:** tf-0awo.34.4 (Audit D, last of the tf-0awo.34 alignment sweep)
- **Main verified at:** `origin/main` HEAD `da2d4104a`
- **Date:** 2026-06-02
- **Target architecture (the lens):** the §12 composition —
  `FiregridRuntime(spec, adapter)` (`packages/runtime/src/unified/host.ts:328`) +
  DurableStreams floor + protocol read-views (`packages/protocol/src/launch/views.ts`) +
  `authority.ts` collapse (#826) — plus the factory vision
  (`docs/vision/factory-vision.md`: 7 capabilities, choreography-not-orchestration,
  substrate stays GENERIC / consumers compose).
- **Method:** 5 read-only classification passes (handoffs / SDDs A–M / SDDs N–Z + cannon /
  findings / research), each verifying doc claims against current `main` (code `file:line`,
  bead status via `BEADS_DIR=$HOME/gurdasnijor/.beads`, path existence). The coordinator
  (this author) then **source-re-verified every load-bearing claim** below before promotion
  (per the night-drive discipline: lane reports are hypotheses until re-checked).

> **Classification vocab** (per the audit spec): `aligned | stale | superseded | duplicate |
> gap | boundary-violation | untracked`. Per-doc ledger uses the hygiene verbs
> `KEEP-current | REFRESH | RETIRE-historical | SUPERSEDED-by-<doc>` (+ for SDDs:
> `STALE-STATUS-BLOCK | DUPLICATE`).

---

## 0. The one load-bearing thing

**The canonical load-bearing reading set already exists and is curated: it is the
`docs/cannon/README.md` dispatch allowlist** (16 numbered entries). A new agent should read
*that*, not graze the 62-file `docs/sdds/` tree. The allowlist is **accurate vs `main`** with
two caveats (below). The single most important *doc-hygiene gap* is that **the
canonical-current handoff (`2026-06-02-night-drive-handoff.md`) is NOT committed to
`origin/main`** — it lives only in the primary checkout — so the canonical tree's newest
handoff is the already-SUPERSEDED bindings-cli one. Commit the night-drive handoff. (F1.)

The corpus is **heavily over-grown with historical docs**: of ~225 audited docs, ~70% are
RETIRE-historical (dated spikes / landed designs / pre-#765 plans). None of that is wrong to
*keep* as archive — the hazard is the **~30 SDDs + several handoffs that reference
#765-deleted paths as if current** and the **stale status blocks** that read as "draft /
pending" on designs that shipped. These mislead a new agent navigating by file rather than by
the allowlist.

---

## 1. Canonical LOAD-BEARING set (the 5–10 a new agent MUST read)

**Source of truth: `docs/cannon/README.md` — "This index is the dispatch allowlist."**
Verified each entry exists and matches `main`:

| # | Doc | Verified | Note |
|---|-----|----------|------|
| 5 | `cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` | aligned | channels-as-nervous-system; realized in `runtime/src/channels/` |
| 6 | `cannon/architecture/runtime-design-constraints.md` | aligned | the active runtime stop-condition (priority over older workflow-engine cannon) |
| 7 | `cannon/architecture/runtime-pipeline-type-boundaries.md` | aligned | codec-only sessions, typed durable output observation |
| 8 | `cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` | aligned | one-substrate axiom; `durable-tools/` collapsed onto `engine/` |
| 9 | `sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md` | aligned | `runtime/src/channels/host-plane-router.ts` (tf-9x11/csr0/p1aw, all closed) |
| 10 | `sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md` | aligned | the Phase-0 target shape / review oracle (tf-3w1e closed) |
| 11 | `cannon/architecture/kernel-owned-write-arm.md` | aligned | write+arm ownership rule (`HostKernelWorkflow` = target role, not a symbol) |
| 12 | `cannon/sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md` | aligned | the DurableDeferred mailbox = transitional bridge |
| 13 | `sdds/SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE.md` | **aligned-as-bridge** | self-declared *superseded as target* by sparse transition logs — keep as bridge rationale, not target |
| 14 | `cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` | aligned | session-facade realizes it; cannon copy is the post-#765-refreshed one |
| 15 | `cannon/research/workflow-body-single-suspension-rule.md` | aligned | the durable-suspension-at-body-level rule (see finding tf-r06u-28-sleep-spike) |
| 16 | `vision/factory-vision.md` | aligned | north star; loop now proven (#834/#835) |
| 2–4 | `cannon/architecture/{host-sdk-runtime-boundary, transactional-cutover-rule, current-convergence-assessment-2026-05-20}.md` | aligned | boundary + cutover canon |

**Caveat A (gap):** the **live unified spine** SDDs —
`SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER`, `SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING`,
`SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION(_PREFLIGHT)` — are load-bearing-CURRENT (they
spec the codec adapter + the FiregridRuntime composition realized on `main`) but are **NOT in
the allowlist**. The codec-adapter one is gated from inclusion by its stale scenario block
(tf-ll90.15.1 OPEN). Consider adding them after that refresh. (F3.)

**Caveat B:** entry 13 (`DURABLE_OUTPUT_CURSOR_PRIMITIVE`) is allowlisted but self-supersedes
as *target* — keep it as the bridge-rationale record, don't navigate architecture by it.

---

## 2. Cross-cutting findings (beads-convertible)

**F1 — Canonical-current handoff not committed to `origin/main`** — EVIDENCE(`find docs -name '*night-drive*'` empty on worktree @ da2d4104a; file present only at primary `/Users/gnijor/gurdasnijor/firegrid/docs/handoffs/2026-06-02-night-drive-handoff.md`; it self-declares "Supersedes 2026-06-02-bindings-cli-handoff.md") — CLASSIFICATION(gap) — DISPOSITION(gates: the canonical tree's newest committed handoff is the superseded one; a fresh clone misroutes) — SUGGESTED BEAD: "Commit night-drive handoff to main + retire bindings-cli to historical" (P1).

**F2 — 4 SDD titles duplicated across `docs/sdds/` and `docs/cannon/sdds/`** — EVIDENCE(`comm -12`: `SDD_FIREGRID_AGENT_BODY_PLAN`, `SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH`, `SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE`, `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT`; cannon README allowlists the cannon copies; SCHEMA_PROJECTION_CONTRACT cannon copy is "refreshed post-#765", the `docs/sdds/` copy is the older re-scoped stub) — CLASSIFICATION(duplicate) — DISPOSITION(supports, but ambiguity risk: a reader may land on the stale `docs/sdds/` twin) — SUGGESTED BEAD: "Dedupe 4 cannon/sdds twins — replace `docs/sdds/` copies with a one-line pointer to the cannon canonical" (P2).

**F3 — Live unified-spine SDDs absent from the cannon allowlist** — EVIDENCE(`SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER/_WIRING`, `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION` spec `unified/codec-adapter.ts` + `host.ts:328` realized on main; not in `docs/cannon/README.md`) — CLASSIFICATION(gap) — DISPOSITION(supports: the architecture-defining-current docs aren't in the curated set) — tracked-by: tf-ll90.15.1 (refresh codec-adapter status block first) → then add to allowlist.

**F4 — ~30 SDDs reference #765-deleted paths as current** — EVIDENCE(verified GONE on main: `packages/substrate/`, `packages/host-sdk/src/host/`, `apps/`, `runtime/src/{subscribers,waits,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}/`; e.g. `SDD_FIREGRID_PACKAGE_STRUCTURE` maps the deleted `packages/substrate/src/*` while claiming Status "Active … on main"; full list in §4) — CLASSIFICATION(stale) — DISPOSITION(off-path: navigation hazard) — SUGGESTED BEAD: "Stamp a `HISTORICAL — superseded by #765 unified kernel` banner on the ~30 deleted-path SDDs (or move to `docs/sdds/historical/`)" (P2). NOTE: `unified/subscribers/` DOES exist — only *top-level* `runtime/src/subscribers/` is gone; don't conflate.

**F5 — `tf-vfq9` (BLOCKED, P1) cites deleted `file:line` evidence** — EVIDENCE(`docs/research/tf-vfq9-mcp-tool-call-cutover.STOP.md` cites `ToolCallWorkflow`/`toolUseToEffect`/`runtime/src/workflow-engine/` — all deleted by #765; `mcp-host/toolkit.ts:97` explicitly notes it is "NOT main's deleted ToolCallWorkflow") — CLASSIFICATION(stale evidence on a live bead) — DISPOSITION(gates: the open cutover should target `unified/mcp-host/` + `subscribers/runtime-context.ts`, not the doc's deleted paths) — tracked-by: tf-vfq9 (re-scope its evidence against `unified/`).

**F6 — `tf-ll90.11.1` (P0 OPEN) but its backdoors are already deleted on `main`** — EVIDENCE(`docs/findings/2026-06-01-test-only-codepath-removal-manifest.md` §E targets recorder/fake-codec/fake-sandbox; no `RecorderAdapter`/`fake-codec`/`acp-sandbox-fake` remain under `packages/firelab/src/` or `unified/adapter.ts`) — CLASSIFICATION(stale bead vs main) — DISPOSITION(supports: no-backdoor discipline already holds) — SUGGESTED BEAD: verify + close `tf-ll90.11.1` (or narrow to any residual) — bead/main divergence.

**F7 — `docs/handoffs/README.md` + `sprint-to-private-beta/` misroute new agents** — EVIDENCE(README points to `sprint-to-private-beta/` as "the active handoff packet"; that directory is a pre-#765 May-21 wave; README does not mention night-drive / s6) — CLASSIFICATION(stale) — DISPOSITION(gates: the directory entry point advertises a closed wave) — SUGGESTED BEAD: "Refresh `docs/handoffs/README.md` to name night-drive + s6 as the canonical-current pair; mark sprint-to-private-beta historical" (P2).

**F8 — `2026-06-02-tooling-ci-handoff.md` references retired Semgrep/ast-grep** — EVIDENCE(lists `.semgrep.yml`, `tooling/ast-grep/`, a Semgrep CI job, "6 CI jobs"; consolidation #814 retired both, CI 6→5, `.semgrep.yml` absent) — CLASSIFICATION(stale) — DISPOSITION(supports: its CI-perf shipped work + "never weaken anti-forge gates" are still true) — SUGGESTED BEAD: REFRESH to point at `docs/static-analysis-catalog.md` (P3).

**F9 — Handoff `tf-8ryo-runtime-tree-design.md` contradicts `main`** — EVIDENCE(designs a `packages/runtime/src/kernel/` dir + authorities taxonomy; `main` has no `kernel/` — #765 produced `unified/`; bead tf-8ryo CLOSED) — CLASSIFICATION(stale) — DISPOSITION(off-path) — SUGGESTED: RETIRE-historical (one of several closed tf-* planning handoffs; see §3).

**F10 (note, not a new bead) — the P0 process-leak has NO dedicated finding doc** — EVIDENCE(`docs/findings/` has no terminal-relay finding; the authority is the bead `tf-r06u.36` + `docs/analysis/2026-06-01-765-deletion-audit.md`; confirmed live: `observers.ts` cases are only `PermissionRequest`(:58)/`ToolUse`(:71), no `Terminated`/`TurnComplete`) — CLASSIFICATION(gap, already-tracked) — DISPOSITION(gates production cutover) — tracked-by: tf-r06u.36 / tf-ll90.5 (P0 OPEN). A new agent must read the *bead*, not expect a finding.

---

## 3. LEDGER (a) — Handoffs (`docs/handoffs/`, 18)

| Doc | Classification | Evidence / Note |
|-----|----------------|-----------------|
| `2026-06-02-night-drive-handoff.md` *(primary-only)* | **KEEP-current** (canonical-current) | live state; **not on origin/main → F1**. Supersedes bindings-cli. |
| `COORDINATOR_HANDOFF_s6_dark_factory.md` | **KEEP-current** (historical-LESSON-BEARING) | the coordinator-failure canon; night-drive §5 governs by it. The 2nd must-read. |
| `2026-06-02-bindings-cli-handoff.md` | SUPERSEDED-by night-drive | tf-0awo snapshot stale (most merged); §2 wait.* design still accurate. |
| `2026-06-01-stabilize-unified-handoff.md` | SUPERSEDED-by bindings-cli→night-drive | self-marks "SUPERSEDED ✅" (correct tombstone). |
| `2026-06-02-tooling-ci-handoff.md` | **REFRESH** | Semgrep/ast-grep retired by #814 → F8. |
| `README.md` | **REFRESH** | advertises stale "active packet" → F7. |
| `sprint-to-private-beta/` (dir, 7+7 files) | RETIRE-historical | pre-#765 May-21 sprint packet; superseded by unified-kernel collapse. |
| `2026-05-22-acp-live-validation-loop-handoff.md` | RETIRE-historical | trace-analysis methodology reusable; state pre-unified. |
| `2026-05-22-OLA-session-handoff.md` | RETIRE-historical | pre-#765 re-arch; epistemic lessons folded into MEMORY. |
| `2026-06-01-agent2-dag-gateway-handoff.md` | RETIRE-historical | bases off retired `sim/unified-kernel-validation` trunk; tf-r06u.28 merged. |
| `2026-06-01-stabilize-lane-briefs.md` | RETIRE-historical | lane briefs vs a retired trunk. |
| `coordinator-handoff.md` | RETIRE-historical | 2026-05-16 SDK-split plan; old `agent-event-pipeline/` tree gone. |
| `TEAM_INDEX.md` | RETIRE-historical | May-16 companion to coordinator-handoff. |
| `one-substrate-cycle-2-synthesis.md` | RETIRE-historical | decision record (tf-ycxw CLOSED); ChannelInventory gone. |
| `tf-8ryo-runtime-tree-design.md` | RETIRE-historical (contradicts main) | designs a `kernel/` dir that doesn't exist → F9. |
| `tf-aago-rewire-plan.md` | RETIRE-historical | client-sdk rewire landed (#560); retired ChannelInventory. |
| `tf-05jj-removal-plan.md` | RETIRE-historical | channel-collapse carveout (tf-05jj CLOSED). |
| `tf-d6s9-factory-vision-capability-map.md` | RETIRE-historical | self-flags stale; `apps/factory` absent; loop now proven. |
| `tf-qu7l-read-path-rewire-plan.md` | RETIRE-historical | superseded by OPEN tf-0awo.6 (targets `protocol/launch/views.ts` now). |

**Canonical-current set: exactly 2 — night-drive (commit it) + s6 (lesson-bearing).**

---

## 4. LEDGER (b) — SDDs (`docs/sdds/` 62 + `docs/cannon/sdds/` 6)

### KEEP-current — load-bearing (the live architecture)
- `cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN` *(+ docs/sdds twin — F2)* — agent surface (channels). **allowlist**
- `cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE` *(+ docs/sdds twin — F2)* — substrate axiom. **allowlist**
- `cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT` *(+ docs/sdds twin, older — F2)* — protocol/schema contract. **allowlist**
- `cannon/sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION` — write+arm path. **allowlist**
- `sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER` — `host-plane-router.ts` (tf-9x11/csr0/p1aw closed). **allowlist**
- `sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE` — review oracle (tf-3w1e closed). **allowlist**
- `sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE` — the DurableTable axiom (pillar others subordinate to).
- `sdds/SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION` (+ `_PREFLIGHT`) — live unified spine (**F3**, not yet allowlisted).
- `sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING` — FiregridRuntime composition (**F3**).
- `sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER` — codec adapter; **STALE-STATUS-BLOCK** (scenarios 1-9/fake-codec deleted by #783) → tracked-by **tf-ll90.15.1** (P2 OPEN).
- `sdds/SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS` — active D1-gated gateway refactor design (tf-r06u.22 DONE for design); STALE evidence ("AcpStdioEdge orphaned" false; line cites are #765-branch, not main).
- `cannon/sdds/SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE` *(in docs/sdds)* — **allowlist**, but superseded-as-target (bridge rationale only).
- `cannon/sdds/SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH` *(+ docs/sdds twin — F2)* — contingency (not active).

### KEEP-current — reference (model still accurate; not a live spec)
`SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC` (tf-lfxs/tf-1r3h closed) · `SDD_FIREGRID_DURABLE_AGENT_SUBSTRATE` · `SDD_FIREGRID_ARCHITECTURE_AND_INVOCATION_BOUNDARY` · `SDD_FIREGRID_EFFECT_QUALITY` · `SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES` · `SDD_FIREGRID_SESSION_OBSERVATION_SURFACE` (TFIND-040) · `SDD_FIREGRID_CHOREOGRAPHY_FACADE` (verbs realized as channels) · `cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_IMPLEMENTATION` · `SDD_FIREGRID_RUNTIME_CLI_VALIDATION`.

### STALE-STATUS-BLOCK (design landed/changed; status text wrong vs main — REFRESH or flip to HISTORICAL)
`SDD_FIREGRID_CLI_LAUNCHERS` (shipped: `runtime/src/bin/{run,acp,start}.ts`, commit 11b4dfcc8; status still "DRAFT") · `SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER` ("dispatch-ready" but tf-auuv DONE #519) · `SDD_FIREGRID_PACKAGE_STRUCTURE` ("Active on main" while mapping deleted `packages/substrate/`) · `SDD_CLIENT_CONTROL_PLANE_STREAM_URL_SURFACE` (Evidence "barrel doesn't export helper" — false; `client-sdk/src/index.ts:17` exports it; tf-76s closed #359) · `SDD_FIREGRID_HOST_SDK` (pins to red draft #309 + retreated Path X).

### SUPERSEDED-by-<doc> / HISTORICAL (design landed or superseded; archival)
`DECISION_PATH_X_PROCESS_OWNERSHIP` + `SDD_PATH_X_IMPLEMENTATION` (Path X retreated; → unified kernel) · `SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE` (RuntimeInputIntent chain → signal kernel) · `SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS`→FIREPIXEL · `SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN` (self-labeled historical, exemplary) · `SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB`→ARCHITECTURE_AND_INVOCATION_BOUNDARY · `SDD_WAIT_ROUTER_PERCONTEXT_OUTPUT` (SUPERSEDED-by §12 cutover; wait-router deleted; tf-8rp closed) · `SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP` · `SDD_FIREGRID_DURABLE_WAIT_EXTRACTION` · `SDD_FIREGRID_DURABLE_OUTPUT_CURSOR_PRIMITIVE`(target) · `SDD_NEXT_LAYER_REVIEW_SEQUENCE` · `SDD_RUNTIME_CONTEXT_WORKFLOW_INPUT_TABLE_CUTOVER` (tf-kk63 closed #617) · `SDD_SESSION_LIFECYCLE_APPEND_POINT` (tf-p7w #393) · `SDD_SNAPSHOT_OBSERVATION_TYPING` (tf-j94 #353) · `SDD_FIREGRID_SNAPSHOT_EVENT_TYPING` (#329) · `SDD_PERMISSION_CODEC_AUTHORITY` (#350; rule still load-bearing) · `SDD_MCP_ROUTE_URL_LIFECYCLE` (mechanism re-homed to unified mcp-host) · `SDD_FIREGRID_RUNTIME_COMPOSITION_ERGONOMICS` · `SDD_FIREGRID_TYPED_RUNTIME_RUN_API` · `SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY(_IMPLEMENTATION)` · `SDD_FIREGRID_CLIENT_HOST_BOUNDARY` · `SDD_FIREGRID_DURABLE_AGENT_RUNTIME_LAB`.

### Reference DELETED paths as current → F4 (REFRESH banner / archive)
`SDD_FIREGRID_DARK_FACTORY_APP`, `SDD_FIREGRID_FACTORY_PLATFORM_FIT`, `SDD_FIREGRID_FACTORY_RUN_PROCESS`, `SDD_FIREGRID_FACTORY_ALIGNED_AGENT_TOOL_WORKSTREAM` (→ `apps/`, `runtime/src/agent-tools/`) · `SDD_FIREGRID_FIRELINE_READINESS`, `SDD_FIREGRID_FIREPIXEL_FOUNDATION`, `SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS` (→ `packages/substrate/`) · `SDD_FIREGRID_HOST_SURFACE`, `SDD_FIREGRID_RUNTIME_START_CAPABILITY_DEPS`, `SDD_RECONCILER_ENV_ENUMERATION`, `DECISION_PATH_X`, `CONSOLIDATED_*`, `CLIENT_HOST_BOUNDARY`, `HOST_SDK` (→ `host-sdk/src/host/`) · `SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE`, `SDD_FIREGRID_RUNTIME_HOST_MODULARITY`, `SDD_FIREGRID_AGENT_OUTPUT_SSOT` (→ `runtime-host/`, `agent-event-pipeline/`) · `SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION` (→ `subscribers/`, `composition/` + retired Semgrep).

### UNTRACKED unbuilt work (no closed/open bead, on-architecture)
- `SDD_FIREGRID_AGENT_COORDINATION_PATTERNS` (2026-05-31; proposes `UnifiedTable.peerEvents`/`emitPeerEvent` on the unified substrate; no code, no bead) — CLASSIFICATION(untracked) — SUGGESTED BEAD: "Triage AGENT_COORDINATION_PATTERNS SDD — build or shelve" (P3). (Overlaps the OPEN `tf-wf43` agentic-patterns epic — likely fold in.)
- `SDD_CHOREOGRAPHY_FACADE` — proposal; verbs landed as channels, no facade module, no bead. (untracked, low-priority.)

### Duplicates (F2): `AGENT_BODY_PLAN`, `ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH`, `ONE_SUBSTRATE_WORKFLOW_ENGINE`, `SCHEMA_PROJECTION_CONTRACT` — **cannon copy canonical** (allowlist); `docs/sdds/` copies are redundant/older.

---

## 5. LEDGER (c) — Findings (`docs/findings/`, 18)

| Finding | Classification | Bead / Evidence |
|---------|----------------|-----------------|
| `tf-r06u-28-sleep-spike-suspension-boundary.md` | **KEEP-current (open-gap)** | durable suspension MUST be workflow-body-level, not in `Activity.make`; gates tf-r06u.9 (OPEN). **The one decision-grade live finding.** |
| `tf-0awo-31-3-cross-agent-delegation.md` | ANSWERED-CLOSED | tf-0awo.31.3 closed #835 (HEAD); residual = "no observe-my-child verb" (design note). |
| `tf-0awo.30-factory-capstone-sim.md` | ANSWERED-CLOSED | tf-0awo.30 closed #834; live boundaries it brushes → tf-r06u.9 (`execute` fallthrough `tool-dispatch.ts:603`) + tf-0awo.33 (afterSequence default, PO call). |
| `tf-0awo-18-modularity-compile-spike.md` | ANSWERED-CLOSED | tf-0awo.18 closed; §12 constructor compiles. |
| `tf-0awo-19-acp-tooluse-ordie-verify.md` | ANSWERED-CLOSED | Fix A present `observers.ts:74` (providerExecuted gate). |
| `tf-ll90-3-signal-write-arm.md` | ANSWERED-CLOSED | `recoverPendingSignals` wired `host.ts:281`. |
| `tf-ll90-4-control-plane-cancel-close.md` | SUPERSEDED | cancel/close now MCP tools `session_cancel/close` (`tool-dispatch.ts:580/589`); the terminal *consumer* leak is the separate live tf-ll90.5. |
| `tf-ll90-9-2-codex-acp-tool-calls-create-or-load-gap.md` | **STALE** (fixed) | createOrLoad materialization landed (host-control route); cf. parent→child FK = separate OPEN tf-r06u.8. |
| `tf-ll90-ukv-acp-tool-result-gap.md` | STALE (fixed) | superseded by tf-0awo.19 fix. |
| `2026-06-01-enforcement-surface-audit.md` | STALE | Semgrep framing contradicted by #814. |
| `2026-06-01-test-only-codepath-removal-manifest.md` | ANSWERED (bead lags) | backdoors deleted; tf-ll90.11.1 still OPEN → F6. |
| `2026-06-01-ukv-workflow-body-non-execution.md` | ANSWERED-CLOSED | race fixed by tf-ll90.3. |
| `tf-ll90-ukv-13-probe-migration.md` | ANSWERED-CLOSED | gaps fixed (tf-ll90.3 / tf-0awo.19). |
| `tf-24p-gap3-417-mechanism-review.md` | ANSWERED-CLOSED (off-path) | pre-unified reconciler verification. |
| `tf-r06u-12-adapter-divergence-mcp-reach.md` | ANSWERED-CLOSED | adapter onboarding = config; fed tf-r06u.14. |
| `tf-r06u-23-28-mcp-host-already-on-main.md` | ANSWERED-CLOSED | port-forward executed (mcp-host on main). |
| `tf-r06u-25-firelab-asset-inventory.md` | ANSWERED-CLOSED | relocation strategy consumed. |
| `tf-r06u-28-mcp-host-port-plan.md` | ANSWERED-CLOSED | built per plan (`unified/mcp-host/*`). |

**Only 1 finding carries live action** (sleep-spike suspension boundary). The P0 leak is bead-tracked, not finding-doc'd (F10). 3 STALE/fixed docs (tf-ll90-9-2, tf-ll90-ukv-acp-tool-result, enforcement-surface-audit) should get a one-line "RESOLVED on main" footer.

---

## 6. LEDGER (d) — Research (`docs/research/`, ~124)

**Bulk: ~118 of ~124 are ANSWERED-CLOSED dated spikes (2026-05-06 → 05-22)** — FINDING /
empirical / move-rationale / `.jsonl`-trace artifacts whose `tf-*` IDs resolve to CLOSED
beads (verified samples: tf-7knr/#497, tf-lfxs/#567, tf-9ut/#447, tf-tw49/#450, tf-4cik.1/#576,
tf-0r95/#505, tf-gw43/#510). Their pre-#765 path references are *historical context being
analyzed*, not live claims — correct to archive, **not** to treat as authoritative. RETIRE-historical
in bulk (no per-file action). ~49 reference #765-deleted dirs (expected for spikes; harmless except the two below).

**Exceptions (action-worthy):**

| Doc | Classification | Note |
|-----|----------------|------|
| `tf-vfq9-mcp-tool-call-cutover.STOP.md` | **STALE on a live bead** | tf-vfq9 BLOCKED P1; cites deleted `ToolCallWorkflow`/`workflow-engine/` → F5 (re-scope vs `unified/`). |
| `agent-coordination-patterns-experiment.md` | **KEEP-current (open)** | feeds OPEN epic tf-wf43; design-to-approve. |
| `agent-orchestration-vs-choreography-experiment.md` | **KEEP-current (open)** | tf-wf43 twin; tf-wf43 links a 3rd filename (`agentic-patterns-experimental-design.md`) ABSENT from the dir — doc-link drift; consolidate the two present twins. |
| `firegrid-api-footgun-inventory.md` | STALE (archival) | cites `apps/flamecast`, `@firegrid/substrate`, `docs/patterns/README.md` as current debt — all gone; footgun *thesis* evergreen, inventory pre-#765. |
| `cannon/research/workflow-body-single-suspension-rule.md` | KEEP-current (reference) | allowlisted; the durable-suspension rule. |

---

## 7. Disposition summary

| Bucket | Count (approx) | Action |
|--------|------|--------|
| KEEP-current (load-bearing) | cannon allowlist (16) + ~6 spine SDDs | the new-agent reading set; F3 add spine SDDs after tf-ll90.15.1 |
| KEEP-current (reference/open) | ~12 | model/methodology still accurate |
| STALE-STATUS-BLOCK / STALE | ~5 SDDs + 3 findings + tooling-ci + 2 research | REFRESH or flip-to-historical |
| SUPERSEDED / HISTORICAL | ~25 SDDs + 14 handoffs | RETIRE-historical (mostly closed beads) |
| DELETED-PATH refs (F4) | ~30 SDDs + ~49 research | banner / archive; do not navigate by them |
| DUPLICATE (F2) | 4 SDD pairs | dedupe to cannon canonical |
| UNTRACKED unbuilt | 2 SDDs | triage into tf-wf43 or shelve |
| ANSWERED-CLOSED | ~118 research + 12 findings | archive |

**New beads suggested:** F1 (commit night-drive, P1), F2 (dedupe 4 twins, P2), F4 (historical banner on deleted-path SDDs, P2), F7 (refresh handoffs README, P2), the AGENT_COORDINATION_PATTERNS triage (P3, likely under tf-wf43). **Tracked-by existing:** F3→tf-ll90.15.1, F5→tf-vfq9, F6→tf-ll90.11.1, F10→tf-r06u.36/tf-ll90.5.
