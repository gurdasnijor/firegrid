# tf-05jj — Session/Output Observation Channel-Surface Removal Plan

Status: Slice A landed after `tf-zd8s`; Slice B landed after `tf-aago`.
Owner: lane 1
Bead: `tf-05jj`

This is the stable prep inventory for removing bespoke session/output
observation paths after the paved `SessionAgentOutputChannel` surface is the
only product-facing path.

## ACIDs

- `firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.1`
- `firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.2`
- `firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.3`
- `firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.4`
- `firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.8`
- `firegrid-schema-projection-contract.BOUNDARIES.5`

## Source Verdicts

- `docs/handoffs/one-substrate-cycle-2-synthesis.md` says Sim 1 proved
  `session.wait.forAgentOutput`, `hostProjectionObserver`,
  `RuntimeAgentOutputAfterEvents.forContext`, and raw
  `RuntimeOutputTable.events.rows()` observe the same output sequence through
  the channel-routed implementation. It explicitly names
  `hostProjectionObserver` removal after consumer migration.
- `docs/research/tf-jbtu-sim1-agent-output-collapse.FINDING.md` says
  `SessionAgentOutputChannel` is the replacement channel. Protocol owns the
  contract/tag/schema; host-sdk owns the live binding to
  `RuntimeOutputTable.events.rows()`.
- `docs/handoffs/sprint-to-private-beta/architecture/04-runtime-boundary-workstreams.md`
  Workstream C says runtime exposes normalized observation/capability tags,
  host-sdk exposes channel wrappers and host composition, and simulations use
  client waits, semantic channels, or package-local runtime observations
  instead of exported host projection observers.

## Current Inventory

### 1. `hostProjectionObserver`

Current source:

- `packages/host-sdk/src/host/projection-observer.ts:1-44`
- `packages/host-sdk/src/host/index.ts:106-111`

Current state on this branch:

- No live source consumer imports `hostProjectionObserver` or
  `HostProjectionObserverOptions`.
- The helper already depends on `SessionAgentOutputChannel` at
  `packages/host-sdk/src/host/projection-observer.ts:2` and streams
  `output.forContext(...).binding.stream` at
  `packages/host-sdk/src/host/projection-observer.ts:22-23`.
- Remaining references are docs/generated tooling plus the host-sdk barrel
  export.

Replacement:

- Delete the helper entirely. Consumers should use either the client facade
  (`session.wait.forAgentOutput` / `session.wait.forPermissionRequest`) or a
  package-local observation harness over `SessionAgentOutputChannel` if a
  regression test must observe the channel directly.

Deletion step:

1. Delete `packages/host-sdk/src/host/projection-observer.ts`.
2. Delete the `hostProjectionObserver` and `HostProjectionObserverOptions`
   export from `packages/host-sdk/src/host/index.ts`.
3. Refresh generated type-map artifacts only if the repo's normal generation
   path requires it; do not manually edit generated maps unless the gate
   requires checked-in updates.

### 2. Sim 1 bespoke observer paths

Current source:

- `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/host.ts:61-74`
  observes `RuntimeAgentOutputAfterEvents.forContext`.
- `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/host.ts:76-106`
  observes raw `RuntimeOutputTable.events.rows()`.
- `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/observation-state.ts`
  still names the legacy path labels.

Current state on this branch:

- The old `hostProjectionObserver` path has already been removed from the Sim
  1 host source, but the FINDING remains as historical evidence.
- The remaining direct runtime and raw-table paths were regression-harness
  proof paths from the spike, not product surfaces. Slice B replaces them with
  `SessionAgentOutputChannel`.

Replacement:

- Keep `session.wait.forAgentOutput` as the product-path assertion.
- If the regression still needs a second observer after `tf-aago`, use
  `SessionAgentOutputChannel` directly in the sim host with
  `SessionAgentOutputChannelLive`, not `RuntimeAgentOutputAfterEvents` or raw
  `RuntimeOutputTable.events.rows()`.
- If the sim is no longer needed as a permanent regression, delete the
  alternate direct-observer branches and reduce the sim to the client product
  assertion plus trace evidence already captured in the FINDING.

Deletion step:

1. Remove `runtimeAgentOutputAfterEventsPath`.
2. Remove `rawRuntimeOutputTableLayer` and `rawRuntimeOutputTablePath`.
3. Update `Sim1ObserverPath` labels and assertion counts if the sim remains.
4. Keep `FiregridLocalHostLive` composition; do not introduce host-sdk imports
   into client-sdk.

### 3. Client session-facade observation path

Current source:

- `packages/client-sdk/src/firegrid.ts:360-377` builds a client-side
  `SessionAgentOutputChannel` from the resolved `RuntimeOutputTable`.
- `packages/client-sdk/src/firegrid.ts:379-392` implements
  `waitForIngressChannelProjection`.
- `packages/client-sdk/src/firegrid.ts:659-703` routes
  `waitForAgentOutputObservation` through that channel.
- `packages/client-sdk/src/firegrid.ts:721-745` implements
  `wait.forPermissionRequest` as sugar over the same agent-output path.
- `packages/client-sdk/src/firegrid.ts:916-945` exposes
  `session.wait.forAgentOutput` and `session.wait.forPermissionRequest`.

Current state on this branch:

- This is already the paved channel path from Sim 1. It is not a bespoke path
  to delete before `tf-aago`.
- Lane 5's `tf-aago` plan says `session.wait.forAgentOutput` is already DONE
  through `SessionAgentOutputChannel`; `session.wait.forPermissionRequest` is
  derived from the same channel and needs no new tag.

