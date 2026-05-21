# tf-d6s9 — Factory-vision capability map + current-state delivery plan

Date: 2026-05-21
Status: PLANNING MAP (source-of-truth for tf-5n1z EPIC fanout; no implementation)
Bead: tf-d6s9 (P1) — parent tf-5n1z (Factory vision delivery EPIC)
Owner: Lane 5 (opus)
Feeds: tf-7ecs (vision operational-state refresh), tf-o3x4 (delegation proof),
tf-l5cg (factory-ready capstone sim)

Maps the seven factory-vision §7 capabilities (`docs/vision/factory-vision.md`)
to CURRENT Firegrid surfaces / tests / beads after the channel-collapse wave.
This is the task-graph map for coordinator fanout, NOT an implementation.

## §0 Operational-reference corrections (the vision path is stale)

The vision doc + its operational hooks reference artifacts that no longer exist
in this checkout. tf-7ecs should fold these corrections into the vision prose;
this map uses the corrected current state throughout.

| Stale reference | Current reality |
| --- | --- |
| `apps/factory` (§A "real consumer side", §6.5) — "exercises several capabilities cleanly through public-shaped boundaries" | **Does not exist** (`apps/` is absent). The real-consumer proof role is now carried by **`packages/tiny-firegrid/` simulations over the public client/channel surface**. |
| `packages/tiny-firegrid/FINDINGS.md` + `CONFIGS.md` (§9 "operational hook", §8 convergence) — markdown ledgers of gaps/configs | **Retired into beads** (br). Findings/configs are now beads with the `tfind:`/channel/spike labels; `bv --robot-triage` is the authority. No FINDINGS.md/CONFIGS.md files. |
| "configurations" as the unit (§8) — small TS files wiring one capability | Now **simulations** under `packages/tiny-firegrid/src/simulations/<id>/{host,driver,index}.ts` (post-#426 runner shape), discovered by `simulate:list`. |
| Capstone = `apps/factory` end-to-end | Capstone = **tiny-firegrid over public channels** (trigger→reviewed-action trace through the public client/channel surface). This is tf-l5cg. |

## §1 Capability map (§7 capabilities 1–7)

Status legend: **DELIVERED** (provable through the public surface today),
**PARTIAL** (core delivered; a named piece deferred/gapped), **GAPPED**
(no public-surface proof yet).

| # | Capability | Status | Current proof (landed) | Missing proof | Owning bead/PR | Reach-past? | Beta: blocker vs carveout |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Accept external events as durable verified facts | **DELIVERED** | `verified-webhook` protocol channel + host binding (tf-24jn `8da115c7d`); `VerifiedWebhookFactSchema`; `verified-webhook-ingest` adapter (verification/keying/idempotent insert/conflict reject); sim `linear-webhook-cookbook-composition` (signed Linear route → verified facts → `firegrid.verifiedWebhooks` wait_for) | A capstone trace that chains fact→planner→action through the public surface (covered by tf-l5cg) | tf-24jn (landed); tf-h0ku external-trigger loop (`#561` wip) | No — product owns HTTP route/secret/taxonomy; substrate owns fact (boundary correct) | Carveout-clean. Not a blocker. |
| 2 | Hold a participant's identity durably across time | **DELIVERED** | RuntimeContext as durable workflow-engine state (WorkflowEngineTable); `firegrid.sessions.createOrLoad` keyed by externalKey → deterministic contextId; suspend/resume across restart (inv2-waitforworkflow, phase0-wave-2b restart-replay) | The "wait for human approval, planner becomes a row, resumes on trigger" capstone path end-to-end (tf-l5cg) | tf-lf9p (createOrLoad reflected-barrier, Fork 2, ratified — wave-gated on #570) hardens the readiness seam | No | Not a blocker. tf-lf9p is an ergonomic hardening (race removal), not a capability gap. |
| 3 | Map one external intent to one participant | **DELIVERED** | `createOrLoad` = idempotent find-or-create: `control.contextRequests.insertOrGet` on the deterministic `sessionContextIdForExternalKey([source,id])`; redelivery/retry/replay → one participant; sim `idempotent-one-intent-pipeline` (same key→one participant, different key→distinct) | Public-surface capstone restating this on the real trigger loop (tf-l5cg) | tf-aago (`#560`, createOrLoad channelized) | No | Not a blocker. |
| 4 | Let participants delegate to other participants | **PARTIAL** | Agent-tool surface: `spawn`/`spawn_all`/`session_new` lower to `AgentToolHost.spawnChildContext(s)` with deterministic child contextId from (parent, toolUseId) + parent correlation; sim `inv5-cross-agent-event-choreography` (two ACP agents coordinate via a shared event channel, no orchestrator) | A PUBLIC-SURFACE delegation proof: parent→child handoff with parent correlation, child observable from outside + resumable from inside, through the paved client/channel surface (not just the agent-tool/sim path) | **tf-o3x4 (delegation proof)** — the EPIC sibling this map feeds | Partial — choreography proven via agent tools + sim event channel; the public client-surface delegation ergonomics are the tf-o3x4 deliverable | Beta: delegation proof is in-scope (tf-o3x4). Not a release blocker if the agent-tool path is the accepted v1 surface; flag for Gurdas. |
| 5 | Let participants wait for things | **DELIVERED** | `wait_for`/`wait_for_any` agent verbs over ingress/callable channels; durable suspend (consume zero compute, resume on matching durable fact) via WaitForWorkflow; channels: `SessionAgentOutput` (Sim 1 #537), `HostContexts` (tf-qu7l #566), `verifiedWebhooks` (tf-24jn), `SessionPermission`/`SessionLifecycle`; sims inv2-waitforworkflow, wait-pre-attach-roundtrip, durable-channels-sync-async-spike (tf-lfxs #567) | Capstone: planner waits on a human decision + an external fact in one trace (tf-l5cg) | tf-lfxs (`#567`, sync/async framing validated) | No | Not a blocker. |
| 6 | Take actions in the world + remember what they did | **PARTIAL (by design)** | Action invocation = MCP tools the agent calls (attach via `RuntimeConfig.mcpServers`, tf-505d paved-road docs `#568`); evidence = durable agent-output observation rows (`ToolUse` journaled to RuntimeOutputTable, replay/audit) + permission gating. tf-x1jx design (`#562`) settled the framing. | A durable ACTION-RECEIPT path (claim-before-side-effect, durable evidence/receipt rows, retries, waitable completion) — intentionally NOT built; promote to a Firegrid durable channel ONLY on concrete crash-durability pressure (the tf-x1jx "decision test") | tf-x1jx (design, landed); tf-30nu REDIRECTED away from a channel to an MCP-tool demo; promotion bead filed when pressure appears | No — provider semantics stay in MCP tools / app, not protocol channels (boundary correct) | **Carveout, with a named edge.** For beta, "action = MCP tool + durable observation" is the accepted surface. The durable-receipt promotion is gated on a real requirement (NOT a beta blocker). FLAG: if the factory capstone needs a waitable action-receipt, that's the first promotion trigger — surface to Gurdas. |
| 7 | Let everyone see what's happening | **DELIVERED** | The substrate IS the log: agent-output observation channels + RuntimeOutputTable; normalized `RuntimeAgentOutputObservation` (Sim 1 #537, tf-05jj #557 collapsed the parallel paths); `watchContexts`/`whenReady` over `HostContexts` (tf-qu7l #566); observability span contract (tf-kb0i `#543`); operators/agents/dashboards read one event stream | Capstone showing operator + agent + aggregate all reading the same trace (tf-l5cg) | tf-kb0i (span contract, landed); tf-05jj (#557); tf-qu7l (#566) | No | Not a blocker. |

## §2 Summary of state

- **5 of 7 DELIVERED through the public surface** (1, 2, 3, 5, 7). The
  channel-collapse wave (tf-aago/tf-qu7l/tf-jbtu/tf-2ld2/tf-35f4/tf-05jj/tf-24jn)
  put these on paved channel projections with sim proof.
- **Cap 4 (delegate) — PARTIAL**: choreography proven via agent tools + a sim
  event channel; the public-surface delegation ergonomics proof is **tf-o3x4**.
- **Cap 6 (act + remember) — PARTIAL by design**: action = MCP tool + durable
  observation (settled by tf-x1jx); the durable action-receipt path is a
  gated-on-pressure promotion, not a beta blocker. This is the one capability
  whose "full" shape is deliberately deferred.

No capability is a hard beta blocker on substrate grounds. The remaining work is
(a) one public-surface delegation proof (tf-o3x4), (b) the capstone trace that
chains 1→2→3→4→5→(6 as MCP tool)→7 (tf-l5cg), and (c) the vision-doc operational
refresh (tf-7ecs).

## §3 Delivery plan to the factory-ready public-surface capstone

Sequenced; all post-baseline (#570). The capstone is "external trigger →
reviewed action, traced, over public channels" (tf-l5cg).

1. **tf-7ecs — vision operational refresh (docs).** Fold §0's corrections into
   `docs/vision/factory-vision.md`: drop `apps/factory`, retire FINDINGS/CONFIGS
   references to the bead model, recast "configurations" as simulations, recast
   the capstone as tiny-firegrid-over-public-channels. Independent; can run now.
2. **tf-o3x4 — delegation proof (Cap 4 → DELIVERED).** Prove parent→child
   delegation through the public surface (parent correlation, outside-observable,
   inside-resumable). Closes the one PARTIAL that isn't deferred-by-design.
   Depends on the post-#570 wave; uses the existing spawn/session_new + channel
   surface. May surface a public-surface delegation ergonomic gap (capture as a
   finding if so).
3. **tf-l5cg — factory-ready capstone sim (the integrative proof).** One trace,
   public channels only: a verified webhook fact (Cap 1) creates/loads one
   planner (Cap 2+3), the planner waits on a human decision + external fact
   (Cap 5), delegates to an implementer/reviewer (Cap 4), takes an action via an
   MCP tool with durable observation evidence (Cap 6 as the beta surface), and
   the whole thing is inspectable as one event stream (Cap 7). This is the
   factory-ready acceptance artifact. Depends on tf-o3x4 (delegation) landing.
4. **Cap 6 promotion (GATED, only if tf-l5cg needs it).** If the capstone needs a
   waitable/claimed action receipt (not just observation), that is the first
   concrete crash-durability pressure → file the durable-action-channel promotion
   per the tf-x1jx decision test. Otherwise the MCP-tool+observation surface
   stands for beta.

Dependency shape: `tf-7ecs` (parallel, now) ; `tf-o3x4` → `tf-l5cg` ; `tf-l5cg`
may trigger the Cap-6 promotion. tf-d6s9 (this map) unblocks all three.

## §4 Open questions for coordinator / Gurdas

1. **Cap 4 v1 surface**: is the agent-tool spawn/session_new path the accepted v1
   delegation surface, with tf-o3x4 proving it through public channels — or does
   beta need a dedicated client-surface delegation method? (Shapes tf-o3x4 scope.)
2. **Cap 6 beta line**: confirm "action = MCP tool + durable observation" is the
   accepted beta surface, with the durable action-receipt deferred until the
   capstone (or a real consumer) demonstrates the crash-durability need. (Per
   tf-x1jx; this map assumes yes.)
3. **Capstone scope (tf-l5cg)**: should the capstone exercise a REAL external
   trigger (live signed webhook) end-to-end, or a sim-injected verified fact? The
   `linear-webhook-cookbook-composition` sim already does the signed-route→fact
   half; tf-l5cg chains the rest.

## §5 Cross-references

- `docs/vision/factory-vision.md` §6/§6.5/§7/§8/§9/§A — the north star + stale ops
- Cap 1: `packages/protocol/src/channels/verified-webhook.ts`,
  `packages/host-sdk/src/host/channels/verified-webhook/`, sim
  `linear-webhook-cookbook-composition` (tf-24jn `8da115c7d`, tf-h0ku `#561`)
- Cap 3: `sessionContextIdForExternalKey` + `contextRequests.insertOrGet`; sim
  `idempotent-one-intent-pipeline`
- Cap 4: `packages/host-sdk/src/agent-tools/` spawn/session_new; sim
  `inv5-cross-agent-event-choreography`; tf-o3x4
- Cap 5: `wait_for`/`wait_for_any`; `durable-channels-sync-async-spike`
  (tf-lfxs `#567` / `SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md`)
- Cap 6: `docs/proposals/tf-x1jx-external-mcp-attachment-design.md` (`#562`),
  client-sdk README "Attaching External MCP Tools" (tf-505d `#568`), tf-30nu redirect
- Cap 7: tf-kb0i span contract (`#543`), tf-05jj (`#557`), tf-qu7l (`#566`)
- Channel-collapse wave: tf-aago `#560`, tf-qu7l `#566`, tf-jbtu `#537`,
  tf-2ld2 `#535`, tf-35f4 `#539`, tf-05jj `#557`
- EPIC: tf-5n1z (parent); siblings tf-7ecs, tf-o3x4, tf-l5cg
