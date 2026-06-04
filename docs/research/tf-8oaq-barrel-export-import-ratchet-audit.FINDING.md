# tf-8oaq Gate A Barrel Export / Import Ratchet Finding

Verdict: PARTIAL GREEN. The safe host-sdk barrel leaks are removed in this PR; the remaining leaks are compatibility shims with live consumers or an existing signed-off client escape hatch.

Gate A asks that host-sdk/client-sdk public barrels stop exporting substrate internals as normal API, or list unavoidable compatibility shims with deletion targets (`docs/handoffs/sprint-to-private-beta/architecture/02-surface-hygiene-gates.md:6-27`). Gary's assessment named the host-sdk substrate exports and client-sdk durable-table exports as the concrete leak set (`docs/handoffs/sprint-to-private-beta/02-GARY_ARCHITECTURE_ASSESSMENT.md:1000-1035`), and the companion assessment made those names the Gate A acceptance inventory (`docs/handoffs/sprint-to-private-beta/02b-COMPANION_ARCHITECTURE_ASSESSMENT.md:94-104`).

## Inventory

| Export / shape | Barrel status after this PR | Classification | Evidence / rationale |
| --- | --- | --- | --- |
| `RuntimeControlRequestWorkflowEngineLive` | Not exported from host-sdk barrels | ABSENT ON CURRENT MAIN | The runtime-local implementation is not exported; it is a private const in `packages/runtime/src/control-plane/control-request-dispatcher.ts:465-467`. |
| `RuntimeControlRequestReconcilerDaemonLive` | Not exported from host-sdk barrels | ABSENT ON CURRENT MAIN | The runtime-local implementation is not exported; it is a private const in `packages/runtime/src/control-plane/control-request-dispatcher.ts:804-806`. |
| `HostRuntimeObservationSubstrateLive` | Removed from `@firegrid/host-sdk` root barrel | REMOVE | The layer remains an internal host composition primitive at `packages/host-sdk/src/host/runtime-substrate.ts:64-71`; the root barrel now exports only the MCP seam before agent-tool subpaths (`packages/host-sdk/src/index.ts:40-50`). |
| `HostRuntimeObservationStreamsLive` | Removed from host-sdk root and host barrels | REMOVE | The internal layer remains in `packages/host-sdk/src/host/runtime-substrate.ts:73-78`; neither host-sdk public barrel re-exports it after this PR (`packages/host-sdk/src/index.ts:40-50`, `packages/host-sdk/src/host/index.ts:81-118`). |
| `RuntimeAgentToolExecutionLive` | Removed from host-sdk root and host barrels | REMOVE | The internal layer remains in `packages/host-sdk/src/host/runtime-substrate.ts:96-104`; neither host-sdk public barrel re-exports it after this PR (`packages/host-sdk/src/index.ts:40-50`, `packages/host-sdk/src/host/index.ts:81-118`). |
| `RuntimeToolUseExecutorLive` | Removed from `@firegrid/host-sdk` root barrel | REMOVE | The internal layer remains in `packages/host-sdk/src/host/runtime-substrate.ts:106-112`; the root barrel no longer re-exports runtime-substrate live layers (`packages/host-sdk/src/index.ts:40-50`). |
| `RuntimeAgentOutputObservation` through host-sdk | Removed from host-sdk host barrel | REMOVE | The canonical protocol type is exported from `@firegrid/protocol/session-facade` (`packages/protocol/src/session-facade/index.ts:1-6`, `packages/protocol/src/session-facade/schema.ts:334-336`), and firelab consumers now import it there (`packages/firelab/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/observation-state.ts:1`, `packages/firelab/src/simulations/codex-acp-tool-calls/host.ts:1-4`, `packages/firelab/src/simulations/wait-pre-attach-roundtrip/host.ts:1-4`). |
| `runtimeContextMcpUrlForContext` | Removed from `@firegrid/host-sdk` root barrel | REMOVE | The root barrel keeps only the externally exercised codec resolver (`packages/host-sdk/src/index.ts:40-44`); the URL helper stays package-internal to the codec adapter. |
| `resolveEffectiveMcpServers` | Still exported from `@firegrid/host-sdk` root barrel with TODO | MIGRATE THEN REMOVE | The remaining consumer is the deterministic smoke test importing from the root barrel (`packages/firelab/test/sleep-only-substrate-smoke.test.ts:8-12`, `packages/firelab/test/sleep-only-substrate-smoke.test.ts:182-185`). The barrel marks this as a codec-adapter test seam to migrate (`packages/host-sdk/src/index.ts:40-44`). Follow-up: `tf-u1zn`. |
| `hostProjectionObserver` | Still exported from host-sdk host/root surface with TODO | MIGRATE THEN REMOVE | Gate C explicitly names methodology and sim consumers to migrate (`docs/handoffs/sprint-to-private-beta/architecture/02-surface-hygiene-gates.md:48-67`), and the methodology currently instructs new sims to import it from `@firegrid/host-sdk` (`packages/firelab/docs/methodology.md:58-65`). This PR leaves it for lane 2 / `tf-9sx9` as requested (`packages/host-sdk/src/host/index.ts:110-115`). Follow-up umbrella: `tf-u1zn`. |
| `HostProjectionObserverOptions` | Still exported with `hostProjectionObserver` | MIGRATE THEN REMOVE | The options type is part of the same host projection observer compatibility window (`packages/host-sdk/src/host/projection-observer.ts:5-18`, `packages/host-sdk/src/host/index.ts:110-115`). Follow-up umbrella: `tf-u1zn`. |
| `CallerOwnedFactStreams` | Still exported from host-sdk host/root surface with TODO | MIGRATE THEN REMOVE | Many existing sims compose this host-side runtime stream tag from `@firegrid/host-sdk`; one example imports it from the public barrel in `packages/firelab/src/simulations/inv2-waitforworkflow/wait-for-workflow.ts:28`. The runtime-owned canonical source is `@firegrid/runtime/streams`, and host-sdk marks this as a bridge export (`packages/host-sdk/src/host/index.ts:82-88`). Follow-up: `tf-u1zn`. |
| `FiregridRuntimeTables` | Still exported from client-sdk root | KEEP, NARROW SUBPATH / CYCLE 2 DECISION | The root barrel still exposes it under a TODO (`packages/client-sdk/src/index.ts:1-17`), and the implementation defines the table map in `packages/client-sdk/src/firegrid.ts:248-251`. It is documented as an advanced live-table composition surface (`packages/client-sdk/README.md:21-47`, `packages/client-sdk/README.md:230-254`) and must move behind the channel/view transport plan rather than disappearing silently. Follow-up: `tf-u1zn`. |
| `firegridRuntimeTableTags` | Still exported from client-sdk root | KEEP, NARROW SUBPATH / CYCLE 2 DECISION | The root barrel still exposes it under the same durable-table TODO (`packages/client-sdk/src/index.ts:1-17`), and the implementation defines the tag tuple in `packages/client-sdk/src/firegrid.ts:253-256`. Follow-up: `tf-u1zn`. |
| `FiregridControlPlaneTableLive` | Still exported from client-sdk root | KEEP, NARROW SUBPATH / CYCLE 2 DECISION | The root barrel still exposes it under the durable-table TODO (`packages/client-sdk/src/index.ts:1-17`), and the implementation provides the live layer at `packages/client-sdk/src/firegrid.ts:1103-1105`. Follow-up: `tf-u1zn`. |
| `runtimeControlPlaneStreamUrl` from client-sdk | Still exported from client-sdk root | KEEP, NARROW SUBPATH / CYCLE 2 DECISION | TFIND-046 signed off the narrow client export for real browser/live-table composition (`docs/sdds/SDD_CLIENT_CONTROL_PLANE_STREAM_URL_SURFACE.md:3-17`). The client implementation imports it from protocol and re-exports it (`packages/client-sdk/src/firegrid.ts:18-31`, `packages/client-sdk/src/firegrid.ts:246`). Follow-up: `tf-u1zn`. |
| `runtimeControlPlaneStreamUrl` from host-sdk | Removed from host-sdk host/root surface | REMOVE | Host-sdk internals can import the protocol helper directly; the host barrel no longer re-exports it from `@firegrid/protocol/launch` (`packages/host-sdk/src/host/index.ts:68-79`). |

