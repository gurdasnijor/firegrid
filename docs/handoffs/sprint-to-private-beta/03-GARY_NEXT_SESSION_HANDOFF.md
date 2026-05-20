# Gary Next-Session Handoff

Date: 2026-05-20
Repo state used: `origin/main` at `7ecaa9102`

Update mode: this is a tactical handoff plus live watchpoint log. If Gurdas
keeps surfacing boundary questions, add the conclusion here and in
`02-GARY_ARCHITECTURE_ASSESSMENT.md` before batching to the coordinator.

## Read First

1. `docs/cannon/README.md` after PR #529 lands.
2. `docs/cannon/architecture/host-sdk-runtime-boundary.md`
3. `docs/handoffs/sprint-to-private-beta/01-COORDINATOR_HANDOFF_canonical_convergence.md`
4. `docs/handoffs/sprint-to-private-beta/02-GARY_ARCHITECTURE_ASSESSMENT.md`
5. `.dependency-cruiser.cjs`
6. `docs/cannon/rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md`

The boundary architecture is no longer in discovery mode. Treat the canonical
doc as law unless Gurdas explicitly changes the firewall.

## Current Mental Model

The target architecture is:

```text
protocol schema catalog
  -> host/client/CLI bindings
  -> runtime execution substrate
```

Channels are the app/agent semantic event/faculty surface. Workflows, durable
streams, table CDC, engine services, execution ids, and stream URLs stay below
that surface.

Important refinement: channels do **not** replace every control-plane API.
Launch/start/prompt/session control are protocol/session operations projected
through client SDK, CLI, MCP, REST, etc. They may lower into the same runtime
substrate, but they should not be taught as arbitrary agent-visible
`send(control.table, ...)` channels.

The system is now roughly **90-93% converged**. The old 65% convergence doc is
historically useful, but stale after PRs #518, #519, #522, #524, #525, #526,
#527, and #528.

## What Landed After The 65% Assessment

- `durable-tools` final deletion: #519.
- More RuntimeAgentToolExecution arms: #518.
- More schema projection: #522 and #525.
- More guardrail ratcheting: #520, #524, #526, #528.
- Deterministic factory smokes through sleep and waitFor: #516 and #527.
- Driver/run bounding for dark-factory: #521.
- Spawn/delegation proposal: #523.
- Canon docs + public README/package README projection refresh: #529.
- Projection-surface backlog captured as `tf-aago` for client SDK/CLI presets
  over protocol launch/channel contracts.

Do not accidentally reason from the pre-#519 world. `durable-tools` is gone on
`origin/main`.

## Objective Scoreboard

Use `.dependency-cruiser.cjs` `currentHostSdkSubstrateDebt` as the scoreboard.
As of `7ecaa9102`, 8 files remain:

- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
- `packages/host-sdk/src/host/control-request-reconciler.ts`
- `packages/host-sdk/src/host/internal/runtime-context-helpers.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts`
- `packages/host-sdk/src/host/runtime-input-deferred.ts`
- `packages/host-sdk/src/host/session-log-channel.ts`

Every next-wave architecture answer should reduce, explain, or preserve this
list. If a lane touches one of these files and does not shrink the carveout or
explain why it remains, ask for clarification.

## Recommended First Response Next Session

If asked "what now?", answer:

1. Dispatch a narrow carveout-reduction lane against one or two files from the
   8-file list.
2. Dispatch projection-surface cleanup from `tf-aago`: client SDK + CLI presets
   lower to protocol launch/channel contracts, not a separate config DSL.
3. Dispatch external-trigger planning for Linear verified webhook -> channel ->
   planner.
4. Keep one lane free for guardrail/rebase repair.

## Decisions I Would Stand Behind

- Keep `FiregridRuntimeHostLive` stable. Rename later, if at all.
- Do not introduce `@firegrid/host-runtime` yet. Runtime remains the lower-tier
  execution home.
- Do not reopen the old channel registry debate. `ChannelInventory` is an edge
  inventory/metadata adapter, not a mutable app registry.
- Defer `session_new_all` unless evidence proves repeated `session_new` is
  insufficient. If taken later, introduce a new operation; do not overload
  terminal `spawn_all`.
