# tf-x5os SDD / architecture backlog reconciliation

Investigation date: 2026-06-03.

Scope: `docs/sdds/*.md` (63 files) and `docs/architecture/*.md` (27 files). I did not mutate Beads.

Method:

- Sorted `docs/sdds/*.md` and `docs/architecture/*.md` by mtime, recent first.
- Treated `docs/cannon/README.md` as the canonical allowlist. Root `docs/sdds` entries are canonical only when linked there as `../sdds/...`; root `docs/architecture` entries are not canonical unless explicitly linked.
- Read `Status:` headers and historical banners. Non-allowlisted docs are historical/draft by default, especially when they say `HISTORICAL (pre-#765)`.
- Searched docs for `tf-*` references and searched Beads with `BEADS_DIR=$HOME/gurdasnijor/.beads br list --all --limit 0 | rg -i <keyword>`.
- Source-checked the recent candidates that looked like real open work.

Epistemic tiers:

- **source-verified**: checked repo source and/or Beads source of truth.
- **bead/doc-verified**: checked Beads/doc references but did not re-prove code state.
- **inferred**: classification is from title/status/header/cannon only.

## CREATE-BEAD Candidates

1. **P2 - Runtime shrink corpus/baseline realignment after unified collapse.** `docs/architecture/2026-06-02-runtime-dynamics-map.md` says `runtime-corpus.sh check` cannot run because the corpus manifest references deleted simulations and shrink-loop baselines are pre-unified (`docs/architecture/2026-06-02-runtime-dynamics-map.md:39`, `:110`). Source check found no `docs/architecture/corpus/manifest.json` and no `runtime-shape-baseline*.json` in `origin/main`; only the current trace/map artifacts exist. No matching Beads owner was found by keyword searches for `runtime-corpus`, `manifest`, `runtime shape baseline`, or `UnknownSimulation`.

## Summary

- I found **1 CREATE-BEAD** candidate: the runtime shrink corpus/baseline realignment above.
- Most apparent open work is already tracked by Beads, especially recent CLI/composition/gateway/runtime-shrink work.
- Most untracked historical/draft SDDs should be handled by `tf-bcg1` archival/canonicity work, not converted into implementation beads.
- Root `docs/architecture/2026-06-02-runtime-structure-map.md` initially looked like a candidate, but source verification showed part of its concrete "empty runtime dirs" note is already stale: `_archive/`, `capabilities/`, and `producers/` do not exist in `origin/main` under `packages/runtime/src`.

## Full Reconciliation Table

