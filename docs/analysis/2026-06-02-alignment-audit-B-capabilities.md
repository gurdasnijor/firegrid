# Alignment Audit B — factory capabilities and Brookhaven external use-case

Date: 2026-06-02
Bead: `tf-0awo.34.2`
Base: `origin/main` at shared target `da2d4104a`

## Scope

This refresh audits the stale factory capability map against the current
post-§12 shape: `FiregridRuntime(spec, adapter)`, the durable-streams floor,
protocol-owned read views, and authority collapse. It also checks whether the
Brookhaven Roblox in-game agent use-case can be served through generic public
surfaces without building consumer-specific substrate bridges.

The 2026-05-21 capability map is no longer a reliable operating map. It names
deleted or superseded simulations (`linear-webhook-cookbook-composition`,
`inv5-cross-agent-event-choreography`, `idempotent-one-intent-pipeline`,
`durable-channels-sync-async-spike`) in
`docs/vision/factory-vision.md:267-284` and
`docs/handoffs/tf-d6s9-factory-vision-capability-map.md:35-41`. Current proof
coverage is the merged post-§12 proof set: #833 (`tf-0awo.31a`), #832
(`tf-0awo.31.1`), #835 (`tf-0awo.31.3`), and #834 (`tf-0awo.30b`).

## Refreshed Capability Map