Replacement:

- After `tf-aago` lands, rebase and preserve the single channel-backed helper
  path rather than reintroducing local stream parsing.
- If `tf-aago` moves the client helper into a protocol/channel helper, migrate
  call sites to that helper. Otherwise leave the client helper as the public
  facade's internal `wait_for(SessionAgentOutputChannel)` implementation.

Deletion step:

- Do not delete this path in `tf-05jj` unless `tf-aago` has already replaced
  it with an equivalent channel helper. The target is convergence on one
  channel-backed path, not removal of the public wait facade.

### 4. Host/runtime `RuntimeAgentOutputAfterEvents` providers

Current source:

- `packages/host-sdk/src/host/per-context-runtime-output.ts:130-180` provides
  `RuntimeAgentOutputAfterEvents` from runtime output rows.
- `packages/host-sdk/src/host/runtime-substrate.ts:48-58` installs the output
  observation substrate and `SessionAgentOutputChannelLive`.
- `packages/runtime/src/workflow-engine/workflows/runtime-context.ts:279-281`
  consumes `RuntimeAgentOutputAfterEvents` inside runtime workflow execution.
- `packages/runtime/src/streams/runtime-observation-streams.ts:67-120`
  wraps the typed runtime observation tags.

Current state on this branch:

- These are substrate/runtime observation providers, not the public
  `hostProjectionObserver` seam.
- The runtime workflow and runtime observation streams still require typed
  runtime observation tags.

Replacement:

- Keep these until a separate runtime-internal channelization bead explicitly
  replaces runtime workflow consumption. `tf-05jj` should not delete the
  runtime workflow source tag or its host provider as part of public surface
  cleanup.

Deletion step:

- None in this slice, except removing now-unused exports/imports if the public
  `hostProjectionObserver` and Sim 1 direct harness paths are deleted and no
  source consumers remain.

### 5. Host agent-tool permission wait

Current source:

- `packages/host-sdk/src/host/agent-tool-host-live.ts:187-202` captures
  `RuntimeAgentOutputAfterEvents`.
- `packages/host-sdk/src/host/agent-tool-host-live.ts:415-435` waits for
  approval permission requests over `agentOutputEvents.forContext`.
- `packages/host-sdk/src/host/agent-tool-host-live.ts:536-545` resolves the
  runtime observation service.

Current state on this branch:

- This is a host-side agent-tool binding path, not a public session-output
  observation helper.
- It may become a `SessionAgentOutputChannel` consumer later, but that would
  touch agent-tool host behavior and should be sequenced after `tf-aago` and
  any agent-tool/channel binding decision.

Replacement:

- Do not delete in the first `tf-05jj` removal slice. Record as a follow-up
  candidate if the coordinator wants all host binding-edge waits over semantic
  channels.

## tf-aago Overlap

Lane 5's plan at
`/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-aago-client-cli-projection-surfaces/docs/handoffs/tf-aago-rewire-plan.md`
says:

- `session.wait.forAgentOutput` is already routed through
  `SessionAgentOutputChannel`.
- `session.wait.forPermissionRequest` is derived from the same channel.
- `tf-aago` will rewire broader client-sdk projection surfaces after
  `tf-zd8s` finalizes channel tags.

Sequencing consequence:

- `tf-05jj` removal must run after `tf-aago` lands or after coordinator
  explicitly confirms that `tf-aago` will not touch the same
  `packages/client-sdk/src/firegrid.ts` wait helper region.
- The safe early deletion after gates is host-sdk `hostProjectionObserver`
  plus Sim 1 direct-observer harness cleanup.
- Do not delete or reshape `waitForAgentOutputObservation`,
  `waitForIngressChannelProjection`, or the session handle `wait` methods
  until rebased on `tf-aago`.

## Execution Plan After Unblock

1. Rebase onto `origin/main` after `tf-zd8s` and `tf-aago` merge.
2. Re-run:
   `rg -n "hostProjectionObserver|HostProjectionObserverOptions" . --glob '!repos/**' --glob '!node_modules/**'`
   and confirm only removable docs/generated references plus the source export
   remain.
3. Re-run:
   `rg -n "RuntimeAgentOutputAfterEvents|RuntimeOutputTable\\.events\\.rows|waitForIngressChannelProjection|waitForAgentOutputObservation" packages/client-sdk/src packages/host-sdk/src packages/tiny-firegrid/src/simulations/spike-channel-deletion`
   and compare against this inventory.
4. Delete `projection-observer.ts` and the host barrel export. Slice A landed
   this deletion after `tf-zd8s`.
5. Remove or channelize Sim 1's direct `RuntimeAgentOutputAfterEvents` and raw
   `RuntimeOutputTable.events.rows()` harness paths. Slice B replaced both
   with a single `SessionAgentOutputChannel` observer.
6. Preserve the client public session wait facade as the product path unless
   `tf-aago` has replaced its internal helper with an equivalent channel helper.
7. Run focused tests for host-sdk and the Sim 1 tiny-firegrid path, then run
   `pnpm preflight`.
8. `bash scripts/task-exit.sh tf-05jj`; do not self-merge.

## Non-Goals

- No production removals while this document is in PREP-HOLD.
- No edits to `control-request-reconciler.ts`.
- No host-sdk import into `packages/runtime/src` or `packages/client-sdk/src`.
- No deletion of runtime workflow observation tags without a separate
  runtime-internal channelization decision.