| Doc | Canonical / historical | Describes open work? | Matching bead | Recommendation | Tier |
|---|---|---|---|---|---|
| `docs/architecture/2026-05-22-runtime-architecture-handoff.md` | Historical handoff, not cannon | Yes, but as handoff sequencing | `tf-aseo`, `tf-jpcg`, `tf-vfq9`, `tf-r6br` refs | TRACKED | bead/doc-verified |
| `docs/architecture/2026-05-22-runtime-physical-target-tree.md` | Historical/root target aid, not cannon | Yes, migration/deletion map | refs `tf-up1v`, `tf-hpr0`, `tf-6hqx`, `tf-vfq9`, `tf-6cdy` | TRACKED; archive with tf-bcg1 class | bead/doc-verified |
| `docs/architecture/2026-05-22-runtime-rearch-closeout.md` | Historical closeout, not cannon | Yes, but carried as decisions | refs `tf-vrz6`, `tf-jpcg`, `tf-vfq9`, `tf-aseo` | TRACKED | bead/doc-verified |
| `docs/architecture/2026-05-22-shape-c-clean-room-test-triage.md` | Historical dispatch aid, not cannon | No current target; test triage record | none found | ARCHIVE | inferred |
| `docs/architecture/2026-05-22-shape-c-cutover-baseline.md` | Historical Shape C record, not cannon | No, baseline record | none direct | ARCHIVE | inferred |
| `docs/architecture/2026-05-22-shape-c-cutover-operating-plan.md` | Historical active-at-time plan, not cannon | Yes, but old cutover plan | `tf-zchu` ref | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` | Historical active-at-time roadmap, not cannon | Yes, old roadmap | none direct; Shape C beads closed/archival | ARCHIVE | inferred |
| `docs/architecture/2026-05-22-shape-c-handler-slice-delta.md` | Historical active-at-time delta, not cannon | Mostly shipped delta plus follow-up note | none direct | DONE-CLOSE / ARCHIVE | inferred |
| `docs/architecture/2026-05-22-shape-c-legacy-deletion-map.md` | Historical deletion map, not cannon | Yes, old deletion candidates | none direct | ARCHIVE | inferred |
| `docs/architecture/2026-05-22-shape-c-output-observation-cutover.md` | Historical active-at-time cutover note, not cannon | Yes, but named deps | refs `tf-aseo`, `tf-1ymw`, `tf-zchu` | TRACKED | bead/doc-verified |
| `docs/architecture/2026-05-31-production-flow-otel-coverage.md` | Historical empirical artifact, not cannon | No, reference/gate evidence | no direct bead; seam gate exists in tooling | DONE-CLOSE | source-verified |
| `docs/architecture/2026-05-31-unified-architecture-mental-model.md` | Historical design aid, not cannon | No direct backlog item | none direct | ARCHIVE | inferred |
| `docs/architecture/2026-06-02-runtime-dynamics-map.md` | Recent current-state aid, not cannon | Yes: corpus/baseline drift plus tracked annotation work | annotation work tracked by `tf-a07s`, `tf-mmh2`, `tf-ykd5`, `tf-fp3a`; no corpus/baseline owner found | CREATE-BEAD for corpus/baseline realignment; TRACKED for annotation work | source-verified |
| `docs/architecture/2026-06-02-runtime-structure-map.md` | Recent current-state aid, not cannon | Mostly reference; low-risk starters partly stale | no direct bead; source shows empty-dir note stale | DONE-CLOSE / reference; no bead from stale starter list | source-verified |
| `docs/architecture/current-architecture-alignment-review.md` | Historical alignment review, not cannon | Yes, old follow-ups | no direct current owner found | ARCHIVE; do not mint from old review | inferred |
| `docs/architecture/host-sdk-runtime-boundary-open-questions-framing.md` | Root duplicate/historical; cannon copy exists | No untracked work | refs `tf-gc7c`, `tf-rvt5`, `tf-7knr`, `tf-2y01`, `tf-0r95`, `tf-kddg` | ARCHIVE root copy; cannon copy is authoritative | bead/doc-verified |
| `docs/architecture/host-sdk-runtime-boundary.md` | Root duplicate/historical; cannon copy exists | Yes, wave notes | refs `tf-zchu`; cannon copy carries current authority | ARCHIVE root copy; TRACKED by existing waves | bead/doc-verified |
| `docs/architecture/legacy-drift-inventory-2026-05-12.md` | Historical inventory, not cannon | Yes, old recommended follow-ups | none direct | ARCHIVE | inferred |
| `docs/architecture/managed-agent-control-surface.md` | Historical draft inventory, not cannon | Yes, but old managed-agent surface framing | no direct bead found | ARCHIVE; no implementation bead from stale draft | inferred |
| `docs/architecture/managed-agent-runtime-target-durable-facts.md` | Historical target doc, not cannon | No current open item; superseded by cannon | no direct bead found | ARCHIVE | inferred |
| `docs/architecture/runtime-context-fact-matrix.md` | Historical reference, not cannon | No direct open item | none direct | ARCHIVE | inferred |
| `docs/architecture/runtime-dynamics-map.md` | Historical 2026-05-22 map, not cannon | Yes, but superseded by 2026-06-02 map and shrink beads | refs `tf-jpcg`, `tf-7kq8`, `tf-aseo` | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/architecture/runtime-env-boundary.md` | Recent reference, not cannon | No new work; boundary fact plus validation | `tf-pgn` matches host spawn env gap | TRACKED | source-verified |
| `docs/architecture/runtime-shape-falsification.md` | Historical/reference test plan, not cannon | Yes, falsification plan | refs `tf-jpcg`, `tf-7kq8`, `tf-aseo`, `tf-sto7`, `tf-vfq9` | TRACKED | bead/doc-verified |
| `docs/architecture/runtime-shrink-loop.md` | Historical playbook, not cannon | Yes, but already beaded | `tf-tj25`, `tf-2dz9`, `tf-a07s`, `tf-mmh2`, `tf-ykd5`, `tf-fp3a` | TRACKED | bead/doc-verified |
| `docs/architecture/shape-c-vs-shape-d.md` | Transitional/historical, not cannon | Yes, transitional cutover framing | refs `tf-c9r9`, `tf-jpcg`, `tf-vfq9`, `tf-12q9` | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/architecture/unified-subscriber-kernel.md` | Historical synthesis, not cannon | Yes, but explicit work map | refs `tf-c9r9`, `tf-vrz6`, `tf-jpcg`, `tf-vfq9`, `tf-aseo`, `tf-12q9` | TRACKED | bead/doc-verified |
| `docs/sdds/DECISION_PATH_X_PROCESS_OWNERSHIP.md` | Historical decision, not cannon | No current open item; decision record | draft PR #303 refs, no current bead | ARCHIVE | inferred |
| `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md` | Recent draft/current-current handoff doc, not cannon | Yes, but explicitly beaded by section | many refs under `tf-0awo.*`; `tf-0awo.41` committed doc | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_CHOREOGRAPHY_FACADE.md` | Historical proposal, not cannon | Yes, broad facade proposal | choreography work exists in `tf-r06u.9`, `tf-fmwg`, `tf-v8i4`, `tf-b4b`, but no exact facade owner | ARCHIVE; do not create broad stale facade bead | bead/doc-verified |
| `docs/sdds/SDD_CLIENT_CONTROL_PLANE_STREAM_URL_SURFACE.md` | Historical/draft implementation record, not cannon | No; framing question resolved | `tf-76s` | TRACKED / DONE-CLOSE | bead/doc-verified |
| `docs/sdds/SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS.md` | Historical proposal-era background, not cannon | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md` | Historical draft framing, not cannon | Yes, old client/host boundary questions | related `tf-1z5`, `tf-7sz`, `tf-a14` | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY_IMPLEMENTATION.md` | Historical implementation draft, not cannon | Yes, old implementation plan | related client boundary beads above | TRACKED/ARCHIVE | inferred |
| `docs/sdds/SDD_DURABLE_AGENT_RUNTIME_LAB.md` | Historical proposal, not cannon | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_DURABLE_AGENT_SUBSTRATE.md` | Historical large substrate proposal, not cannon | No current open item; superseded by cannon | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE.md` | CANONICAL bridge reference via cannon `../sdds`; target superseded | No new open item beyond recorded bridge/follow-ons | `tf-qk6h`, `tf-7kq8` | TRACKED / DONE-CLOSE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` | Root historical duplicate; cannon copy exists | No root-copy work | cannon copy is authoritative | ARCHIVE root copy | inferred |
| `docs/sdds/SDD_FIREGRID_AGENT_COORDINATION_PATTERNS.md` | Recent proposal, not cannon | Yes | `tf-0awo.45` explicitly triages this SDD | TRACKED | source-verified |
| `docs/sdds/SDD_FIREGRID_AGENT_OUTPUT_SSOT.md` | Historical draft, not cannon | Yes, SSOT consolidation | `tf-1fr` matches AgentOutputEvent SSOT | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md` | Explicitly non-canonical historical per cannon | No current open item; cutover plan superseded | primary bead `tf-auuv`, plus phase lane refs in doc | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_ARCHITECTURE_AND_INVOCATION_BOUNDARY.md` | Historical draft, not cannon | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md` | Historical draft, not cannon | Yes, old client/host cutover | related `tf-1z5`, `tf-7sz`, `tf-a14` | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_CLI_LAUNCHERS.md` | Recent draft, not cannon | Yes, but already implemented/tracked in pieces | `tf-0awo` epic plus `tf-0awo.8`, `.9`, `.10`, `.11`, `.12`, `.13`, and `tf-r06u.38`; source has `packages/runtime/src/bin/{firegrid,run,acp,start}.ts` | TRACKED / mostly DONE-CLOSE | source-verified |
| `docs/sdds/SDD_FIREGRID_DARK_FACTORY_APP.md` | Historical draft implementation contract, not cannon | Yes, factory app target | `tf-b4b`, `tf-0du`, `tf-0awo.29`, `tf-0awo.30` | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md` | Historical canonized framing, not cannon root | No; production closed | `tf-1r3h` | DONE-CLOSE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_DURABLE_WAIT_EXTRACTION.md` | Historical draft, not cannon | No current open item; durable-tools deleted/superseded | related `tf-auuv` | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_EFFECT_QUALITY.md` | Historical draft, not cannon | No direct untracked work | quality/lint work tracked elsewhere, e.g. strict gates and `tf-uc8u` family | TRACKED/ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH.md` | Root duplicate; cannon copy exists | Potential contingency track, but cannon copy is authority | cannon copy | ARCHIVE root copy | inferred |
| `docs/sdds/SDD_FIREGRID_FACTORY_ALIGNED_AGENT_TOOL_WORKSTREAM.md` | Historical/draft, not cannon | Yes, factory workstream | `tf-0awo.29`, `tf-0awo.30`, `tf-b4b` | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_FACTORY_PLATFORM_FIT.md` | HISTORICAL pre-#765 | Yes, old factory fit notes | factory capability beads exist, but doc stale | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_FACTORY_RUN_PROCESS.md` | Historical draft, not cannon | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_FIRELINE_READINESS.md` | HISTORICAL pre-#765 | Yes, old Fireline readiness | `tf-v1q2` covers one Fireline record slice; broader doc stale | ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_FIREPIXEL_FOUNDATION.md` | Historical draft, not cannon | Yes, but stale product foundation proposal | no matching bead found | ARCHIVE; no CREATE unless product direction is revived | inferred |
| `docs/sdds/SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS.md` | Recent draft, not cannon | Yes | `tf-r06u.22`, `tf-r06u.2`, `tf-r06u.12`, `tf-r06u.13`, `tf-r06u.6`, `tf-r06u.26`, `tf-r06u.27`, `tf-x3sv` | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md` | CANONICAL via cannon `../sdds` | No; shipped router/ACP edge | `tf-9x11`, `tf-csr0`, `tf-p1aw` | DONE-CLOSE / TRACKED | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_HOST_SDK.md` | HISTORICAL pre-#765 | No current open item; old host-sdk target | `tf-mrq` matches host surface history | ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_HOST_SURFACE.md` | Historical draft, not cannon | No; host surface gap tracked/closed | `tf-mrq` | DONE-CLOSE / ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` | Historical root doc, not cannon | Yes, but already beaded | refs `tf-kddg`, `tf-6w3s`, `tf-yxdd`; broader one-substrate beads exist | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` | Root duplicate; cannon copy exists | No root-copy work | `tf-auuv` and phase-1 beads closed | ARCHIVE root copy | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_PACKAGE_STRUCTURE.md` | Historical active-at-time package structure doc, not cannon | No untracked current item found | no exact bead found | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md` | Historical ratified target, not cannon | No current open item; old reshape | related `tf-ws2x`, `tf-ho99` era | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.md` | Recent proposed SDD, not cannon | Yes, but maps to named migration beads | refs `tf-c9r9`, `tf-vrz6`, `tf-jpcg`, `tf-vfq9` | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION_PREFLIGHT.md` | Recent proposed preflight, not cannon | Yes, but same migration family | related protocol/op-registry cutover beads `tf-yuvd`, `tf-1osk`, plus refs above | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md` | Historical draft target, not cannon | No untracked current item | runtime pipeline work superseded by unified/cannon docs | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md` | Recent follow-up proposal, not cannon | Yes, but explicitly beaded | refs `tf-bffo`, `tf-rd3d`, `tf-9x11`, `tf-77ab`, `tf-4fy3` | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_RUNTIME_CLI_VALIDATION.md` | Historical draft, not cannon | No current open item | CLI work now tracked by `tf-0awo.*` and `tf-r06u.38` | ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_RUNTIME_COMPOSITION_ERGONOMICS.md` | Historical accepted doc, not cannon | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_RUNTIME_HOST_MODULARITY.md` | Historical draft, not cannon | Yes, but current composition work tracked | `tf-0awo.18` through `tf-0awo.26` family | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_RUNTIME_START_CAPABILITY_DEPS.md` | HISTORICAL pre-#765 | No current open item; TFIND-029/TFind-005 history | `tf-mzo`, `tf-c68` | ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` | Root duplicate; cannon copy exists | Yes, but already active in beads | `tf-2pcy`, `tf-yuvd`, `tf-pxxe`, `tf-7whh` | TRACKED; archive root duplicate if cannon copy is source | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES.md` | Historical draft, not cannon | Yes, old client surfaces | related client cutover beads `tf-vgpv`, `tf-788q`, `tf-iv4n` | TRACKED/ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_SESSION_OBSERVATION_SURFACE.md` | Historical draft, not cannon | No; surface gap closed/tracked | `tf-j08` | DONE-CLOSE / ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_SNAPSHOT_EVENT_TYPING.md` | Historical draft, not cannon | No; duplicate of snapshot typing family | `tf-j94` | DONE-CLOSE / ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_TYPED_RUNTIME_RUN_API.md` | Historical draft, not cannon | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md` | Historical; status says durable-tools deleted | No | durable-tools deletion `tf-6d4y`, `tf-auuv` | ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER.md` | Recent implementation record, not cannon | Yes, but follow-ons explicit | `tf-ll90.11.2`, `tf-ll90.11.1`, `tf-ll90.17`, `tf-ll90.15` | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md` | Recent implementation record, not cannon | No untracked work | follow-up SDD and unified beads already landed/tracked | DONE-CLOSE | bead/doc-verified |
| `docs/sdds/SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md` | Historical/partially superseded | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_MCP_ROUTE_URL_LIFECYCLE.md` | Historical ratified decision, not cannon | No untracked work; lifecycle is current plumbing | CLI/MCP cutover beads cover current surface | DONE-CLOSE / TRACKED | inferred |
| `docs/sdds/SDD_NEXT_LAYER_REVIEW_SEQUENCE.md` | Historical proposal, not cannon | No current open item | none direct | ARCHIVE | inferred |
| `docs/sdds/SDD_PATH_X_IMPLEMENTATION.md` | Historical ratified Path X record, not cannon | No current open item; superseded by later runtime work | Path X/one-substrate beads closed | ARCHIVE | inferred |
| `docs/sdds/SDD_PERMISSION_CODEC_AUTHORITY.md` | Historical signed-off SDD, not cannon | No; implemented in PR #350 | `tf-wyu` and permission-flow family | DONE-CLOSE / ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_RECONCILER_ENV_ENUMERATION.md` | Historical TFIND-045 record, not cannon | No; bug tracked | `tf-fmh`, `tf-uiz` | DONE-CLOSE / ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_RUNTIME_CONTEXT_WORKFLOW_INPUT_TABLE_CUTOVER.md` | Recent draft cutover spec, not cannon | Yes | `tf-kk63`, amendment `tf-87vj`, refs `tf-vrz6`, `tf-9rpy`, `tf-qk6h`, `tf-i05u`, `tf-eta6` | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_SESSION_LIFECYCLE_APPEND_POINT.md` | Historical implemented decision, not cannon | No | `tf-jri`, `tf-auk`, `tf-p7w` | DONE-CLOSE | bead/doc-verified |
| `docs/sdds/SDD_SNAPSHOT_OBSERVATION_TYPING.md` | Historical implementation record, not cannon | No | `tf-j94`, `tf-5h7`, `tf-1fr`, `tf-j08` | DONE-CLOSE | bead/doc-verified |
| `docs/sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md` | CANONICAL via cannon `../sdds` | Yes, dispatchable reference | `tf-3w1e`, reconciled by `tf-qnq9`; downstream target beads exist | TRACKED | bead/doc-verified |
| `docs/sdds/SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md` | Historical TFIND-031 decision, not cannon | No; status says DONE | `tf-zfe` and TFIND-031 family | DONE-CLOSE / ARCHIVE | bead/doc-verified |
| `docs/sdds/SDD_WAIT_ROUTER_PERCONTEXT_OUTPUT.md` | Historical TFIND-012 framing, not cannon | No; finding is bead-linked | `tf-8rp` | DONE-CLOSE / ARCHIVE | bead/doc-verified |