- Treat engine-native `streamWait/streamWaitAny` as performance-triggered, not
  a blocker for private beta.
- Keep verified webhook implementation in runtime; move/provide public fact
  schemas through protocol when a binding observes them.
- Treat `appendRuntimeIngress` as control-plane/session authority, not a
  channel. It should eventually sit behind a narrow runtime/control-plane
  capability or session facade.
- Treat `state-changes-channel.ts` as the good CDC-channel example: an adapter
  may touch `DurableTable.rows()`, but the agent sees only an opaque semantic
  channel.
- Treat `control-request-reconciler.ts` as live boundary debt, not dead code.
  It is the Path C bridge from protocol-owned control request rows to runtime
  control workflows. The target is to move the dispatcher/daemon mechanics below
  the runtime line while leaving host-sdk as composition.

## Watchpoints

- If anyone proposes passing workflow handles or execution ids through channels,
  push back immediately. That violates the canonical firewall.
- If host-sdk grows new common execution behavior, ask why it is not a runtime
  service.
- If runtime imports host-sdk, stop the lane. The guardrail should catch it, but
  the architectural review should catch it first.
- If durable-tools or wait-router names reappear, assume regression until proven
  otherwise.
- If a PR claims "ratchet" but `.dependency-cruiser.cjs` carveouts do not
  shrink, read the finding carefully. It may still be valuable if it proves no
  safe ratchet is available.
- If public docs or examples teach callers to import `RuntimeControlPlaneTable`,
  construct durable rows, or pass workflow-engine handles, stop and redirect to
  protocol/session/channel projections.
- If someone proposes "make launch/prompt a channel," ask what problem is being
  solved. Session control is normally a protocol projection; channels are for
  semantic event/fact observation and send/call faculties.
- If someone proposes deleting `control-request-reconciler.ts`, check whether
  the control request row -> workflow execution bridge has moved first. It is
  still composed by `FiregridRuntimeHostLive`.

## Useful Commands

```bash
git fetch origin main
git log --oneline origin/main -n 20
git show origin/main:.dependency-cruiser.cjs | sed -n '1,40p'
git grep -n "@firegrid/host-sdk" origin/main -- packages/runtime/src
git grep -n "@firegrid/runtime/durable-tools\\|wait_router\\|DurableTools" origin/main -- packages
git grep -n "RuntimeControlPlaneTable" origin/main -- packages/host-sdk/src
bash scripts/lane-sweep.sh --json
gh pr list --state open --limit 20 --json number,title,isDraft,mergeStateStatus,statusCheckRollup,url
```

## If Asked To Dispatch

Prefer dispatches with this structure:

```text
READ:
  docs/architecture/host-sdk-runtime-boundary.md
  .dependency-cruiser.cjs currentHostSdkSubstrateDebt

SCOPE:
  one or two named files only

ACCEPTANCE:
  pnpm run lint:deps
  pnpm run verify or focused package checks
  rg/grep proving the removed boundary leak
  currentHostSdkSubstrateDebt reduced or unchanged with a finding explaining why
```

Avoid broad prompts like "move host-sdk to runtime." That failure mode is already
named in the canonical doc.

## Current Private-Beta Read

Private beta is plausible after:

- deterministic factory smoke covers delegation;
- one external trigger path or a clearly accepted synthetic trigger path is
  declared beta-sufficient;
- one real side-effect adapter is either implemented or explicitly deferred from
  the first beta story;
- guardrails are green with carveouts understood.
- client/CLI/docs examples present projection-safe launch/channel usage and do
  not teach substrate handles.

The system does not need engine-native primitives before private beta unless
performance data says Firegrid overhead is approaching a meaningful fraction of
LLM/provider latency.

`session_new_all` is not required for private beta. Repeated `session_new` calls
are the default until evidence says a batch primitive is worth adding.

## Human Context

Gurdas has been pushing correctly against accidental registry/substrate leakage.
If there is a disagreement, reduce it to the canonical analogy:

```text
Do not pass DB drivers through business logic.
Do not pass workflow engines through agent/application code.
Channels are the semantic application surface.
Runtime owns the machinery below it.
Session/control APIs are protocol projections, not generic channels.
```

That framing has consistently clarified the right move.
