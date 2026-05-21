# SDD Alignment Sanity Check

Date: 2026-05-20
Compared against main: `7ecaa9102`

Scope:

- `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
- `docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`

## Summary

Both SDDs remain canonical for **direction and invariants**, but neither should
be read as an exact file-by-file implementation plan anymore.

The architecture has moved faster than the prose. The right operating stance is:

- Canonical: channel/workflow boundary, fixed agent verb surface, workflow
  engine as one substrate, no durable-tools resurrection, no substrate handles
  above the channel layer.
- Historical or stale: line-count estimates, old paths, exact pseudocode, and
  references to `durable-tools` as an active component.

## Agent Body Plan Alignment

### Still Canonical

- Channels are the application/agent-facing abstraction.
- Workflows are lower-tier infrastructure.
- Agent/app code must not receive workflow handles, execution ids, stream URLs,
  durable table names, CDC handles, engine services, or wait-store handles.
- `wait_for`, `wait_for_any`, `send`, `call`, `sleep`, `schedule_me`, session
  operations, and execution operations remain the correct small verb family.
- Channel direction should remain type-enforced.
- `effect/Channel` should not become the Firegrid channel surface vocabulary.
  Firegrid channels are semantic capabilities backed by ordinary Effect
  `Stream`, `Sink`/effectful append, and `Effect` request-response shapes.
- Generic channels over durable operator streams remain the right model for
  inbound webhooks and other event sources. The canonical verified-webhook
  channel is source-neutral; provider-specific semantics are adapter/app
  projections.

### Needs Interpretation

- `spawn_all` is no longer clearly the right delegation primitive for running
  child session handles, but a replacement batch primitive is not currently
  high priority. Repeated `session_new` calls are sufficient for private beta
  unless evidence proves a batch operation is necessary.
- References to `ChannelRegistry` are historical unless they mean the
  post-#502 edge inventory / metadata adapter. Business logic should use
  per-channel Tags and Layers, not a mutable registry object.
- Any text implying `durable-tools` backs the wait surface is historical.
  `durable-tools` was deleted in PR #519.
- The `wait_for(source/query) -> WaitForWorkflow` bridge should be read as an
  already-landed substrate migration, not as the final agent-facing surface.

### Current Alignment Grade

High. The body-plan SDD is still the best document for "what the agent should
see." Its stale parts are mostly implementation progress markers.

## One-Substrate Workflow Engine Alignment

### Still Canonical

- There is one durable substrate: the workflow engine.
- `durable-tools`, wait-router, wait-store, and compatibility wait APIs should
  not come back.
- Workflow definitions belong in runtime, not host-sdk binding code.
- The Phase 1 bridge was a substrate migration, not permission to expose
  workflow handles upward.
- Stream-native virtual object framing remains useful for the per-context
  runtime workflow.
- Future engine-native primitives are additive; they are not prerequisites for
  the current private-beta path unless performance or composition-leak triggers
  fire.

### Needs Interpretation

- The SDD's implementation sketch expected a `DurableDeferred.raceAll` style
  wait body. The currently landed implementation includes a safer
  Activity-internal race bridge for some paths and runtime-owned workflow
  surfaces under `packages/runtime/src/workflow-engine/workflows/`.
- Exact paths such as proposed `packages/runtime/src/agent-tools/WaitForWorkflow.ts`
  should be ignored. The current canonical runtime workflow path is
  `packages/runtime/src/workflow-engine/workflows/`.
- Test and line-count estimates are historical.
- Runtime-context body details changed during implementation; rely on current
  code and the workflow-body single-suspension rule for authoring constraints.

### Current Alignment Grade

High for substrate direction; medium for exact mechanics. The key goal
identified by the SDD has landed: `durable-tools` is deleted and workflow
engine ownership is the durable path.

## Combined Read

The two SDDs are compatible when layered this way:

```text
Agent Body Plan:
  channel + verb surface visible to agents and app code

One Substrate:
  runtime workflow engine and durable streams implement channel operations

Host SDK / Runtime Boundary:
  package placement rule that keeps those layers separate
```

The host-sdk/runtime boundary document is now the arbiter for package placement.
The body-plan SDD is the arbiter for agent/application vocabulary. The
one-substrate SDD is the arbiter for runtime substrate direction.

## Actionable Cleanup

1. Keep the two SDDs in `docs/cannon/sdds/` as canonical.
2. Do not dispatch new work from stale path names inside them.
3. Use `docs/cannon/architecture/current-convergence-assessment-2026-05-20.md`
   for current remaining work and sequencing.
4. If time permits later, edit the original SDDs to replace progress-language
   with status annotations, but do not block implementation on that cleanup.