## Executed Removals

Removed from host-sdk barrels:

- `HostRuntimeObservationSubstrateLive`
- `HostRuntimeObservationStreamsLive`
- `RuntimeAgentToolExecutionLive`
- `RuntimeToolUseExecutorLive`
- `RuntimeAgentOutputObservation`
- `runtimeContextMcpUrlForContext`
- host-sdk's `runtimeControlPlaneStreamUrl` re-export

The import updates needed for `RuntimeAgentOutputObservation` now use the protocol facade instead of the host SDK (`packages/firelab/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/observation-state.ts:1`, `packages/firelab/src/simulations/codex-acp-tool-calls/host.ts:1-4`, `packages/firelab/src/simulations/wait-pre-attach-roundtrip/host.ts:1-4`). The host-sdk tool lowering test also moved its live-layer import to the internal runtime-substrate module after the public host barrel stopped re-exporting that layer (`packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts:40-44`).

## Import Ratchet

No dep-cruiser ratchet was added in this PR. The REMOVED set is currently absent from `packages/host-sdk/src/index.ts` and `packages/host-sdk/src/host/index.ts`; the remaining compatibility exports are annotated with TODOs at their public barrels (`packages/host-sdk/src/index.ts:40-44`, `packages/host-sdk/src/host/index.ts:82-88`, `packages/host-sdk/src/host/index.ts:110-115`, `packages/client-sdk/src/index.ts:1-17`). Follow-up bead `tf-u1zn` owns migration/removal of the remaining compatibility surface.

## Implication

Gate A is no longer blocked by dead host-sdk live-layer exports: the safe removals are done, and every remaining public-barrel leak has either an active consumer, an explicit parallel migration owner (`hostProjectionObserver` / `tf-9sx9`), or an existing SDD-backed client compatibility decision. This gives `tf-ycxw` a concrete deletion-plan input: delete the removed set outright, migrate `tf-u1zn` compatibility shims next, and keep the client durable-table escape hatch behind the Cycle 2 channel/view synthesis decision rather than treating it as invisible API drift.