| # | Factory capability | Current state | Current proof / source evidence | Bead coverage | Real gap |
|---|---|---|---|---|---|
| 1 | External events become durable verified facts | Aligned and proven through the public surface | `verified-webhook-wait` composes real post-§12 `FiregridRuntime(spec, adapter)`, product-owned signed route, real `ingestVerifiedWebhook`, and public `firegrid.wait.for` over `firegrid.verifiedWebhooks` (`packages/tiny-firegrid/docs/findings/tf-0awo.31a-verified-webhook-wait.md:10-18`, `:36-46`). The generic channel target remains `firegrid.verifiedWebhooks` (`packages/runtime/src/channels/verified-webhook/source-live.ts:222-230`, `:303-320`). | #833 / `tf-0awo.31a` | None at substrate level. Product route, secret lookup, and provider taxonomy stay consumer-owned, matching `docs/vision/factory-vision.md:255-265`. |
| 2 | Durable participant identity | Aligned for identity creation; terminal lifecycle still has a live relay gap | `createOrLoad` is a protocol-owned client operation (`packages/protocol/src/session-facade/operations.ts:51-56`) keyed by a deterministic external-key context id (`packages/protocol/src/session-facade/schema.ts:616-623`). Capstone creates a delegated child context and observes it (`docs/findings/tf-0awo.30-factory-capstone-sim.md:28-43`, `:49-52`). | #832 / `tf-0awo.31.1`; #834 / `tf-0awo.30b`; #835 / `tf-0awo.31.3` | `tf-r06u.36` remains open: `JournalObserverLive` has no `TurnComplete`/`Terminated` terminal-signal branch (`packages/runtime/src/unified/observers.ts:57-90`), while the session body deregisters only after a `kind:"terminal"` signal (`packages/runtime/src/unified/subscribers/runtime-context.ts:113-153`). This affects durable promptability/liveness cleanup, not external-key identity hashing. |
| 3 | One external intent maps to one participant | Aligned and proven | `comp-sim-idempotent` drives eight public `sessions.createOrLoad` calls: six same-key deliveries collapse to one context id, different key/source produce distinct ids (`packages/tiny-firegrid/docs/findings/tf-0awo.31.1-idempotent-one-intent.md:18-28`, `:40-58`). | #832 / `tf-0awo.31.1` | None. |
| 4 | Participants can delegate to other participants | Aligned for the ACP runtime-context MCP path | `cross-agent-delegation` proves an ACP parent calls host-bound `session_new`, receives a child context, and the child output is observed through public `firegrid.open(childContextId).snapshot` (`docs/findings/tf-0awo-31-3-cross-agent-delegation.md:10-24`, `:72-91`). The dispatch contract records deterministic parent correlation (`docs/findings/tf-0awo-31-3-cross-agent-delegation.md:55-70`). | #835 / `tf-0awo.31.3`; #834 / `tf-0awo.30b` | Raw `stdio-jsonl` tool-use cannot invoke `session_new`; the finding classifies that as by-construction/off-path for this proof (`docs/findings/tf-0awo-31-3-cross-agent-delegation.md:26-53`). |
| 5 | Participants can wait for things | Aligned and proven over protocol read views | Cap-1 proves public `firegrid.wait.for` on `firegrid.verifiedWebhooks` (`packages/tiny-firegrid/docs/findings/tf-0awo.31a-verified-webhook-wait.md:14-18`). Capstone proves `wait_for` on `darkFactory.facts` and parent waits over `session.agent_output` (`docs/findings/tf-0awo.30-factory-capstone-sim.md:20-24`, `:41-43`). The `session.agent_output` route is a cursored protocol read view over `RuntimeAgentOutputObservation` (`packages/runtime/src/channels/session-agent-output-route.ts:14-33`, `:58-67`). | #833 / `tf-0awo.31a`; #834 / `tf-0awo.30b` | Minor ergonomic gap: the route schema requires `afterSequence` (`packages/runtime/src/channels/session-agent-output-route.ts:35-46`), and the capstone planner initially omitted it before recovering (`docs/findings/tf-0awo.30-factory-capstone-sim.md:66-71`). This is not a substrate gap. |
| 6 | Actions happen in the world and leave evidence | Partial; MCP-tools-first design is aligned, durable action receipt remains unbuilt | `tf-x1jx` closed with provider actions as MCP tools by default and promotion to durable channels only under claim/receipt/retry/waitable-evidence pressure (bead `tf-x1jx`, PR #562). Current toolkit still advertises `execute` (`packages/runtime/src/unified/mcp-host/toolkit.ts:180-192`), but the MCP dispatcher has no `execute` arm and falls through to "not yet ported" (`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:519-606`). Capstone stops before a completed action receipt after the child requests `execute` permission (`docs/findings/tf-0awo.30-factory-capstone-sim.md:54-80`). | #834 / `tf-0awo.30b`; design tracked by `tf-x1jx` | Real gap for full factory/Brookhaven publish: either port/remove the generic `execute` tool and add a consumer MCP publish tool, or build the durable action-receipt promotion when a waitable receipt is required. |
| 7 | Everyone can see what happened | Aligned for output/progress observation; terminal lifecycle still depends on `tf-r06u.36` | The observation union includes `TextChunk`, `ToolUse`, `PermissionRequest`, `TurnComplete`, `Error`, and `Terminated` (`packages/protocol/src/session-facade/schema.ts:280-329`). Capstone observes child output from the parent after delegation (`docs/findings/tf-0awo.30-factory-capstone-sim.md:41-45`). | #834 / `tf-0awo.30b`; #835 / `tf-0awo.31.3` | `Terminated`/`TurnComplete` are observable rows, but they do not currently drive the session body's terminal signal; tracked by `tf-r06u.36`. |

## Brookhaven Alignment Verdict

Verdict: the generic substrate is sufficient for the Brookhaven in-game agent
shape if the edge is a scoped/opaque-handle auth proxy over durable-streams
append/read, not a Brookhaven-specific Firegrid gateway. The use-case is tracked
by deferred epic `tf-qne2`, whose comment explicitly corrects the transcribed
Brookhaven bridge work: no parallel intent stream, no `{kind}` translator
observer, no bespoke edge-auth package; use a thin scoped shape proxy, append to
the existing input surface, and maybe add a publish MCP tool.

Brookhaven's hard constraints are poll-only HTTP, one public tunnel, one Bearer
credential, and no SSE/WebSocket/long-lived connections
(`docs/rfc/external/brookhaven-roblox-in-game-agent.md:96-113`). Its requested
substrate shape is append one prompt intent, cursor-poll projections, observe
required actions, and see a durable publish terminal
(`docs/rfc/external/brookhaven-roblox-in-game-agent.md:121-147`,
`:167-176`). The current solution map already collapses this to one real edge
gap: scoped per-stream authorization/opaque handles; durable-streams remains the
single append/read authority and a Firegrid HTTP gateway is an anti-pattern
(`docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md:45-67`,
`:255-276`, `:329-380`). The consumer contract still contains bridge-shaped
wording for an intent observer (`docs/analysis/2026-06-01-brookhaven-consumer-contract.md:220-228`),
but `tf-qne2` supersedes that: writes should go to the existing input surface
through auth/scope, not a consumer-specific translator stream.

## Findings

**F-01 — 2026-05-21 factory capability map is stale after #765 and the post-§12 proof sims** — EVIDENCE(`docs/vision/factory-vision.md:267-284`, `docs/vision/factory-vision.md:448-490`, `docs/handoffs/tf-d6s9-factory-vision-capability-map.md:35-41`) — CLASSIFICATION(stale) — DISPOSITION(off-path the target) — SUGGESTED BEAD("Refresh factory vision §6.5/§A and retire deleted sim names", P2)

**F-02 — Capability 1 is aligned: product-owned webhook route writes generic verified facts, then public wait_for observes them** — EVIDENCE(`#833`, `tf-0awo.31a`, `packages/tiny-firegrid/docs/findings/tf-0awo.31a-verified-webhook-wait.md:10-18`, `packages/tiny-firegrid/docs/findings/tf-0awo.31a-verified-webhook-wait.md:36-46`, `packages/runtime/src/channels/verified-webhook/source-live.ts:222-230`) — CLASSIFICATION(aligned) — DISPOSITION(supports the target) — tracked-by(`tf-0awo.31a`)

**F-03 — Capabilities 2 and 3 are aligned for durable identity/idempotency, but terminal cleanup still has a live relay gap** — EVIDENCE(`#832`, `tf-0awo.31.1`, `packages/tiny-firegrid/docs/findings/tf-0awo.31.1-idempotent-one-intent.md:40-58`, `packages/protocol/src/session-facade/schema.ts:616-623`, `packages/runtime/src/unified/observers.ts:57-90`, `packages/runtime/src/unified/subscribers/runtime-context.ts:113-153`, bead `tf-r06u.36`) — CLASSIFICATION(gap) — DISPOSITION(gates the target) — tracked-by(`tf-r06u.36`)

**F-04 — Capability 4 is no longer the old tf-o3x4 partial: ACP runtime-context MCP delegation is proven through the public surface** — EVIDENCE(`#835`, `tf-0awo.31.3`, `docs/findings/tf-0awo-31-3-cross-agent-delegation.md:10-24`, `docs/findings/tf-0awo-31-3-cross-agent-delegation.md:72-91`, `docs/findings/tf-0awo-31-3-cross-agent-delegation.md:145-152`) — CLASSIFICATION(aligned) — DISPOSITION(supports the target) — tracked-by(`tf-0awo.31.3`)

**F-05 — Raw stdio-jsonl delegation by synthetic tool_use is off-path, not a missing factory primitive** — EVIDENCE(`docs/findings/tf-0awo-31-3-cross-agent-delegation.md:26-53`) — CLASSIFICATION(boundary-violation) — DISPOSITION(off-path the target) — tracked-by(`tf-0awo.31.3`)

**F-06 — Capability 5 is aligned, with a non-gating afterSequence ergonomics gap on session.agent_output waits** — EVIDENCE(`#833`, `#834`, `packages/tiny-firegrid/docs/findings/tf-0awo.31a-verified-webhook-wait.md:14-18`, `docs/findings/tf-0awo.30-factory-capstone-sim.md:66-71`, `packages/runtime/src/channels/session-agent-output-route.ts:35-67`) — CLASSIFICATION(gap) — DISPOSITION(off-path the target) — SUGGESTED BEAD("Default or document session.agent_output wait_for afterSequence for MCP callers", P2)

**F-07 — Capability 6 remains the real factory/Brookhaven gap: durable action receipt / publish terminal is not yet proven** — EVIDENCE(`tf-x1jx`, `docs/handoffs/tf-d6s9-factory-vision-capability-map.md:40`, `docs/findings/tf-0awo.30-factory-capstone-sim.md:54-80`, `packages/runtime/src/unified/mcp-host/toolkit.ts:180-192`, `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:519-606`) — CLASSIFICATION(gap) — DISPOSITION(gates the target) — SUGGESTED BEAD("Cap-6 action receipt: port or remove generic execute, then prove a durable publish/action terminal", P1)

**F-08 — Capability 7 progress observation is aligned, but terminal completion must not be inferred from raw TurnComplete/Terminated until tf-r06u.36 lands** — EVIDENCE(`packages/protocol/src/session-facade/schema.ts:280-329`, `docs/findings/tf-0awo.30-factory-capstone-sim.md:41-45`, `packages/runtime/src/unified/observers.ts:57-90`, `packages/runtime/src/unified/subscribers/runtime-context.ts:131-153`) — CLASSIFICATION(gap) — DISPOSITION(gates the target) — tracked-by(`tf-r06u.36`)

**F-09 — Brookhaven is aligned with the generic substrate: durable-streams append/read plus protocol session surfaces are enough, no consumer substrate bridge** — EVIDENCE(`docs/rfc/external/brookhaven-roblox-in-game-agent.md:121-147`, `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md:45-67`, `packages/protocol/src/session-facade/operations.ts:51-98`, `packages/runtime/src/unified/host.ts:328-385`) — CLASSIFICATION(aligned) — DISPOSITION(supports the target) — tracked-by(`tf-qne2`)

**F-10 — Brookhaven G1 scoped opaque-handle auth is the one missing generic edge primitive** — EVIDENCE(`docs/rfc/external/brookhaven-roblox-in-game-agent.md:141-144`, `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md:329-380`, `docs/analysis/2026-06-01-brookhaven-consumer-contract.md:193-216`, bead `tf-qne2`) — CLASSIFICATION(gap) — DISPOSITION(gates the target) — SUGGESTED BEAD("Generic scoped durable-streams opaque-handle auth proxy for poll-only external clients", P1)

**F-11 — A Firegrid HTTP gateway or Brookhaven-specific intent translator would violate the target boundary** — EVIDENCE(`docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md:255-276`, `docs/analysis/2026-06-01-brookhaven-consumer-contract.md:220-228`, bead `tf-qne2` comment 428) — CLASSIFICATION(boundary-violation) — DISPOSITION(off-path the target) — tracked-by(`tf-qne2`)

**F-12 — Brookhaven publish completion is the same Cap-6 action-receipt problem, not a separate Roblox substrate primitive** — EVIDENCE(`docs/rfc/external/brookhaven-roblox-in-game-agent.md:134-137`, `docs/analysis/2026-06-01-brookhaven-consumer-contract.md:236-259`, `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md:51-53`, `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md:395-401`) — CLASSIFICATION(duplicate) — DISPOSITION(gates the target) — SUGGESTED BEAD("Cap-6 action receipt: port or remove generic execute, then prove a durable publish/action terminal", P1)
