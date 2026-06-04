# Current Convergence Assessment

Date: 2026-05-20
Assessed main: `7ecaa9102` (`tf-ygz3 Lane D slice 7`, PR #528)

## Verdict

Firegrid is **roughly 90-93% converged** toward the architecture in
`docs/cannon/architecture/host-sdk-runtime-boundary.md`.

The older 65% assessment was accurate before PRs #518-#528. It is no longer the
right operating number.

## What Is Converged

- `durable-tools` was fully deleted in PR #519. The old wait-router substrate is
  no longer part of current architecture.
- Workflow definitions moved under runtime-owned paths across PRs #499, #503,
  and #507.
- `RuntimeAgentToolExecution` exists as a runtime-owned execution seam, with
  multiple arms moved across PRs #504 and #518.
- `ChannelRegistry` is gone; channel composition now uses Effect-native Tags
  plus edge metadata inventory from PR #502.
- Dependency guardrails are hard-error and actively ratcheted.
- Several shared schema/projection surfaces moved toward protocol ownership.
- Dark-factory deterministic smokes cover sleep and waitFor over the new
  substrate path.

## Remaining Gaps

### P0: Reduce The 8 Host-SDK Substrate Carveouts

The authoritative list is `currentHostSdkSubstrateDebt` in `.dependency-cruiser.cjs`:

- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
- `packages/host-sdk/src/host/control-request-reconciler.ts`
- `packages/host-sdk/src/host/internal/runtime-context-helpers.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts`
- `packages/host-sdk/src/host/runtime-input-deferred.ts`
- `packages/host-sdk/src/host/session-log-channel.ts`

This list is the finish-line scoreboard. Each next refactor should reduce it or
explain why it cannot yet be reduced.

### P2: Optional Batch Delegation Ergonomics

`spawn_all` is the wrong semantic fit for running child session handles, but a
new `session_new_all` primitive is **not** required for private beta. Multiple
agents can be started with repeated `session_new` calls, and that simpler path
keeps the verb surface smaller while the rest of the architecture converges.

`docs/cannon/rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md` remains useful
background, but it should not be treated as a P0 implementation directive.
Revisit a batch primitive only if a concrete workflow demonstrates that repeated
`session_new` calls are insufficient or ergonomically prohibitive.

### P0/P1: External Trigger Path

Verified webhook substrate exists in runtime and stable schemas/channels now
flow through protocol. The private-beta path is:

```text
real webhook
  -> runtime verified ingest
  -> durable verified-webhook fact
  -> generic firegrid.verifiedWebhooks channel binding
  -> planner wait_for(channel, { match })
```

Linear is the natural first demo source because it matches the factory vision,
but Linear remains route/adaptor/demo data. The canonical channel is the
generic verified-webhook fact channel.

### P1: First Real Side-Effect Adapter

Private beta needs at least one narrow world-facing adapter, likely Linear or
GitHub. Runtime should own provider execution mechanics; host/app composition
installs live Layers and channel bindings.

### P1: Schema Projection Rebaseline

The original schema-projection inventory has been partially consumed. Re-audit
before opening more projection moves.

### P2: Engine-Native Primitives

`streamWait`, `streamWaitAny`, reducers, and signal primitives remain positive
EV but not private-beta blockers unless performance data or another composition
leak triggers them.

## What Is OK To Ship With For Private Beta

- Narrow integration coverage: one external trigger path and one side-effect
  adapter is enough.
- A small number of named compatibility shims if they contain no runtime
  behavior and are blocked only by consumer migration.
- Engine-native primitives deferred if Firegrid overhead remains comfortably
  below provider/LLM network latency.
- Protocol projection backlog for surfaces not exposed to beta users.

## What Is Not OK To Ship With

- Runtime importing host-sdk.
- Client SDK importing runtime.
- Reintroduced `durable-tools`, wait-router, or durable wait-store APIs.
- New host-sdk-owned common operation execution.
- Agent-facing channel APIs exposing workflow handles, execution ids, stream
  URLs, table names, CDC handles, or engine services.

## Recommended Next Phases

### Phase 1: Close Boundary Invariants

1. Continue moving tool execution from host-sdk into `RuntimeAgentToolExecution`.
2. Reduce the 8 carveouts, updating `.dependency-cruiser.cjs` in the same PR as
   each move.
3. Keep `pnpm run lint:deps` and `pnpm run verify` green.

### Phase 2: Private-Beta Functional Loop

1. Choose Linear or another first external trigger.
2. Route verified webhook input into a semantic channel.
3. Add one real side-effect adapter.
4. Extend deterministic smoke before live LLM/provider smoke.

### Phase 3: Performance And Product Hardening

1. Run `pnpm --filter @firegrid/firelab simulate:perf`.
2. Compare Firegrid overhead to provider/LLM latency.
3. Open engine-native primitives only if the measured trigger fires.
4. Expand adapters and beta coverage.
